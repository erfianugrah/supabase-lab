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

## W09 - auth store replication (fresh logins after cutover)

File: `tests/w09-auth-replication.ts`. where: "local".
requires: ["pat", "anon-key", "peer"]. destructive: true (replication
objects + auth users on BOTH projects; restore everything in finally).

Background: W05 proved public-schema table replication and TPA token
portability, but fresh logins on the standby hit the standby's OWN auth
store. Manual drilling (2026-08-15) established the mechanics this module
must encode:

- A publication on auth.users + auth.identities creates fine, and a
  subscription connects - but the INITIAL TABLE SYNC stalls permanently
  in pg_subscription_rel state 'd' on a micro standby: the table-sync
  workers never spawn because max_worker_processes=6 is exhausted by
  platform background workers (autovacuum launcher, pg_cron launcher,
  pg_net worker, logical replication launcher, apply worker). ALTER
  SYSTEM is permission-denied on managed. The apply worker also HOLDS
  streaming changes for tables not yet in 'r' state, so a stalled sync
  blocks everything.
- The recovery sequence for a wedged subscription (publisher slot lost):
  `alter subscription <s> disable;` then `alter subscription <s> set
  (slot_name = none);` then `drop subscription <s>;` - in that order,
  each single-statement.
- The workable pattern on a micro: CREATE SUBSCRIPTION ... WITH
  (copy_data = false, streaming = on) - no sync workers needed - plus a
  MANUAL BACKFILL of existing rows via the API, plus streaming for new
  writes.

Steps (single-statement SQL - W05 lesson):
1. Primary: `create publication w09_auth_pub for table auth.users,
   auth.identities` (drop if exists first).
2. Standby: `create subscription w09_auth_sub connection
   'host=db.<PRIMARY_REF>.supabase.co port=5432 dbname=postgres
   user=postgres password=<pw> sslmode=require connect_timeout=15'
   publication w09_auth_pub with (copy_data = false, streaming = on)`.
   Record verbatim success/error.
3. Backfill: read existing auth.users emails via the primary query
   endpoint; confirm the standby lacks them (pre-backfill count
   recorded).
4. Admin-create a NEW user on the primary (W03 pattern). Poll the
   standby's auth.users (query endpoint) until the row appears via
   STREAMING; record lag ms. If it never appears in 120s, record
   verbatim evidence (pg_subscription, pg_subscription_rel,
   pg_stat_subscription snapshots) - that is the finding.
5. Fresh password grant ON THE STANDBY for the streamed user
   (apikey=standby_anon). Record status + body verbatim. Success here =
   no forced re-login for users created after the replication start.
6. Manual backfill demonstration: copy one pre-existing user's row from
   primary to standby via the admin API (GET user on primary admin API,
   POST /auth/v1/admin/users on the standby with the standby's secret
   key - fetch standby keys via ctx.pat; include the user's id and
   password hash is NOT portable via admin API - record THAT as the
   backfill limitation verbatim).
7. Finally: disable + slot_name=none + drop the subscription (recovery
   sequence), drop the publication, drop the primary slot, delete
   created users on both projects.
Pass criteria: all outcomes recorded verbatim; the module passes with
ANY measured behavior as long as steps 2-6 each produced recorded
evidence. The behavior IS the finding.

## W10 - storage object fallback (the 404 gap and the sync path)

File: `tests/w10-storage-fallback.ts`. where: "local".
requires: ["pat", "anon-key", "peer"]. destructive: true (buckets/objects
on both projects; clean up in finally).

Steps:
1. IDEMPOTENT SETUP (crashed prior runs leave the bucket behind - a 409
   BucketAlreadyExists returns as HTTP 400 and must not fail the run):
   first empty + delete bucket `w10-drill` if it exists (POST
   /storage/v1/bucket/w10-drill/empty then DELETE
   /storage/v1/bucket/w10-drill, both with the primary service key,
   ignoring 404s), recording the sweep. THEN create it fresh (POST
   /storage/v1/bucket, body {"id":"w10-drill","name":"w10-drill",
   "public":true}) and upload a small object (POST
   /storage/v1/object/w10-drill/probe.txt, text body).
