# RUNLOG - security-lockdown

Ephemeral by default: provision -> probe -> destroy (project) + postgrest-down
(container) in one run. Nothing left standing.

## Run 1 - 2026-08-28 - the broader security surface (beyond IAP)

One Micro (org ErfiCorp), Supabase-only. S01-S03 via the Management API; S04
adds a local PostgREST container. All green, then destroyed.

- **S01 security advisors**: seeded exposed shapes, then read the Management
  API security advisor - 6 lints (2 ERROR, 3 WARN, 1 INFO). It caught every
  seeded exposure: rls_disabled_in_public, rls_enabled_no_policy,
  security_definer_view, anon_/authenticated_security_definer_function_
  executable, function_search_path_mutable. This is the platform telling you
  where you are exposed - run it first for any "are we locked down?" question.
- **S02 network restrictions APPLIED** (iap-lockdown L09 only enumerated them):
  applied a restrictive DB CIDR (TEST-NET), the API recorded it, and the REST
  HTTP tier kept answering unchanged (401 -> 401). Confirms live that network
  restrictions gate the DB/pooler socket only - an IP allowlist does NOT cover
  REST/Auth/Storage. Restored.
- **S03 auth hardening**: the levers the Management API exposes -
  password_min_length (6), password_hibp_enabled (leaked-password, off by
  default), mfa_totp_enroll/verify (on), and auth rate limits
  (token_refresh=150, verify=30, email_sent=2). PATCHing min_length, HIBP, and
  MFA-verify all took effect. So auth hardening is settable via the API;
  leaked-password protection is OFF by default and worth turning on.
- **S04 Supabase-as-database: your own PostgREST** (the honest Data API
  answer). Managed Data API off -> managed REST dark (503 PGRST002). A
  self-hosted PostgREST (official v16.2 image) connected to the SAME Supabase
  Postgres via the session pooler and served the data the managed endpoint no
  longer would (200). Its db-pre-request IP filter REJECTED a spoofed
  x-forwarded-for (403 PT403) while an allowed request served (200) - the exact
  db-pre-request x-forwarded-for filter that iap-lockdown L09 measured does NOT
  fire on hosted. It works here because we own the PostgREST config.

- **S05 rate limiting in front of your own PostgREST**: nginx limit_req (rate
  2r/s, burst 2) in front of the self-hosted PostgREST. A 15-request burst
  returned 2x200 + 13x429 - the limiter throttles without black-holing. The
  rate limiter (nginx here; a Cloudflare Worker / WAF / Upstash is
  interchangeable) only works because it fronts a CLOSED origin (managed Data
  API off), which is the whole reason the managed Data API cannot be rate-
  limited this way but your own PostgREST can. Gotchas found: the container's
  db-pre-request function must persist for the container's whole life (do not
  drop it mid-run), and nginx limit_req rejects with 503 unless
  limit_req_status 429 is set.

### The architecture, evidenced

For the operator who wants IP restrictions / rate limiting / a private REST
layer: you cannot get it from the managed Data API (proxying it is bypassable,
its endpoint always answers a key-holder, and db-pre-request does not fire).
The path that works: Supabase = managed Postgres; run your own PostgREST
against it (Data API off), behind your edge (IAP + IP allowlist + WAF + rate
limit + db-pre-request). S04 proves the PostgREST + IP-filter half end to end;
rate limiting (S05) lives in the same fronting layer
(Cloudflare Worker / WAF / nginx / Upstash) - only effective in front of the
now-closed origin.

### Teardown

make postgrest-down + make destroy: container gone, project GET 400, tofu
state empty. Nothing left standing.

## Run 2 - 2026-08-28 - gap-plugging (S06-S10)

Follow-ups on the review gaps. One Micro, run live, destroyed.

- **S06 self-hosted PostgREST connection role**: S04 connected as the postgres
  superuser, which bypasses RLS and every grant - the wrong role to run
  PostgREST as. The managed `authenticator` role is NOSUPERUSER + NOBYPASSRLS;
  a dedicated login role granted anon/authenticated (NOSUPERUSER, NOBYPASSRLS,
  member of both) is the safe connection role. The own-PostgREST guide should
  connect as an authenticator-style role, not postgres.
- **S07 Vault**: `supabase_vault` stores a secret as ciphertext in
  vault.secrets and returns it through vault.decrypted_secrets - a home for the
  service key / issuer secrets that is not a plaintext column.
- **S08 pg_net egress**: `net.http_get('https://example.com')` returned 200 -
  the database can make outbound HTTP. A SQL-capable attacker can exfiltrate or
  SSRF from inside Postgres; restrict EXECUTE on the net schema, or leave
  pg_net disabled if unused. An egress surface most lockdown plans omit.
  Correction 2026-10-22: "restrict EXECUTE on the net schema" is not
  available to the project owner. governed-starter-kit (RUNLOG, 2026-10-07)
  found the net.* grants to PUBLIC owned by supabase_admin, and a REVOKE run
  as postgres was a no-op with a warning. The pg_net docs (Permissions) put
  the boundary at login: anon and authenticated are NOLOGIN and net is not
  exposed through the Data API. The advice is now: keep LOGIN roles that
  should not make outbound HTTP off the project, or leave pg_net disabled.
- **S09 audit + backups**: pgaudit is available (statement auditing to the
  Postgres log, read via the Management API logs, not a table). GET
  /database/backups on a fresh project: pitr_enabled=false, walg_enabled=true,
  one scheduled backup - PITR is a paid add-on and off by default, so recovery
  is daily backups until enabled.
- **S10 socket lock (closes the S02 half)**: with psql on PATH, a real
  connection through the pooler succeeds at 0.0.0.0/0, then is refused the
  moment a restrictive CIDR excluding this machine is applied - Supavisor
  returns `FATAL (EADDRNOTALLOWED) address not in tenant`. So S02 (HTTP tier
  unaffected) + S10 (socket refused) together prove restrictions gate the
  database socket only, without borrowing privatelink-aws for the second half.

## Run 3 - 2026-08-28 - efficacy + the Worker rate-limiter (S11, S12)

One Micro (org ErfiCorp), destroyed after. Closes the two gaps the review left.

- **S11 auth-hardening EFFICACY** (S03 proved settable, not that it rejects):
  set `password_min_length=12` and `password_hibp_enabled=true`, then drove the
  password-UPDATE path (admin-create a user, sign in, `PUT /auth/v1/user`) so
  the verdict is not confounded by the signup email rate limit (2/hour on the
  shared SMTP). min_length rejects a 4-char password (422). A compliant long
  unique password is accepted (200). FINDING: leaked-password (HIBP) does NOT
  fire on the password-UPDATE path - a breached password ("passwordpassword")
  was accepted (200) even with HIBP on. HIBP is enforced on signup, not on a
  password change via `PUT /auth/v1/user`; settable is not enforced everywhere.
