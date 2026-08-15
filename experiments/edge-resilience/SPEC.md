# edge-resilience - SPEC (authoritative contract for the modules under tests/)

What a client can do about Supabase platform incidents that are not theirs to
fix. Every claim a module makes must be MEASURED on the live drill project
(see AGENTS.md: a `fail` is data; a test that cannot run is a `skip` with a
reason; never stub).

Shared rules for every module in this experiment:
- Import types from `../../../harness/src/types`, management API via
  `../../../harness/src/mgmt` (`mgmt(ctx, method, path, body?)`).
- The probe table is `public.w_probe(id int)` with one row `id=1`. Read it via
  `GET https://<ctx.apiHost>/rest/v1/w_probe?select=id` with headers
  `apikey: <ctx.anonKey>` and `Authorization: Bearer <token>`.
  NOTE: ctx.anonKey carries the project's *publishable* key
  (`sb_publishable_...`) in this experiment - it is accepted as the `apikey`
  header and is NOT a JWT. Bearer tokens are what W01 varies.
- Record raw evidence: HTTP status + parsed `code` (e.g. PGRST303) per
  request. Never collapse an error to only the HTTP status - the pgrest code
  IS the finding (see AGENTS.md key-rotation note on pgrst_code).
- Measurements become report columns: put offset/attempt/status values in
  `measurements`, not only in prose.
- 30s timeouts on fetches (`AbortSignal.timeout(30_000)`).

## W01 - JWT issued-at skew map (the PGRST303 incident class)

File: `tests/w01-jwt-skew.ts`. Helper: `lib/jwt.ts`. destructive: true
(writes/deletes third-party-auth config; same precedent as X01).
where: "local". requires: ["pat", "anon-key"].

Background: PostgREST honors `iat`/`exp` with a documented 30s clock-skew
tolerance (postgrest.org v11 auth reference). A platform incident in Aug 2026
rejected freshly refreshed JWTs with `401 PGRST303 "JWT issued at future"`.
This module maps the ACTUAL tolerance instead of quoting the doc.

Steps:
1. Read the edge URL from `ctx.endpoints["edge_url"]` and the private JWK
   path from `ctx.endpoints["jwks_priv"]`. If either is absent: skip with
   reason.
2. Register a third-party-auth integration on the project:
   `POST /projects/{ref}/config/auth/third-party-auth` with body
   `{ "jwks_url": "<edge_url>/jwks.json" }` (follow the listTpa/
   awaitResolution pattern in experiments/cross-project-auth/tests/
   x01-tpa-shapes.ts; resolution = resolved_jwks non-null, poll 5s, budget
   120s). If it never resolves: status fail with the resolution row as
   evidence (never-resolving config is a real finding, per X01 custom_jwks).
3. `lib/jwt.ts` exports `mintEs256(privJwkPath: string, claims: object)`:
   ES256 (ECDSA P-256 + SHA-256) compact JWS, header
   `{alg:"ES256",typ:"JWT",kid:<jwk.kid>}`, using node:crypto `createSign`
   with `dsaEncoding: "ieee-p1363"` (JOSE needs raw R||S, not DER).
   base64url WITHOUT padding.
4. Probe matrix. For each iat offset in seconds
   `[-3600, 0, 15, 30, 31, 60, 300, 3600]`, mint
   `{role:"authenticated", aud:"authenticated", sub:"00000000-0000-0000-0000-000000000001",
     iat: now+offset, exp: now+offset+3600}` and GET the probe table.
   Controls: expired (`iat=now-7200, exp=now-3600`), and a token signed with a
   freshly generated WRONG keypair (same header shape, unknown kid) expecting
   401 PGRST301.
5. Attribution control: DELETE the integration, re-probe with the offset-0
   token, expect it to stop working (401). Then the run's passes cannot be
   explained by "the project accepts anything".
6. Restoration is mandatory: the integration must be deleted even when a
   probe throws (finally).