2. Standby: fetch the same path (GET
   https://<standby>.supabase.co/storage/v1/object/public/w10-drill/probe.txt).
   Expect the gap signal: the storage API answers a MISSING BUCKET with
   HTTP 400 carrying {"statusCode":"404","code":"NoSuchBucket"} in the body
   (measured - the real 404 lives in the body, not the status line).
   Accept HTTP 400 or 404; match on the body code. Record verbatim.
3. Sync path: download the object from the primary public URL, upload it
   to the standby (create the bucket on the standby first with the
   standby's secret key - fetch standby keys via ctx.pat like W09 step 5).
   Measure sync duration.
4. Re-fetch on the standby: expect 200 with identical bytes.
5. Finally: delete objects and buckets on both projects.
Pass criteria: gap recorded (404 before sync), 200 + byte-equal after
sync, durations in measurements.

## W11 - schema parity diff (what table-data replication misses)

File: `tests/w11-schema-parity.ts`. where: "local".
requires: ["pat", "peer"]. destructive: true (schema objects on both
projects; clean up in finally).

Steps:
1. Primary only: table `w11_t(id serial primary key, val text)` with RLS
   ENABLED + one policy (`create policy w11_p on public.w11_t for select
   to authenticated using (true)`), one function
   (`create or replace function public.w11_f() returns int language sql
   as 'select 1'`), one trigger function + trigger, one view
   (`create or replace view public.w11_v as select * from public.w11_t`).
2. Diff probe (both projects via query endpoint): row counts from
   pg_policies, pg_proc (namespace public, names like 'w11%'), pg_trigger,
   pg_views where names match 'w11%'. Record primary vs standby counts -
   expect primary > 0, standby = 0 (the parity gap, measured).
3. Remediation: apply the SAME DDL to the standby (this is what
   `pg_dump --schema-only` operationalizes), re-run the diff, expect
   parity. Record both diff snapshots in evidence.
4. Finally: drop the objects on both projects.
Pass criteria: gap measured, parity after remediation measured.

## W12 - realtime probe (connect, subscribe, event latency, reconnect)

File: `tests/w12-realtime-probe.ts`. where: "local".
requires: ["pat", "anon-key"]. destructive: true (alters the
supabase_realtime publication for the canary table; restores in finally).

Steps:
1. STABLE canary table (measured 2026-08-15: dropping and recreating a
   table under realtime wedges event delivery for that table NAME - the
   recreated table has a new OID while realtime's channel metadata
   references the dead one; a fresh name delivers in ~0.5s). Create
   public.probe_canary(id serial primary key, payload text) IF ABSENT
   and NEVER drop it - cleanup deletes ROWS only. Add it to
   supabase_realtime if not already a member, and leave it a member
   (record prior membership state for evidence only).
2. Bun WebSocket to
   `wss://<ref>.supabase.co/realtime/v1/websocket?apikey=<publishable>&vsn=1.0.0`.
   Send phoenix join: topic `realtime:public:probe_canary`, event
   `phx_join`, payload `{config:{postgres_changes:[{event:"INSERT",
   schema:"public",table:"probe_canary"}]}}`, ref "1". Handle phx_reply.
3. Insert a row via REST; measure ms until the postgres_changes event
   arrives on the socket. Record.
4. Close the socket, reconnect, rejoin, insert again, measure again.
5b. VERIFIED-WORKING skeleton (measured 2026-08-15: open at ~388ms,
   phx_reply ok at ~396ms on the drill project) - use this shape:
   const url = new URL(`wss://${ctx.apiHost}/realtime/v1/websocket`);
   url.searchParams.set("apikey", ctx.anonKey);
   url.searchParams.set("vsn", "1.0.0");
   const ws = new WebSocket(url);
   // on open, send:
   {topic:"realtime:public:probe_canary", event:"phx_join",
    payload:{config:{postgres_changes:[{event:"INSERT",schema:"public",
    table:"probe_canary"}]}}, ref:"1"}
   // expect phx_reply with payload.status === "ok" before inserting.
5b. VERIFIED-WORKING skeleton (measured 2026-08-15: open at ~388ms,
   phx_reply ok at ~396ms on the drill project) - use this shape:
   const url = new URL(`wss://${ctx.apiHost}/realtime/v1/websocket`);
   url.searchParams.set("apikey", ctx.anonKey);
   url.searchParams.set("vsn", "1.0.0");
   const ws = new WebSocket(url);
   // on open, send:
   {topic:"realtime:public:probe_canary", event:"phx_join",
    payload:{config:{postgres_changes:[{event:"INSERT",schema:"public",
    table:"probe_canary"}]}}, ref:"1"}
   // expect phx_reply with payload.status === "ok" before inserting.
5. Finally: delete inserted ROWS only - never drop the table or alter
   the publication.
Pass criteria: connect + join + event received with latency recorded;
reconnect + second event recorded. Any measured behavior passes; record
verbatim errors if the socket fails.

## W13 - edge function wall-clock limit

File: `tests/w13-function-timeout.ts`. where: "local".
requires: ["pat", "anon-key"]. destructive: true (deploys + deletes a
function).

Steps:
1. Deploy via Management API: POST /v1/projects/{ref}/functions with body
   {"slug":"w13-sleeper","name":"w13-sleeper","verify_jwt":false,
   "body":"Deno.serve(async (req)=>{const t=Date.now();const
   ms=Number(new URL(req.url).searchParams.get('ms')||'0');await new
   Promise(r=>setTimeout(r,ms));return new
   Response(JSON.stringify({elapsed:Date.now()-t}))})"} (confirm the
   exact deploy payload shape from the API response; record verbatim
   errors and adapt).