- **S12 Worker rate-limiter** (the S05 nginx variant, edge-agnostic): a Worker
  using the native Rate Limiting binding (`simple: limit=2, period=10`) run
  locally with `wrangler dev` in front of the same self-hosted PostgREST. A
  15-request burst returned 2x200 + 13x429 - the same result as nginx (S05).
  The binding throttles without black-holing, and only works fronting a closed
  origin. Note: the readiness poll spends the per-window budget, so the module
  waits one window before the burst.

## Run 4 - 2026-08-31 - review gap-plugging modules (S13-S15), run live

One Micro (org from secrets, ap-southeast-1), provisioned -> probed -> destroyed
in one session. `make apply` then `make probe IDS=S13,S14,S15` then `make
destroy`. Second pass green: 8 pass, 0 fail, 0 skip (the first pass caught two
of my own too-strict probe assertions, fixed below). S13/S14/S15 need only the
project + anon key + PAT; no self-hosted PostgREST.

- **S13 column-level grants** (the write-column trap Move 1 raises and stops
  at): confirmed the pair. Permissive UPDATE policy + table-level grant lets
  anon overwrite `balance` (`204` - the trap; the policy filtered rows, not
  columns). After `REVOKE UPDATE ON t` + `GRANT UPDATE (note)`, the same write
  returns `401` carrying SQLSTATE `42501` (permission denied for column), and
  `note` still writes (`204`). FINDING on the status code: PostgREST maps the
  42501 column denial to `401` for the unauthenticated anon role (not `403`) -
  the load-bearing signal is the 42501, and the first-pass assertion that
  demanded 403 was wrong. The column privilege, not another policy, is the fix.
- **S14 Auth switch-on levers**: all three switch-on groups present on micro.
  `hook_before_user_created_enabled=false` (present, off by default),
  `security_captcha_enabled=false` with `security_captcha_provider=hcaptcha`
  (present, off), and the seven `rate_limit_*` fields
  (anonymous_users=30, email_sent=2, sms_sent=30, otp=30, verify=30,
  token_refresh=150, web3=30). Drove `rate_limit_anonymous_users` 30 -> 5 (200,
  read back 5), restored. Hook and CAPTCHA enforcement not driven (need a live
  hook endpoint and a real provider secret) - this proves the levers exist and
  are settable, the half the doc's "what stays open" table omitted.
- **S15 Storage/Realtime reach**: with the Data API wedged off, a table path
  returns `503 PGRST002` (REST dark) while `/storage/v1/bucket` still answers
  (`200` service and anon) and `/realtime/v1/websocket` still answers (`500` to
  a bare GET - its own service error, i.e. up, not a gateway 503). Both are
  their own services and never traverse PostgREST, so a db-pre-request cannot
  gate them. Read-only fact: the storage schema is owned by **supabase_admin**
  (not supabase_storage_admin as first guessed - the doc was corrected to the
  measured value). FINDING on the probe: "REST off" reads as `503` only on a
  TABLE path; the `/rest/v1/` root answers `401 Invalid API key` at the gateway
  with no schema route, so S15a creates a throwaway table to read the wedge.

## Run 5 - 2026-09-03 - the hardening gaps (S16-S21), run live

One Micro (org from secrets, ap-southeast-1), `make apply` -> probes in four
invocations (S20 with the containers up; S17,S19,S21; S18 alone; S16 last) ->
`make destroy`. Each module's final artifact is published redacted under
`out/2026-09-03/` with its facts.md; earlier artifacts in the same `evidence/`
tree are the probe-fix iterations (a banned test address reused as the
visibility probe, a numeric GoTrue `code` hiding `error_code`, a lab role
without schema CREATE, a leftover role from a killed run) and are not cited.

- **S20 x-forwarded-for trust boundary on your own PostgREST**
  (`run-2026-09-03T03-48-10-095Z`): an RPC returning
  `request.headers->>'x-forwarded-for'` called DIRECT on the container with
  `x-forwarded-for: 198.51.100.7` returned that value (200, 1 address,
  client value present); the same call through an nginx edge that sets
  `X-Forwarded-For $remote_addr` returned one RFC 1918 address and no client
  value. The S04 filter (bans 203.0.113.9): direct spoof `403 PT403`, via the
  edge `200`. The filter is an allowlist only when PostgREST is reachable from
  nowhere but the edge - a deployment property of the container, not of the
  function.
- **S16 pre-request on hosted: NOTIFY vs restart, and the x-forwarded-for
  shape** (`run-2026-09-03T04-24-07-384Z`, run LAST). An RPC returning
  `request.headers` on the MANAGED PostgREST: with no client header
  x-forwarded-for carries 1 address; with a client-supplied
  `x-forwarded-for: 203.0.113.9` it carries 2, client value FIRST, then the
  edge's address - the hosted edge APPENDS. The address-bearing header keys
  that reach SQL are `cf-connecting-ip`, `cf-ew-via`, `cf-ipcountry`,
  `x-forwarded-for`, `x-forwarded-proto`: a header-keyed check on hosted has a
  trustworthy client address in `cf-connecting-ip` and must not read the first
  x-forwarded-for element. This closes the L09 "not lab-answerable" gap. Then
  the pre-request itself: `ALTER ROLE authenticator SET pgrst.db_pre_request`
  persisted (rolconfig), `NOTIFY pgrst, 'reload config'` produced no fire in
  61s (L09 replay); `POST /projects/{ref}/restart` -> 200, REST refused at
  once, the health endpoint reported db+rest ACTIVE_HEALTHY immediately (not
  readiness - see the provisioning note), REST answered again 302s later (303s
  total from the restart call); no fire in 182s after that, GUC still on the
  role. The role-GUC path does not activate on hosted by reload OR by restart:
  the managed PostgREST is not started with db-config on, or reads it from
  somewhere the customer cannot reach. The hosted IP filter stays a no.
- **S18 audit trail and blocking** (`run-2026-09-03T04-34-40-378Z`, run
  alone): the /v1 spec has 115 paths, 0 mention drain (Log Drains are
  Dashboard-only, no API lever) and 3 mention ban (`network-bans/retrieve`,
  `retrieve/enriched`, `DELETE network-bans`). A marked anon REST request
  (`GET /rest/v1/sec18_<nonce>` -> 404) was found in `edge_logs` 18s later by
  `metadata.request.path`, with a client-address header field populated (the
  probe accepts `cf_connecting_ip` or `x_real_ip`; the row read back by hand
  carried both);
  a marked Storage request (`/storage/v1/bucket?sec18=<nonce>` -> 200) 15s
  later by `metadata.request.url`. A failed password login (`400
  invalid_credentials`) appears in `auth_logs` as a request line with method,
  path, status, `error_code` and `remote_addr` - not the email - found 2s
  after the query started; a successful login appears as an `auth_event` line
  (`action: login`, `actor_username` = the email) 3s later. `GET
  /auth/v1/admin/audit` with the service key returned 200 with 0 entries
  throughout: the audit trail on this project is the auth_logs auth_event,
  not the admin audit endpoint. Network bans: 0 banned; 10 failed psql
  auths through the session pooler (`FATAL: password authentication failed`)
  produced 1 ban (this machine); `DELETE /network-bans` with that address ->
  200, 0 banned after, and a correct-password psql through the pooler
  succeeded afterwards. The ban is DB-socket scoped (the only ban lever in
  the spec); nothing bans an IP at the HTTP tier. The first S18 run polled
  `/analytics/endpoints/logs` (the shared helper) and got `Backend error!
  Retry your query.` on every query while `logs.all` answered the same SQL;
  it also keyed the failed-login lookup on the nonce, which that line does not
  carry. Both fixed before the cited run.