Pass criteria (all): offset 0 -> 200; offset 3600 -> 401 with code
"PGRST303"; expired control -> 401; wrong-key control -> 401 PGRST301;
attribution control -> 401 after deletion. The exact boundary is a
MEASUREMENT (record the largest offset that returned 200 and the smallest
that returned 401), not a pass/fail criterion - if the measured boundary
differs from the documented 30s that is a finding to report in `detail`,
not a failure.

## W02 - supabase-js retry behaviour under JWT rejection vs 5xx

File: `tests/w02-retry-probe.ts`. where: "local". requires: [].
NOT destructive. No project access - runs against a local mock.

Background: supabase-js (v2.102.0 and later, per
/docs/supabase/guides/api/automatic-retries-in-supabase-js.md) retries
PostgREST calls on 408/409/503/504 and network failures by default, but a JWT
claims rejection (401 PGRST303) is a terminal client error. The incident-class
question: does the default client retry the incident class (amplifying load)
and does it ride out a transient 503?

Steps:
1. `Bun.serve` on 127.0.0.1 port 0, route `/rest/v1/t` counting requests.
2. Case A: always respond `401 {"code":"PGRST303"}`. Call
   `createClient(url, "anon").from("t").select("*")`. Record attempt count.
   Expect exactly 1.
3. Case B: respond `503 {"code":"PGRST002"}` to the first 3 requests, then
   200 with `[]`. Record attempts and elapsed ms. Expect success after >1
   attempt.
4. Case C: point the client at a CLOSED port (network refusal). Record
   attempts + elapsed (do not assert; document).
5. Record the supabase-js version (from harness/package.json) in
   measurements.

Pass criteria: case A attempts == 1 AND case B final success with attempts
> 1. Version pinned in measurements.

## W03 - jwt_exp lever: accepted AND effective

File: `tests/w03-jwt-exp.ts`. where: "local". requires: ["pat", "anon-key"].
NOT destructive, but MUTATES config: must restore the original value in a
finally (see AGENTS.md: a module that changes state restores inside the run).

Background: raising JWT access-token TTL shrinks the cohort forced through
token refresh during an issuer/validator skew window. The lever is
`PATCH /v1/projects/{ref}/config/auth {jwt_exp: N}`. The lab's own lesson
(vault-root-key V03): check EFFECT, not status code.

Steps:
1. GET config/auth, record current `jwt_exp`.
2. PATCH to 43200. Poll GET until it reads 43200 (budget 30s, 2s interval);
   if it never does: fail ("config write not readable back").
3. Effect check - RATE-LIMIT-PROOF path (learned the hard way: hosted
   signup sends email and the default sender is rate limited; scripted
   signups die with over_email_send_rate_limit. Do NOT use /auth/v1/signup):
   a. Create a user WITHOUT email send: `POST <apiHost>/auth/v1/admin/users`
      with header `apikey: <ctx.serviceKey>`, `Authorization: Bearer
      <ctx.serviceKey>`, body `{"email":"<rand>@example.com","password":"<rand>",
      "email_confirm":true}`.
   b. Get a user token: `POST <apiHost>/auth/v1/token?grant_type=password`
      with header `apikey: <ctx.anonKey>`, body `{"email":...,"password":...}`.
   c. Decode the returned `access_token` payload (no verification needed):
      record `exp - iat`. Retry the create+token pair up to 60s (fresh random
      email each attempt, 5s interval) until `exp - iat == 43200`. If
      reached: pass. If the budget expires: fail with detail "issuer still
      minting <N>s tokens 60s after config accepted 43200" (a real
      acceptance/effect gap worth reporting).
   d. Clean up the user: `DELETE /auth/v1/admin/users/<id>` with the service
      key, best-effort.
   ctx.serviceKey is the project's `sb_secret_...` key, supplied via
   SUPABASE_SERVICE_ROLE_KEY (threaded through ctx like anonKey). If absent:
   skip with reason.
4. Finally: PATCH jwt_exp back to the value from step 1 and confirm.

Pass criteria: all as above; measurements carry initial/readback/effective
values and the effect delay in ms.

## W04 - edge cache serves stale through an origin outage

File: `tests/w04-edge-cache-stale.ts`. where: "local".
requires: ["anon-key"]. destructive: true (redeploys the drill worker twice).

