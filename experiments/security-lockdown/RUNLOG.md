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

## Run 5 - 2026-09-03 - the pen-test-customer gaps (S16-S21), run live

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

## Remaining

- Phase C PrivateLink (iap-lockdown L20-L23) - needs a Team-tier org, an AWS
  session, and the one manual dashboard association; the composition is proven
  in privatelink-aws (see iap-lockdown RUNLOG closeout).
- The doc-link + BYOC-verification items, deferred.
- Log Drains delivery to an OTLP destination (Dashboard-only, Team plan) and
  the HTTP-endpoint variant of the before-user-created hook - S18/S19 measured
  the Postgres-function hook and the logs endpoints only.
- pg_cron jobs and database webhooks under restrict-all (L22 measured one
  Edge Function).
- A ban provoked over direct 5432 (IPv6) rather than the pooler.