- **S17 FORCE ROW LEVEL SECURITY** (`run-2026-09-03T04-10-27-851Z`): the query
  endpoint runs as `postgres`, which on this platform has `rolbypassrls=true`
  (so do `service_role` and `supabase_admin`; `authenticator`, `anon`,
  `authenticated`, `supabase_auth_admin` do not). A postgres-owned table with
  RLS on and no policy read 2 rows before AND after FORCE - FORCE changes
  nothing for a backend connecting as postgres. A table owned by a lab role
  without BYPASSRLS read 2 before FORCE and 0 after. `service_role` via REST
  under FORCE: 200, 2 rows. `ALTER ROLE service_role NOBYPASSRLS` as the
  project owner: `42501: "service_role" is a reserved role, only superusers can
  modify it`. The shape that works: a `NOBYPASSRLS` role granted to
  `authenticator`, reached through the Data API with an HS256 JWT minted under
  the secret `GET /projects/{ref}/postgrest` returns (`role` claim): 200 with 0
  rows under no policy, 200 with 1 row once a `tenant = 'a'` policy exists.
  RLS reaches the backend by role choice, not by FORCE.
- **S19 Auth enforcement** (`run-2026-09-03T03-56-15-489Z`, S19 rows): with
  `mailer_autoconfirm` on (no email sent), HIBP at SIGNUP refused
  `passwordpassword` with `422 weak_password: Password is known to be weak and
  easy to guess, please choose a different one.` 6s after the PATCH, and
  accepted a strong one (200) - the half S11 could not drive.
  `rate_limit_anonymous_users` lowered to 3: 15 anonymous sign-ins gave
  3 x 200 then 12 x 429 (`over_request_rate_limit: Request rate limit
  reached`), the first 429 at request #4 - the limit is exact, no burst above
  the configured value in this window. CAPTCHA with Turnstile's documented
  always-fail test secret: signup and password login without a token both
  `400 captcha_failed: captcha protection: request disallowed (no
  captcha_token found)`; the dummy token under the always-fail secret 400;
  the always-pass secret plus the dummy token 200 - the gate covers login,
  not just signup, and needs no provider account to prove. A
  before-user-created hook as a Postgres function
  (`pg-functions://postgres/public/sec19_hook`) rejecting `@mailinator.com`:
  blocked domain `400 unknown: disposable email domains are not allowed`
  (the hook's own message; `error_code` is `unknown`), allowed domain 200,
  active 5s after the PATCH. GoTrue answers a generic 400 for a few seconds
  while it reloads the hook config; the probe waits for the hook's own text.
  8 users created, 8 deleted.
- **S21 the no-RLS, service_role-from-the-backend shape**
  (`run-2026-09-03T03-57-54-215Z`, S21 rows): a plain table read 200 for anon
  and for an authenticated user token (the exposure). After `REVOKE ALL ON ALL
  TABLES/SEQUENCES/FUNCTIONS IN SCHEMA public FROM anon, authenticated`,
  `REVOKE USAGE ON SCHEMA public` and the matching `ALTER DEFAULT PRIVILEGES
  FOR ROLE postgres IN SCHEMA public`: anon table `401 42501: permission
  denied for table`, authenticated `403 42501`, service_role 200 with 2 rows -
  and the anon RPC STILL 200. FINDING: functions carry EXECUTE for PUBLIC
  (`proacl {=X/postgres,...}`) and schema public keeps USAGE for PUBLIC
  (`nspacl {...,=U/pg_database_owner,...}`), so a revoke aimed at anon and
  authenticated leaves every function callable. `REVOKE EXECUTE ON ALL
  FUNCTIONS IN SCHEMA public FROM public` closed it (`401 42501: permission
  denied for function`), service_role RPC still 200. A table created
  afterwards stayed closed (default privileges), but a function created
  afterwards was callable AGAIN: the `IN SCHEMA public` default-privilege
  revoke adds to the global default and cannot remove the built-in EXECUTE
  for PUBLIC. The GLOBAL form, `ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM public` (no IN SCHEMA), closed a third new
  function (`401 42501`). Exposed schema PATCHed to `api` only: effective in
  3s; service_role on the public table `404 PGRST205: Could not find the
  table 'api.sec21_pii' in the schema cache`; `api.pii` 200 with
  `Accept-Profile: api` and also 200 with no header (the first exposed schema
  is the default). The setting is project-wide; the backend's own calls move
  with it.

### Teardown (run 5)

`make postgrest-down edge-down` after S20; `make destroy` after S16: project
GET 400, tofu state empty, no `sec-*` containers. Nothing left standing.

## Run 6 - 2026-09-14 - header-keyed checks and the packaged wrong answer (S22)

Two micros in ap-southeast-1, each provisioned -> probed -> destroyed (the
second only to add the S22d control that the first run could not support).
Verify-gone on both: the ref absent from `GET /v1/projects` and tofu state
empty; the per-ref GET answered 404 on the first and 403 on the second, so the
list check is the reliable one. The published artifact is the SECOND run,
redacted, under `out/2026-09-14/`.

Motivation: pg_headerkit (supabase-community, v1.0.0 on dbdev, last
substantive commit 2023-03-03; the 2026-05-15 commit is a dependabot chore) is
the packaged form of the IP-allowlist recipe, reachable from the dbdev launch
blog post, and its README advertises rate limiting, request logging and user
allow/denylists as UNCHECKED roadmap boxes - none of those exist in the 1.0
SQL, which is header accessors, two `inet` tables, membership checks and
user-agent sniffing. Two properties the corpus asserted but had never run: the
trust of `cf-connecting-ip` (S16 saw the key reach SQL and never tested it),
and the policy form of a header check on hosted (every prior hosted header
probe was an RPC).

- **S22a cf-connecting-ip is not client-settable at all.** With no client
  header the RPC saw it present, and equal to the sole `x-forwarded-for`
  element. The SAME call carrying `cf-connecting-ip: 203.0.113.9` returned
  **403** - the edge REFUSES the request rather than overwriting the header,
  so the forged value never reaches SQL. Stronger than the documented
  overwrite behaviour the doc cited: the request does not get through at all.
- **S22b the hdr.ip() expression admits a forged caller; cf-connecting-ip does
  not.** One allowlist holding only `203.0.113.9`, one request carrying
  `x-forwarded-for: 203.0.113.9`, two tables whose policies differ only in the
  header they read. Keyed on `cf-connecting-ip`: 200, **0 rows**. Keyed on
  `split_part(x-forwarded-for, ',', 1)` - the `hdr.ip()` body: 200, **1 row**.
  The caller chose their own address and the policy let them in. This is the
  bypass, measured, on the managed tier.
- **S22c a zero-arg IMMUTABLE function reading request.headers is evaluated at
  PLAN time.** Same body, same qual, two volatility classes. IMMUTABLE ->
  `Result / One-Time Filter: false`, no `current_setting` left in the plan and
  the scan dropped: the planner ran the header read once and baked the answer
  in. STABLE -> the GUC read survives into the plan and runs per execution
  (SQL inlining removes the function NAME from both plans, so the name is not
  the tell - the surviving `current_setting` call is). pg_headerkit marks
  `in_allow_list()`/`in_deny_list()` IMMUTABLE and both take zero arguments,
  so a policy written with them is a plan-time constant rather than a
  per-request check - independent of which header it reads. Volatility census
  of the published SQL: 3 of 24 functions are STABLE (`headers()`, `header()`,
  `ip()`), the other 21 IMMUTABLE - so `hdr.ip()` itself is correctly marked,
  and the zero-arg membership checks that call it are not.
- **S22d the security advisor does not lint extension-owned objects.** pg_tle
  is available on a micro. Installed a faithful slice of pg_headerkit as a
  REAL extension (two functions with unpinned `search_path`, one table in
  schema `hdr` with no RLS). Advisor lints 8 -> 9, and the single lint added
  was `extension_in_public`; no lint named an `hdr` object. The same-run
  CONTROL is what makes that a finding rather than an absence: this module's
  own plain-SQL objects are the same two shapes (unpinned `search_path` on
  `sec22_cfip`/`_hdrip`/`_headers`/`_imm`/`_stb`, no RLS on `sec22_allow`), and
  in the SAME advisor response they are named by
  `function_search_path_mutable`, `rls_disabled_in_public`,
  `anon_security_definer_function_executable` and
  `authenticated_security_definer_function_executable`. Same rules, same
  response, same shapes: extension membership is the only difference, so a
  customer who installs a dbdev package gets no advisor coverage of what it
  brought in. (Run 1 of this module asserted that comparison without recording
  the control; the second provision exists to measure it.)

Probe bugs fixed on the way (three runs): comparing the spoofed call's header
value against the plain call's, which reads empty when the edge answers 403 -
the assertion had to become "refused"; grepping the EXPLAIN output for the
function NAME, which SQL inlining removes from both plans; and calling the RPC
straight after `notify pgrst, 'reload schema'`, which 404'd once on a stale
schema cache and now waits.

### Teardown (run 6)

Both projects destroyed via `tofu apply tfplan-destroy` (1 destroyed each).
Verified by absence from `GET /v1/projects` plus an empty tofu state rather
than by the per-ref status code, which was 404 for the first project and 403
for the second. Nothing left standing.

## Run 7 - 2026-10-23 - background work under restrict-all (S23)

The question: network restrictions gate inbound connections to the DB socket
(S02, S10), and L22 (iap-lockdown) measured an Edge Function losing its
direct socket under restrict-all. Does work that Postgres starts itself keep
running - a pg_cron job, a database webhook (the
`supabase_functions.http_request` trigger, which queues a pg_net request) and
a bare pg_net call - and do the outbound requests leave?

Two runs, each on a fresh self-provisioned Pro-org Micro in ap-southeast-1
(PostgreSQL 17.11, pg_cron 1.6.4, pg_net 0.20.4), created, probed and deleted
by S23 in one process (`make probe-s23`, no tofu state). Restrict-all is the
lab's TEST-NET form used by S02, S10 and L22 (`192.0.2.0/24` and
`2001:db8::/32`). Database webhooks were switched on with
`POST /v1/projects/{ref}/database/webhooks/enable` (201).