Background: the edge worker (worker/worker.ts) caches GETs of the probe
table and serves the last good response with `x-drill-cache: stale` when the
origin errors or is unreachable. `make worker-outage` repoints origin
fetches at an unroutable address. This module proves a read path survives a
full origin outage with zero client change.

Steps:
1. `edge = ctx.endpoints["edge_url"]`; skip with reason if absent.
2. Prime: GET `<edge>/rest/v1/w_probe?select=id` (headers apikey +
   Authorization: Bearer ctx.anonKey) until a response carries
   `x-drill-cache: hit` (up to 5 attempts, 1s apart; record attempts).
3. Capture the HIT body.
4. Trigger outage: run `wrangler deploy --config <wrangler.jsonc path
   resolved relative to this module file> --var "OUTAGE:true"` via Bun `$`.
   Timeout 120s.
5. Warm read under outage: GET the same URL again. The worker checks its
   cache BEFORE the origin, so a warm URL serves `hit` (or `stale`) while the
   origin is unreachable - expect 200 with a body byte-identical to step 3
   and `x-drill-cache` of `hit` or `stale`. This is the resilience finding:
   a warm edge cache makes an origin outage invisible to reads.
6. The boundary: GET the same path with a unique query (e.g.
   `?select=id&cb=<random>`) - an UNcached URL during the outage must come
   back `503` with `x-drill-cache: empty`. Records that only warm reads
   survive; cold reads fail.
7. Restore: `wrangler deploy --config <same> --var "OUTAGE:false"`, then GET:
   expect 200 with `x-drill-cache: miss` or `hit`.
8. Always restore OUTAGE:false in a finally, even on throw.

Pass criteria: warm read under outage is 200 with byte-identical body; cold
URL under outage is 503/empty; worker restored afterwards. Measurements:
prime attempts, deploy durations, warm status+tag, cold status+tag,
body-equal boolean.

## W05 - standby replication + token portability (the HA gate)

File: `tests/w05-standby-replication.ts`. where: "local".
requires: ["pat", "anon-key", "peer"]. destructive: true (replication
objects + auth config on BOTH projects; restore everything in finally).

The standby project ref is `ctx.peers["standby"]`; its publishable key is
`ctx.endpoints["standby_anon"]`. Both projects share the lab db_password
(ctx.dbPassword). Run ALL SQL through the Management query endpoint:
`POST /v1/projects/{ref}/database/query` body `{"query":"..."}` (via the
harness mgmt helper with ctx.pat).

Background: this module measures whether a managed->managed warm standby is
even possible, and what cutover costs. Known constraints to VERIFY, not
assume: the pooler cannot stream WAL (sbshift runbook), so the subscription
CONNECTION must use the primary's DIRECT host (db.<ref>.supabase.co), which
is IPv6-only by default - whether a managed project's walreceiver can reach
it is THE open question.

Steps:
1. Seed primary: `create table if not exists public.w_repl(id serial
   primary key, val text, updated_at timestamptz default now())` + 3 rows;
   `create publication w05_pub for table public.w_repl` (drop if exists
   first for idempotency).
2. Same table DDL on standby (apply-both-sides discipline; record it).
3. Connectivity gate A (direct): on standby,
   `create subscription w05_sub connection 'host=db.<PRIMARY_REF>.supabase.co
   port=5432 dbname=postgres user=postgres password=<pw> sslmode=require
   connect_timeout=15' publication w05_pub`. Record success or the VERBATIM
   error. If it fails, that is a finding, not a bug - continue to gate B.
4. Connectivity gate B (pooler, expected to fail): retry with
   `host=aws-0-ap-southeast-2.pooler.supabase.com port=5432` (session mode).
   Record the verbatim error - evidence that the pooler cannot stream WAL.
5. If gate A succeeded: poll standby until the 3 seed rows appear (initial
   sync, budget 120s); then insert a canary row on primary and measure
   replication lag (ms until visible on standby). Record both.
