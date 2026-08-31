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

## Remaining

- Phase C PrivateLink (iap-lockdown L20-L23) - needs a Team-tier org, an AWS
  session, and the one manual dashboard association; the composition is proven
  in privatelink-aws (see iap-lockdown RUNLOG closeout).
- The doc-link + BYOC-verification items, deferred.