Receivers, both lab-controlled, both answering with the nonce they read from
the request body, so the response pg_net stores in `net._http_response.content`
is the receipt:

- external: a Cloudflare Worker on workers.dev (`echo-worker/`, deployed for
  these runs with `make echo-worker-up`, deleted after; the Workers API
  answered 404 for the script afterwards);
- same project: an Edge Function (`verify_jwt=false`) that also writes a
  receipt row through `/rest/v1` with the service-role key.

What fires: cron `s23-tick` every 2 s inserts a timestamp row; cron `s23-fire`
every 10 s inserts an `s23_events` row (two webhook triggers on it, one per
receiver) and makes two direct `net.http_post` calls (one per receiver); the
orchestrator also inserts one `s23_events` row through the Data API
(service-role key) in each phase. Phases on the DB clock: pre (45 s, open),
enforced (120 s, restrict-all applied and the session pooler refusing this
machine), post (45 s, restored and the pooler accepting again).

Artifacts: run 1 `out/2026-10-23/run-2026-10-23T08-17-05-467Z.json`, run 2
`out/2026-10-23/run-2026-10-23T08-21-39-730Z.json` (each with its
`.facts.md`). Run 1's `cron.job_run_details` read joined on `cron.job` after
the jobs were unscheduled, so it returned no rows (probe bug, fixed before
run 2); its other figures stand.

- **S23b the restriction was live.** In both runs the first session-pooler
  connect after the apply was refused (`(EADDRNOTALLOWED) address not in
  tenant allow_list`; `refused_after_s` 0), `GET network-restrictions` read
  `status=applied` with the TEST-NET config, and after the restore the first
  connect was accepted (`reopened_after_s` 0). The enforced window held 120 s.
- **S23c pg_cron keeps running.** `s23-tick` rows per phase, run 1: pre 22
  in 45 s, enforced 60 in 120 s, post 22 in 45 s; run 2: 22, 60, 23. Longest
  gap between consecutive rows over the whole run: 2.1 s (run 1), 2.0 s
  (run 2). Run 2 `cron.job_run_details`: every run succeeded in every phase
  (`s23-tick` 22 / 60 / 23, `s23-fire` 4 / 12 / 5; `cron_runs_not_succeeded`
  0). The project reports `cron.use_background_workers=off` and
  `cron.host=localhost`, so jobs run over a libpq connection to localhost,
  which the allowlist did not gate (configuration read; the mechanism is
  inferred, not separately probed).
- **S23d database webhooks deliver.** Enforced phase, hooks to the Edge
  Function: 13 of 13 answered 200 with the nonce echoed in both runs. Hooks to
  the Worker: 13 of 13 in run 1, 12 of 13 in run 2; the thirteenth has
  `status_code` null and `error_msg` `Failed sending data to the peer`. The
  same error hit one direct pg_net call to the Worker in run 2's OPEN pre phase
  (3 of 4), so it is not a restriction effect: 2 of 45 pg_net requests to the
  Worker failed in run 2, 0 of 45 in run 1, and 0 of 90 to the Edge Function
  across both runs. The module did not look for a re-send of the failed
  request. The app path: one Data API insert per phase answered 201 (enforced
  included) and fired both hooks, 2 of 2 responses echoing that row's nonce,
  in every phase of both runs. S23d is marked fail in run 2 only because its
  pass rule required every Worker hook to echo.