2. Invoke with ms=5000 (expect 200, elapsed ~5000), then ms=120000,
   then ms=400000. Record where it stops returning (status/body
   verbatim). The wall-clock limit IS the finding.
3. Finally: DELETE /v1/projects/{ref}/functions/w13-sleeper.
Pass criteria: each invocation outcome recorded verbatim; module passes
with any measured limit.

## W15 - DDL lands on the primary while a subscription is live

File: `tests/w15-ddl-during-replication.ts`. where: "local".
requires: ["pat", "anon-key", "peer"]. destructive: true.

Steps (single-statement SQL for CREATE SUBSCRIPTION; disable ->
slot_name=none -> drop + drop publisher slot for cleanup):
1. Establish replication of public.w_repl in THIS EXACT ORDER (there is
   NO initial sync phase with copy_data=false - do not wait for seed rows
   to appear; they never will):
   a. primary: create table public.w_repl(id serial primary key, val
      text) (drop if exists); create publication w15_pub for table
      public.w_repl (drop if exists first).
   b. standby: same table DDL (drop if exists first).
   c. standby: create subscription w15_sub connection
      'host=db.<PRIMARY_REF>.supabase.co port=5432 dbname=postgres
      user=postgres password=<pw> sslmode=require connect_timeout=15'
      publication w15_pub with (copy_data = false, streaming = on)
      (single-statement).
   d. CANARY: insert a row on the PRIMARY; poll the standby (using the
      standby's OWN publishable key, ctx.endpoints["standby_anon"]) until
      the row appears (budget 60s). Record lag ms. This is the only sync
      check - rows written BEFORE the subscription do not replicate.
2. On the PRIMARY only: `alter table public.w_repl add column w15_extra
   text`. Then insert a row that sets w15_extra.
3. Observe the standby for 60s: does the row arrive? Record
   pg_stat_subscription + pg_subscription_rel snapshots and any verbatim
   error state. Prediction (do not assert): apply errors on the missing
   column and replication stalls - including for rows that do NOT use the
   new column. Test that too: insert a second row with w15_extra NULL.
4. Recovery: apply the same ALTER on the standby, then measure whether
   replication resumes and both rows arrive (record resume lag).
5. Finally: full cleanup (subscription, publication, publisher slot,
   table both sides).
Pass criteria: every outcome recorded verbatim (stall evidence, NULL-row
behavior, resume behavior). Any measured behavior passes.

## W16 - sequence resync at cutover

File: `tests/w16-sequence-resync.ts`. where: "local".
requires: ["pat", "peer"]. destructive: true.

Steps:
1. Replicate public.w16_t(id serial primary key, val text) W05-style
   (copy_data=false, streaming=on).
2. Insert 5 rows on the primary; confirm they stream to the standby.
3. Simulate cutover: insert a row DIRECTLY on the standby. Record the
   verbatim error (expected: duplicate key - the standby's sequence is
   behind because sequences do not replicate).
4. Resync on the standby: `select setval(pg_get_serial_sequence(
   'public.w16_t','id'), coalesce((select max(id) from public.w16_t),0)
   + 1, false)`. Insert again; expect success. Record both attempts.
5. Finally: cleanup as W15.
Pass criteria: duplicate-key error recorded verbatim, resync success
recorded. Any measured behavior passes.

## W17 - auth config parity inventory

File: `tests/w17-config-parity.ts`. where: "local".
requires: ["pat", "peer"]. destructive: true (sets + restores config on
the primary).

Steps:
1. GET /config/auth on primary and standby; record baseline diff.
2. On the primary PATCH distinguishable values: jwt_exp=42222,
   uri_allow_list="https://w17.example.com/cb", rate_limit_otp=77.
   Wait for readback.
3. GET /config/auth on both again; produce the verbatim diff inventory:
   which fields differ (the parity gap a cutover must re-apply).
4. Restore the primary's original values; confirm readback.
Pass criteria: baseline + post-change diffs recorded verbatim; restore
confirmed. Any measured diff passes.

## W18 - edge function cold start

File: `tests/w18-function-coldstart.ts`. where: "local".
requires: ["pat", "anon-key"]. destructive: true (deploys + deletes a
function).

Steps:
1. Deploy `w18-sleeper` (verify_jwt false) via the Management API
   (W13's deploy payload shape works - reuse
   tests/w13-function-timeout.ts's deploy call): a function that sleeps
   `?ms=` (default 0) and returns {elapsed}.
2. Cold: after deploy, wait 60s of no invocations, then invoke 5 times
   with 60s gaps (ms=0). Record each elapsed and the client-observed
   duration (response time) - the first call after idle carries the
   cold start.
3. Warm: invoke 20 times back-to-back (ms=0). Record durations.
4. Report cold p50/p99 vs warm p50/p99 in measurements.
5. Finally: delete the function.
Pass criteria: cold and warm distributions recorded. Any measured
behavior passes.

## W19 - imgproxy render-path failure modes

File: `tests/w19-render-failures.ts`. where: "local".
requires: ["pat", "anon-key"]. destructive: true (bucket + objects;
cleanup in finally).

Steps:
1. Idempotent bucket `w19-drill` public (W10 sweep pattern). Upload:
   a. a valid small PNG (generate 64x64 in code - no external deps),
   b. `corrupt.png` (text bytes with a .png name),
   c. an SVG file (vector - render path handles differently or errors).
2. For each object: GET /storage/v1/render/image/public/w19-drill/<name>
   ?width=32 AND the plain public URL. Record status + body code
   verbatim per case.
3. Record: does the valid PNG transform (200, resized), does the
   corrupt file error (what code), does the original always serve even
   when the transform fails.
Pass criteria: all six outcomes recorded verbatim. Any measured
behavior passes.

## W20 - statement timeout and lock-wait signature

File: `tests/w20-statement-timeout.ts`. where: "local".
requires: ["pat"]. destructive: false (creates+drops one table).

Steps:
1. SQL: `create table if not exists public.w20_t(id int primary key)`.
2. Timeout signature: `set local statement_timeout = '2s'; select
   pg_sleep(5);` via the query endpoint - record the verbatim error
   (expected 57014 query_canceled) and the measured wall time.
3. Lock-wait: this needs two concurrent DB sessions, which the query
   endpoint does not give - use psql via the pooler session host
   (aws-0-ap-southeast-2.pooler.supabase.com:5432, user
   postgres.<ref>, PGPASSWORD=ctx.dbPassword): session A holds
   `select pg_advisory_lock(42)`; session B
   `select pg_advisory_lock(42)` with `lock_timeout = '3s'` - record
   the verbatim 55P03 lock_not_available error and wall time.
4. Finally: drop the table.
Pass criteria: both verbatim errors + wall times recorded. Any measured
behavior passes.

## W22 - initial sync at real table size

File: `tests/w22-bulk-sync.ts`. where: "local".
requires: ["pat", "peer"]. destructive: true.

Steps:
1. Primary: table public.w22_t(id serial primary key, payload text);
   seed 1,000,000 rows server-side:
   `insert into public.w22_t(payload) select md5(random()::text) from
   generate_series(1,1000000)` (single statement; expect 10-30s - poll
   the row count until 1000000, budget 120s).
2. Publication w22_pub; standby same table; subscription with DEFAULT
   copy_data=true (initial sync IS the measurement). Record when the
   standby row count reaches 1000000 (poll every 10s, budget 30 min);
   if the sync stalls in 'd' past 10 min, record the stall verbatim
   (that is a finding: the micro/small worker ceiling at scale).
3. After sync: insert one canary on the primary, record streaming lag.
4. Finally: cleanup (subscription, publication, publisher slot, table
   both sides).
Pass criteria: sync duration + lag recorded verbatim; a recorded stall
is a pass-with-finding. Measurements: sync_ms (or -1 + state), lag_ms,
rows.

## W23 - pg_cron across a restart

File: `tests/w23-cron-restart.ts`. where: "local".
requires: ["pat", "pgbench"]. destructive: true (restarts the project;
cron job created+removed).

Steps:
1. SQL: `create table if not exists public.w23_hb(ts timestamptz
   default now())`; schedule `select cron.schedule('w23-hb','* * * * *',
   $$insert into public.w23_hb default values$$)` (create extension
   pg_cron first if needed - record verbatim if it fails).
2. Wait for 2 heartbeat rows (~2 min 10s, poll every 15s).
3. Restart the project: POST /projects/{ref}/restart via mgmt. Record
   restart start; poll the REST API (probe table) until 200 - record
   the outage seconds.
4. Keep polling w23_hb rows for 4 minutes post-restart. Record: rows
   before, outage window, rows after, and whether the schedule SKIPPED
   beats during the outage (no catch-up) or doubled after.
Pass criteria: heartbeat gaps + outage window recorded verbatim. Any
measured behavior passes.

## W24 - edge failover proxy with flap damping

File: `tests/w24-failover-proxy.ts` + worker changes (the drill worker
gains a failover mode). where: "local". requires: ["anon-key", "peer"].
destructive: true (redeploys the worker several times; restores after).

Background: the drill worker currently cache-proxies to UPSTREAM. Add a
FAILOVER mode (env var FAILOVER_PRIMARY / FAILOVER_STANDBY): GETs to
/rest/v1/* health-check the primary on failure (5xx or throw) by
re-fetching from the standby; tag responses x-drill-origin: primary|
standby. Flap damping: after a failover, hold on standby for a
HOLD_MS window even if the primary recovers.

Steps:
1. Update worker/worker.ts with the failover mode (small, surgical -
   keep the cache path untouched).
2. Deploy with FAILOVER vars set (both project URLs). Prime: GET the
   probe table -> 200 x-drill-origin: primary.
3. Outage on primary: point... simulate by deploying with
   FAILOVER_PRIMARY set to an unroutable URL (redeploy ~10s). GET ->
   expect 200 x-drill-origin: standby.
4. Restore primary URL while... measure holdover: immediately after
   restore the worker should still serve standby until HOLD_MS passes;
   then a later GET returns to primary. Record the timings.
5. Restore default deploy (no outage vars).
Pass criteria: primary/standby/holdover/return sequence recorded with
timings. Any measured behavior passes.
