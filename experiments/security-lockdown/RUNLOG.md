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
  db-pre-request x-forwarded-for filter, which iap-lockdown L09 measured does NOT fire on
  hosted. It works here because we own the PostgREST config.

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

For the customer who wants IP restrictions / rate limiting / a private REST
layer: you cannot get it from the managed Data API (proxying it is bypassable,
its endpoint always answers a key-holder, and db-pre-request does not fire).
The path that works: Supabase = managed Postgres; run your own PostgREST
against it (Data API off), behind your edge (IAP + IP allowlist + WAF + rate
limit + db-pre-request). S04 proves the PostgREST + IP-filter half end to end;
rate limiting (S05) is the easy part and lives in the same fronting layer
(Cloudflare Worker / WAF / nginx / Upstash) - only effective in front of the
now-closed origin.

### Teardown

make postgrest-down + make destroy: container gone, project GET 400, tofu
state empty. Nothing left standing.

## Remaining

- Chrome/manual tests still pending from iap-lockdown (Access OIDC login).
- Phase C PrivateLink (iap-lockdown L20-L23) - needs the Team-tier org.
- S05's Cloudflare-Worker variant (vs the nginx demonstrator) - the pattern is
  identical; reuses the iap-lockdown worker + wrangler codification.