- **S23e pg_net direct calls leave.** Enforced phase, `net.http_post` to the
  Edge Function 12 of 12 and to the Worker 12 of 12, 200 with the nonce
  echoed, in both runs. The Edge Function wrote 25 receipt rows through
  `/rest/v1` during the enforced phase in both runs (13 hook calls plus 12
  direct calls), each with user-agent `pg_net/0.20.4`.
- **S23g the Management API query endpoint answers under restrict-all.**
  `POST /database/query` returned 201 mid-window in both runs while the pooler
  refused this machine (a control-plane path, consistent with L23).

Reading: restrict-all changed nothing measurable for work Postgres starts
itself. Cron ran on its 2 s schedule with no gap above 2.1 s, and outbound
HTTP left the database to an external host and to the project's own Edge
Function throughout the window. The restriction is an inbound filter on the
DB socket; the pg_net egress surface S08 described stays open under it. A
webhook's receiver is reached over the public HTTP tier, so an Edge Function
receiver keeps working under restrict-all as long as it talks back over
`/rest/v1` (as this one did) rather than opening a direct DB socket, which
L22 measured failing.

Not measured: the direct 5432 (IPv6) socket as the control (pooler only);
an Edge Function receiver that connects to the DB directly; windows longer
than 120 s; regions other than ap-southeast-1; pg_net to a private
destination; the cause of the two `Failed sending data to the peer` errors
(the Worker was not tailed). n = 2 runs on one day.

### Teardown (run 7)

Both projects deleted by S23's own finally block (DELETE 200 each) and absent
from `GET /v1/projects` after 0 s (run 1) and 20 s (run 2); re-checked by
listing after both runs. The echo Worker was deleted with
`make echo-worker-down`. Nothing left standing.

## Run 8 - 2026-11-12 - per-service login roles (S24), run live

Question: a separate Postgres login per service, `create role ... login password` with grants on its own schema only. What can that login do on each connection path, and how fast does a password change apply on each? The roles guide recommends a user per service; before this the lab had only shown custom roles logging in over the poolers (rls-wire-claims C01-C03, medium-serverless MS04).

Shape: S24 (`tests/s24-service-login-roles.ts`, `make probe-s24`) self-provisions a Pro-org Micro in ap-southeast-1 (PostgreSQL 17.11) through `lib/project.ts` and deletes it in `finally`. Setup, through the Management API query route: `svc_a.orders` (2 rows) and `svc_b.payroll` (3 rows); `public.shared` (3 rows, owners `svc_app_a`, `svc_app_b`, `someone_else`) with RLS on and one SELECT policy `owner = current_user` for both roles; `public.internal_notes` with no grant to either role. `svc_app_a`: USAGE on `svc_a`, SELECT and INSERT on `svc_a.orders`, SELECT on `public.shared`. `svc_app_b`: USAGE on `svc_b`, SELECT on `svc_b.payroll`, SELECT on `public.shared`. Both `nosuperuser nocreatedb nocreaterole noinherit`. Vantage: the macOS orchestrator. Three runs, one project each.

- Run 1: `out/2026-11-12/run-2026-11-12T10-13-06-312Z.json`
- Run 2: `out/2026-11-12/run-2026-11-12T10-14-14-089Z.json`
- Run 3: `out/2026-11-12/run-2026-11-12T10-22-29-844Z.json`

### Direct and dedicated pooler rows in runs 1 and 2 are a vantage fault

In runs 1 and 2 every login on direct 5432 and the dedicated pooler 6543 failed with `ENOTFOUND` for `db.<ref>`; run 2 retried for 420.9 s (43 lookups). On this Mac `dns.lookup` (getaddrinfo) answers ENOTFOUND for the AAAA-only db host while the system resolver and `dns.resolve6` return the address, and TCP to 5432 and 6543 over IPv6 connected (checked against another project the same day; IPv6 here runs over tunnel interfaces only). Run 3 resolves AAAA itself and dials the address. Those four rows in runs 1 and 2 say nothing about the platform.

### Least privilege per path (S24b)

Run 3: all 8 role x path rows passed, on direct 5432, Supavisor session 5432, Supavisor transaction 6543 and the dedicated pooler 6543. Runs 1 and 2: the 4 Supavisor rows each passed the same way. For each role on each path:

- Login on the first attempt (`login_attempts` 1 on every row in all three runs).
- Its own table read (`svc_app_b` 3 rows; `svc_app_a` 2 rows before any insert); `svc_app_a`'s insert into `svc_a.orders` returned a new id on every path.
- `denied 42501` on: the other role's table, `public.internal_notes` (no grant), `auth.users`, `storage.objects`, `create table` in its own schema (USAGE only) and in `public`, `set role` to the project's default admin role, `create role`.
- `public.shared`: 1 of 3 rows for each role, the row its policy matches.

These were fresh roles, so MS04's refusal of a recreated role's password did not come up; recreating a role was not run.

### Password rotation (S24c)

`alter role svc_app_a password` through the Management API route at t0, then each path that had logged in was polled with the new and the old password until both settled. Seconds after t0. The poll step was 3 s in run 1 and 1 s in runs 2 and 3, and the paths are polled in turn, so a path is sampled less often than the step.

| Path | Run | New password first accepted | Old password first refused | Neither worked |
| --- | --- | --- | --- | --- |
| direct 5432 | 3 | 0.3 | 0.4 | 0 |
| Supavisor session 5432 | 1 | 4.9 | 1.2 | 3.7 |
| Supavisor session 5432 | 2 | 3.0 | 1.3 | 1.7 |
| Supavisor session 5432 | 3 | 3.4 | 1.5 | 1.9 |
| Supavisor transaction 6543 | 1 | 1.3 | 1.8 | 0 |
| Supavisor transaction 6543 | 2 | 1.4 | 1.9 | 0 |
| Supavisor transaction 6543 | 3 | 1.6 | 2.1 | 0 |
| dedicated 6543 | 3 | 2.2 | 2.3 | 0 |

The old password was refused with 28P01 on direct and both Supavisor modes, and with 08P01 on the dedicated pooler.

Reading: in all three runs the Supavisor session pooler refused the old password 1.7 to 3.7 s before it accepted the new one, so a login through it just after a rotation can fail with both passwords for a few seconds; on the transaction pooler and the dedicated pooler the new password was accepted before the old one was refused, and direct switched within one poll. Three runs, one region, one compute size; why the session pooler differs was not looked at.

### Dashboard Read-only role (S24d)