6. Token portability: register the PRIMARY's OIDC issuer as TPA on the
   standby: `POST /projects/<standby>/config/auth/third-party-auth` body
   `{"oidc_issuer_url": "https://<PRIMARY_REF>.supabase.co/auth/v1"}`;
   await resolution (X01 pattern). On the primary, admin-create a user and
   password-grant a token (W03 pattern). Call the STANDBY's
   `/rest/v1/w_probe?select=id` with apikey=standby_anon and the
   primary-issued bearer token. Expect 200 - sessions survive cutover
   without copying secrets (X02 mechanism re-validated in the DR context).
7. Finally (always): drop subscription on standby, drop publication on
   primary, delete the TPA integration, delete the admin user.

Pass criteria: every gate outcome recorded with verbatim evidence; IF gate
A succeeded then initial sync + lag + portability(200) must all hold. If
gate A failed, the module still passes ONLY IF gates A and B both produced
recorded verbatim errors (a clean negative finding) - and detail must say
"managed->managed replication blocked: <reason>".
Measurements: gateA_ok, gateA_error, gateB_error, initial_sync_ms,
replication_lag_ms, portability_status.

## W06 - cold DR timing (pg_dump + restore)

File: `tests/w06-cold-dr-timing.ts`. where: "local".
requires: ["pat"]. destructive: true (creates/drops tables on the drill
project). NOT a standby test - measures the dump/restore RTO floor.

Steps:
1. Seed: table `w_dr` with 10k rows (~1MB payload) via the query endpoint.
2. pg_dump the table through the pooler session host
   (aws-0-ap-southeast-2.pooler.supabase.com, port 5432, user
   postgres.<ref>, dbname postgres, password ctx.dbPassword; PGPASSWORD env
   on the child process). Record dump duration + file size.
3. Drop the table. Time the restore (psql -f through the pooler).
4. Verify row count == 10000. Record dump_ms, restore_ms, rows, bytes.
5. Finally: drop w_dr, remove the dump file (keep under /tmp, gitignored).

Pass criteria: restore completes with exact row count; measurements
recorded. pg_dump/psql binaries are on PATH.

## W07 - break-glass edge token minting (escape hatch validation)

File: `tests/w07-breakglass-mint.ts`. where: "local".
requires: ["pat", "anon-key"]. destructive: false.

Background: `GET /v1/projects/{ref}/postgrest` returns the project's
jwt_secret (http-tier-lockdown run 2 finding). Whoever holds it can mint
valid HS256 user tokens WITHOUT GoTrue - an escape hatch during an Auth
outage, and a crown-jewel exposure. Validate the hatch exists, then the
reference documents the security posture.

Steps:
1. GET /projects/{ref}/postgrest via mgmt; record whether jwt_secret is
   present in the body (do NOT put the secret itself in evidence -
   redact to first 6 chars + length).
2. Mint HS256 locally (openssl or node:crypto HMAC-SHA256, base64url no
   padding) with claims {role:"authenticated", aud:"authenticated",
   sub:<uuid>, iat:now, exp:now+3600}. Header {alg:"HS256",typ:"JWT"}.
3. GET /rest/v1/w_probe?select=id with apikey=ctx.anonKey + bearer=minted.
   Expect 200 => escape hatch CONFIRMED (Auth-independent token minting
   works against the live project).
4. Wrong-secret control: same with a random secret => expect 401.
Pass criteria: real secret 200, wrong secret 401, secret redacted in all
recorded evidence.

## W08 - refresh-token rotation race (multi-tab failure mode)

File: `tests/w08-refresh-race.ts`. where: "local".
requires: ["pat", "anon-key"]. destructive: false (creates+deletes one
auth user).

Steps:
1. Admin-create a user (W03 pattern), password-grant to get
   access_token + refresh_token.
2. Fire TWO concurrent refreshes of the SAME refresh_token
   (`POST /auth/v1/token?grant_type=refresh_token` x2 simultaneously).
   Record both outcomes verbatim (status + error codes).
3. Document: does the second fail (rotation enforced), do both succeed
   (no rotation), or does the whole family get revoked (reuse detection)?
4. Cleanup: delete the user.
Pass criteria: both outcomes recorded verbatim; the module passes with ANY
behavior as long as it is measured - the behavior IS the finding.