All three runs: `supabase_read_only_user` has `rolbypassrls = true`, can log in, and is a member of `pg_read_all_data` but not `pg_write_all_data`, so RLS policies do not limit what it reads. A row count as that role was not taken: `set local role supabase_read_only_user` from the Management API route answered 42501, because the route runs as the project's default admin role (S24e), which is not a member.

### Not run

Restoring a daily backup to see custom role passwords need resetting (the backups doc says they do); recreating a role; per-role connection limits; network restrictions with a custom role.

### Teardown (run 8)

Each run's project answered DELETE 200 and was gone from `GET /projects` at the first check.

## Run 9 - 2026-11-17 - open questions from S16, S21 and S22 (S25, S26, S27)

Question: S16, S21 and S22 left nine claims that no module had run: whether a caller can forge `cf-ipcountry`, whether PGRST202 hints stop naming functions after the S21 revoke, what the S21 revoke does to an Auth hook and a pg_cron job, whether Storage policies see `request.headers`, how an `alg` "none" token fares, what role an anonymous sign-in carries, how an `sb_secret_` key behaves from a browser, whether Realtime checks `Origin`, and what `postgres` can do with roles it creates. Tracked on the board.

Shape: three self-provisioned modules (`tests/s25-header-and-revoke-gaps.ts`, `tests/s26-auth-edge-gaps.ts`, `tests/s27-postgres-role-powers.ts`; `make probe-s25`, `probe-s26`, `probe-s27`), each creating one project in the Pro org in ap-southeast-1 through `lib/project.ts` (default size, expected Micro, not recorded) and deleting it in `finally`. All six projects reported PostgreSQL 17.12 and answered their first Management API query 4 or 5 s after `POST /projects`. Vantage: the macOS orchestrator. Two runs per module, one project per run.

- S25 run 1: `out/2026-11-17/run-2026-11-17T07-54-00-609Z.json`
- S25 run 2: `out/2026-11-17/run-2026-11-17T07-55-43-957Z.json`
- S26 run 1: `out/2026-11-17/run-2026-11-17T07-40-08-105Z.json`
- S26 run 2: `out/2026-11-17/run-2026-11-17T07-40-46-190Z.json`
- S27 run 1: `out/2026-11-17/run-2026-11-17T07-55-35-493Z.json`
- S27 run 2: `out/2026-11-17/run-2026-11-17T07-57-21-594Z.json`

Unless a line says otherwise, both runs of a module gave the same value.

### A forged cf-ipcountry: ZZ did not reach SQL (S25a)

An RPC returning `request.headers`, called with the legacy anon API key: with no client header, 200 and `cf-ipcountry` present (2 characters; the value is not recorded). The same call carrying `cf-ipcountry: ZZ` answered 200, and the value in `request.headers` was not `ZZ` and equalled the no-header call's value. The edge replaces this header with its own; for `cf-connecting-ip` it refuses the request instead (S22a, 403). Only `ZZ` was tried as a forged code, and whether the edge's country is right for a given client (VPNs, Tor) was not tested.

### Function-name hints survive the revoke (S25b)

Anon key, `POST /rpc/sec25_private_reprot`, one transposition away from a real function `public.sec25_private_report`:

| Stage | Typo call | Hint names the real function | Exact-name call |
| --- | --- | --- | --- |
| default grants | 404 PGRST202 | yes | 200 |
| after the S21 recipe (EXECUTE revoked from PUBLIC, anon, authenticated; default privileges changed) | 404 PGRST202 | yes | 401 `42501: permission denied for function sec25_private_report` |
| also USAGE on `public` revoked from anon and authenticated; `has_schema_privilege('anon', 'public', 'USAGE')` still true, through PUBLIC's `=U` | 404 PGRST202 | yes | 401, the same 42501 message |
| also USAGE on `public` revoked from PUBLIC; `has_schema_privilege` now false | 404 PGRST202 | yes | 401 `42501: permission denied for schema public` |

The hint text was `Perhaps you meant to call the function public.sec25_private_report` at every stage. Revoking privileges, including all USAGE on the schema, does not stop PostgREST's hint from naming a function to a caller who guesses close; with EXECUTE revoked the exact call's 42501 message names the function too, and with USAGE gone it names the schema instead. Removing the schema from the exposed schemas was not tested here.

### The blanket revoke breaks a hook created with default grants; pg_cron keeps running (S25c)

Before the revoke: a custom access token hook `public.sec25_hook` and a cron helper `public.sec25_tick`, both created with no explicit GRANT through the Management API query route. The hook was configured with `PATCH /v1/projects/{ref}/config/auth` (200), and a password sign-in carried its claim after 5 s (run 1) and 6 s (run 2). A pg_cron job on a 2 s schedule wrote 10 rows in 20 s. Read before the revoke: the hook's `proacl` `{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`, owner of `public.sec25_tick` `postgres`, `cron.job` username `postgres`.

After the S21 recipe the hook's `proacl` read `{postgres=X/postgres,service_role=X/postgres}`: PUBLIC's EXECUTE, the only one `supabase_auth_admin` held, was gone. One password sign-in right after answered `500 unexpected_failure: Error running hook URI: pg-functions://postgres/public/sec25_hook` (one attempt per run). The cron job wrote 10 rows in the next 20 s. `grant execute on function public.sec25_hook(jsonb) to supabase_auth_admin` restored the claim on the first sign-in after it (0 s on a 3 s poll).

### Storage policies see request.headers (S25d)

Private bucket, legacy anon key, `GET /storage/v1/object/authenticated/sec25/<file>`, one object per stage that had never been fetched, with one SELECT policy on `storage.objects` at a time:

| Policy (plus `bucket_id = 'sec25'`) | Download |
| --- | --- |
| `true` | 200 |
| `request.headers` is set and non-empty | 200 |
| `cf-connecting-ip` equals the address the S25a RPC saw | 200 |
| `cf-connecting-ip` equals `203.0.113.9` | 400 `NoSuchKey: Object not found` |

The Storage API sets `request.headers` for the policy, with `cf-connecting-ip` in it, so S22's PostgREST allowlist form works on `storage.objects` too. A cached private object can still be served to a caller who read it before the policy changed (residency-facts R05c, re-run 2026-11-17); each stage here read a different never-fetched object, so no stage could be answered from an earlier stage's cache.

### alg "none" is refused (S26a)

A token with header `{"alg":"none"}`, an empty signature, `role` and `aud` both `authenticated`, and this project's issuer: Data API with the legacy anon API key, 401 `PGRST301: Wrong or unsupported encoding algorithm`; with the `sb_publishable_` key, the same 401; Auth `GET /auth/v1/user`, 403 `bad_jwt: invalid JWT: unable to parse or verify signature, token signature is invalid: signing method none is invalid`.

### Anonymous sign-ins carry role authenticated (S26b)

With `external_anonymous_users_enabled` set (PATCH 200), `POST /auth/v1/signup` with an empty body answered 200 after 5 s. Its JWT: `role` `authenticated`, `is_anonymous` `true`, `aud` `authenticated`. Under `for select to authenticated using (true)` it read 3 of 3 rows. After a restrictive policy `(select (auth.jwt() ->> 'is_anonymous')::boolean) is not true` for authenticated, the anonymous user read 0 rows and a password user read 3.

### sb_secret_ keys are refused on a browser User-Agent (S26c)

| Request (Data API `GET /rest/v1/sec26_docs` unless stated) | Status |
| --- | --- |
| secret key in `apikey`, `User-Agent: curl/8.7.1` | 200 |
| secret key in `apikey`, a Safari `User-Agent` | 401 `Forbidden use of secret API key in browser` |
| the same plus `Origin: https://app.example.com` | 401, same message |
| `curl` User-Agent plus that `Origin` | 200 |
| secret key only as `Authorization: Bearer`, no `apikey`, `curl` User-Agent | 401 `No API key found in request` |
| Auth `GET /auth/v1/admin/users`, `curl` User-Agent | 200 |
| the same, Safari User-Agent | 401 `Forbidden use of secret API key in browser` |

The refusal keys on the User-Agent; an `Origin` header alone did not trigger it. Which User-Agent strings count as a browser was not mapped.

### Realtime accepts a socket upgrade and heartbeat under a foreign Origin (S26d)

`wss://<ref>.supabase.co/realtime/v1/websocket` with the legacy anon API key: with no `Origin` and with `Origin: https://attacker.example`, the socket opened and a Phoenix heartbeat was answered; the probe then closed the socket itself (recorded close code 1000). A channel join and a broadcast under a foreign Origin were not run, so an Origin check at join time is not ruled out.

### What postgres can do with roles it creates (S27)

Connected as `postgres` through the Supavisor session pooler: `rolsuper` false, `rolcreaterole`, `rolcreatedb` and `rolbypassrls` true, `createrole_self_grant` empty.

- `create role sec27_r nologin`: one `pg_auth_members` row for `postgres` with `admin_option` true, `inherit_option` false, `set_option` false, grantor `supabase_admin`. `set role sec27_r` answered `42501 permission denied to set role`. `grant sec27_r to postgres with set true, inherit true` succeeded and `set role` then worked. `revoke admin option for sec27_r from postgres` returned ok; afterwards `postgres` had two rows for `sec27_r`: its self-grant (grantor `postgres`, admin false, set true) and the original (grantor `supabase_admin`, admin true, set false). The plain revoke removed the admin option from the self-grant only. `drop role` succeeded.
- `create role ... login`, `createdb`, `createrole`, `bypassrls` and `replication` each succeeded. `grant pg_read_all_data` and `grant pg_signal_backend` succeeded; `grant pg_write_all_data` answered `42501 "pg_write_all_data" role memberships are reserved, only superusers can grant them`.
- A login with BYPASSRLS and `pg_read_all_data`, over Supavisor session 5432, read 2 of 2 rows from a table with RLS enabled and forced and no policy; its INSERT answered `42501 permission denied for table`. After `alter role ... password`, in both runs the new password first connected at 0.1 s and the first failed connect with the old one came at 0.6 s, error `28P01` (1 s poll plus connect time, session pooler only).
- `create database sec27_db` and `drop database` succeeded.
- pg_cron: `cron.alter_job(job, username := 'sec27_job')` answered `XX000 must be superuser to alter username`, and `cron.schedule_in_database(..., 'sec27_job')` answered `XX000 must be superuser to create a job for another role`. The job `postgres` scheduled (`sec27`, `0 0 1 1 *`, never ran during the test) is recorded in `cron.job` with username `postgres`.
- Of the four role names queried, all four exist on a fresh project: `supabase_etl_admin` (login, replication, bypassrls), `supabase_read_only_user` (login, bypassrls), `supabase_replication_admin` (login, replication), `supabase_privileged_role` (no login).

### Not run (run 9)

The PGRST202 hint with the function's schema removed from the exposed schemas; forged `cf-ipcountry` codes other than `ZZ`; Realtime channel joins under a foreign Origin; mapping which User-Agents count as a browser; roles created on PostgreSQL 15 and carried through an upgrade to 17; restoring a backup with custom roles.

### Teardown (run 9)

All six projects answered DELETE 200 and were gone from `GET /projects` at the first check.

## Run 10 - 2026-11-18 - Auth lifecycle and postgres against the auth schema (S28, S29)

Question: Auth behaviours with no run behind them: TOTP code reuse, a role change through the access-token hook, what a deleted or banned user's held tokens still do, deleting a user who owns a Storage object, soft delete, what `postgres` can do to the `auth` schema, and whether a Data API upsert needs an UPDATE policy.

Shape: two self-provisioned modules (`tests/s28-auth-lifecycle.ts`, `tests/s29-auth-schema-and-upsert.ts`; `make probe-s28`, `probe-s29`), each creating one project in the Pro org in ap-southeast-1 (default size, not recorded) through `lib/project.ts` and deleting it in `finally`. PostgreSQL 17.12. Two runs per module. S29's run 2 was repeated alone: S29's first attempt at run 2 started in the same millisecond as S28's run 2, both wrote the same artifact name, and S28's run 2 artifact is the one that survived.

- S28 run 1: `out/2026-11-18/run-2026-11-18T01-15-14-011Z.json`
- S28 run 2: `out/2026-11-18/run-2026-11-18T01-15-44-778Z.json`
- S29 run 1: `out/2026-11-18/run-2026-11-18T01-15-13-835Z.json`
- S29 run 2: `out/2026-11-18/run-2026-11-18T01-16-48-160Z.json`

Both runs of each module gave the same values.

### TOTP codes can be reused inside their step (S28a)

`POST /auth/v1/factors` (TOTP) answered 200; the enrol URI read `algorithm=SHA1`, `digits=6`, `period=30`, and the returned `totp.secret` decoded to 160 bits. A code computed locally from that secret (RFC 6238, SHA-1) verified the first challenge (200, session `aal2`), so the local implementation matches the server's. A second challenge verified with the same code, in the same 30 s step, also answered 200. Whether a code from the previous or next step is accepted was not tested.

### The access-token hook's claim changes at refresh, not before (S28b)

A custom access token hook set `user_role` from a table; a policy admitted `auth.jwt() ->> 'user_role' = 'editor'`. The editor's token read 3 of 3 rows. After the table set the user to `viewer`, the same token still read 3 rows (its claim still `editor`); a refresh (200) returned a token with `viewer`, which read 0 rows. Access tokens carried `exp - iat` = 3600 s, so, if the Data API refuses an expired token (not tested here), a role change reaches the Data API at the user's next refresh, at most the token's remaining lifetime later.

### Deleted and banned users' held access tokens still read the Data API (S28c, S28d)

Policy `to authenticated using (true)`, legacy anon API key plus the user's token:

| After | Data API with the held access token | `GET /auth/v1/user` with it | Refresh token | New password sign-in |
| --- | --- | --- | --- | --- |
| admin `DELETE /auth/v1/admin/users/{id}` (200) | 200, 3 rows | 403 `user_not_found` | 400 `refresh_token_not_found` | not tried |
| admin `PUT` `ban_duration` `1h` (200) | 200, 3 rows | 403 `user_banned` | 400 `user_banned` | 400 `user_banned` |

Auth refused the user at the first check after the DELETE or ban (a fixed 2 s wait); the Data API kept serving the held token, consistent with PostgREST checking the token's signature and expiry rather than the user row (not separated here). If the Data API refuses an expired token (not tested here), the held token's remaining lifetime is the exposure (`exp - iat` 3600 s).

### Deleting a user who owns a Storage object (S28e)

A user uploaded an object to a private bucket (200; `owner` and `owner_id` set). Admin DELETE of that user answered 200, and the object row still had both `owner` and `owner_id` non-null: the row stays; whether those values still equal the deleted user's id, and whether the file can still be read, were not checked.

### Soft delete (S28f)

`DELETE /auth/v1/admin/users/{id}` with `should_soft_delete: true` answered 200. The row stayed in `auth.users` with `deleted_at` set, `email` changed (neither the original nor null) and the password cleared. A sign-in with the old password answered 400 `invalid_credentials`, and admin-creating a user with the same email answered 200.

### postgres against the auth schema (S29a)

`auth.users` and `auth.uid()` are owned by `supabase_auth_admin`. As `postgres` over the Supavisor session pooler: `create or replace function auth.uid()` 42501 `permission denied for schema auth`; `vacuum auth.users` returned without an error (the module records errors only; PostgreSQL skips, with a warning, a table the caller may not vacuum, and no notice or `last_vacuum` was read, so whether the table was vacuumed is not established); `alter table auth.users set (autovacuum_vacuum_scale_factor = 0.01)` 42501 `must be owner of table users`; `create index ... on auth.users` 42501, same message; `delete` of 3 of 6 test users in one statement ok, 3 deleted.

### A Data API upsert needs an UPDATE policy (S29b)

A signed-in user, `POST` with `Prefer: resolution=merge-duplicates`, on a table with RLS (granted select, insert, update to `authenticated`), an INSERT policy (`with check owner = auth.uid()`) and a SELECT policy (`using owner = auth.uid()`). First insert 201. An upsert of the same id answered 403 `42501: new row violates row-level security policy (USING expression)`, and the stored value stayed `first`. After adding an UPDATE policy (`using` and `with check owner = auth.uid()`) an upsert of the same id with value `third` answered 200 and stored `third`.

### Not run (run 10)

TOTP codes from adjacent steps; whether a soft-deleted email is ever held back (here admin create with the same email answered 200 at once); Storage access to the deleted owner's objects; the Data API's answer once a held token expires; the SAML AuthnRequest signature algorithm.

### Teardown (run 10)

The four projects behind the cited artifacts answered DELETE 200 and were gone from `GET /projects` at the first check. The project from S29's overwritten first attempt at run 2 has no artifact; a listing of the account's projects after all runs (2026-11-18) showed no lab project left.

## Run 11 - 2026-11-18 - a restore role made by postgres, and RLS in pg_dump (S30)

Question: whether a restore flow for a custom role model works end to end: a LOGIN CREATEDB role made by `postgres`, an application role handed to it WITH ADMIN OPTION, the restore role creating a database and loading a dump with `pg_restore --no-owner`. Separately, whether `pg_dump` keeps a table's RLS state.

Shape: `tests/s30-restore-role-flow.ts` (`make probe-s30`), a fresh project in the Pro org per run (ap-southeast-1, default size not recorded, PostgreSQL 17.12), deleted in `finally`. Every connection goes through the Supavisor session pooler; dump and restore are the local `pg_dump` 18.7 (version recorded) and `pg_restore` from the same install (version not recorded), with the password in `PGPASSWORD`. Source: schema `s30src`, table `notes` (9 rows, RLS enabled and forced, one SELECT policy `owner = current_user` on the text column `owner`) and one SQL function. Four runs in two module versions; the S30a-c values below are the same in all four where both versions record them.

- Run 1: `out/2026-11-18/run-2026-11-18T04-01-37-647Z.json`
- Run 2: `out/2026-11-18/run-2026-11-18T04-01-51-023Z.json`
- Run 3: `out/2026-11-18/run-2026-11-18T04-35-08-053Z.json`
- Run 4: `out/2026-11-18/run-2026-11-18T04-35-20-644Z.json`

Runs 1-2 recorded only whether the dump held each statement, and read the rows the table owner sees under FORCE without the restored row count. Runs 3-4 add the statement form (`enable_form`, `force_form`) and, after the owner turns FORCE off, the restored row count (`rows_restored`). Two runs before run 1 (04:00 UTC, not published, not evidence here) failed S30a on a regex in the module that required `ALTER TABLE s30src.notes FORCE ...`.

- S30a: the plain dump (`--no-owner --no-privileges`, as `postgres`) carries `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, the `CREATE POLICY` and the function; the custom-format dump exited 0. Runs 3-4: ENABLE is written `ALTER TABLE s30src.notes ENABLE ...` and FORCE `ALTER TABLE ONLY s30src.notes FORCE ...`, which matches pg_dump's source (`pg_dump.c` on REL_18_STABLE, https://github.com/postgres/postgres/blob/REL_18_STABLE/src/bin/pg_dump/pg_dump.c).
- S30b: as `postgres`, `create role s30_restorer login createdb` and `grant s30_app to s30_restorer with admin option` succeeded. As `s30_restorer` over the session pooler, `create database s30_restored` succeeded and `pg_restore --no-owner --no-privileges` of the custom-format dump into it exited 0 with no stderr. The restored table: `relrowsecurity` true, `relforcerowsecurity` true, table owner `s30_restorer`, 1 policy, and 0 rows visible to `s30_restorer` under FORCE (no row's `owner` column is `s30_restorer`). Runs 3-4: after `alter table s30src.notes no force row level security`, `s30_restorer` counted 9 rows, the source's 9.
- S30c: as `s30_restorer`, `grant s30_app to s30_reader` succeeded (1 membership row) and the revoke succeeded; `grant pg_read_all_data to s30_reader` (`s30_restorer` holds no ADMIN on `pg_read_all_data`) answered `42501 permission denied to grant role "pg_read_all_data"`.

Not run: the dump of a full application schema, objects owned by other roles, extensions in the dump, a restore into a project instead of a second database.

## Remaining

- Phase C PrivateLink (iap-lockdown L20-L23) - needs a Team-tier org, an AWS
  session, and the one manual dashboard association; the composition is proven
  in privatelink-aws (see iap-lockdown RUNLOG closeout).
- The doc-link + BYOC-verification items, deferred.
- Log Drains delivery to an OTLP destination (Dashboard-only, Team plan) and
  the HTTP-endpoint variant of the before-user-created hook - S18/S19 measured
  the Postgres-function hook and the logs endpoints only.
- A ban provoked over direct 5432 (IPv6) rather than the pooler.
