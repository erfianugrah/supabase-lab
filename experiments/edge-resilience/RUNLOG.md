# edge-resilience - RUNLOG

What a client can do about Supabase platform incidents that are not theirs to
fix. Four modules, all green against the live drill project
(ap-southeast-2, micro, tofu-managed) on 2026-08-15. Consolidated artifact:
`evidence/final/run-2026-08-15T07-41-58-013Z.{json,md}` (4 pass, 0 fail).

## W01 - JWT issued-at skew map (the PGRST303 incident class)

Setup: lab-controlled ES256 issuer (keypair in `jwks/`, public half served by
the edge worker at `/jwks.json`) registered via third-party-auth `jwks_url`.
Tokens minted with arbitrary `iat` offsets probe the real claim-validation
path - first-party secrets are not readable, TPA is the mintable path.

Measured (two full runs, final artifact values):

| iat offset | result |
| --- | --- |
| -3600s | 200 |
| 0 | 200 |
| +15s | 200 |
| +30s | 200 |
| +31s | 401 PGRST303 (run 1: 200; boundary sits at 30-31s) |
| +60s / +300s / +3600s | 401 PGRST303 |

- The documented 30-second skew tolerance (PostgREST v11 docs) is REAL:
  final run boundary max_200=30s, min_401=31s. First run measured 31/60 -
  sub-second mint-to-validate timing explains the 1s wobble.
- Expired token => 401 PGRST303 (same code, `exp` side).
- Wrong/unknown key => 401 PGRST301. After TPA deletion => 401 PGRST301.
- **JWKS trust lags the Management API by ~30s**: integration shows
  `resolved_jwks` set while PostgREST still answers PGRST301 (kid unknown).
  After deletion, tokens keep validating for seconds until config is
  re-read. Config APIs are not request-path truth - always poll the request
  path (warm-up loop / eviction loop in the module).
- Collateral (2026-08-14, pre-lab): `PATCH /config/auth {jwt_secret:...}`
  returns 200 and changes nothing. New projects bootstrap with ES256
  `in_use` + HS256 `previously_used` signing keys.

## W02 - supabase-js retry behaviour (v2.112.3)

- Case A (401 PGRST303): exactly **1 attempt**, 9ms elapsed. The default
  client does NOT retry claim rejections - it does not amplify the incident
  class.
- Case B (503 PGRST002 x3 then 200): **4 attempts, success in ~7.0s** -
  transient 5xx is ridden out with backoff.
- Case C (connection refused): "Unable to connect" surfaced after ~7.0s.
- Docs cross-ref (guides/api/automatic-retries-in-supabase-js.md): built-in
  retries for 408/409/503/504 + network failures, default on since 2.102.0.

## W03 - jwt_exp lever (exposure-window reduction)

- `PATCH /config/auth {jwt_exp: 43200}` readable-back immediately.
- Effect lag: first token after acceptance still minted at 3600s; second
  attempt (~6.5s later) minted 43200s. Config acceptance != instant effect.
- Restored to 3600 in finally.
- Probe-path lesson: hosted `/auth/v1/signup` sends email and the default
  sender is rate limited - scripted signups die with
  `over_email_send_rate_limit`. The rate-limit-proof path is
  `POST /auth/v1/admin/users` (service key, `email_confirm: true`) +
  `POST /auth/v1/token?grant_type=password`.

## W04 - edge cache through an origin outage

Worker (`worker/worker.ts`, wrangler-as-code) caches GETs of the probe table
and serves the cache before touching the origin.

- Prime: 1 attempt to HIT. Outage toggle (redeploy with `OUTAGE:true`,
  ~10.5s) repoints origin fetches at 192.0.2.1 (TEST-NET-1).
- **Warm read under outage: 200 HIT, body byte-identical to pre-outage.**
  A warm edge cache makes an origin outage invisible to reads.
- Cold URL under outage: 403/PASS - Cloudflare wraps the TCP failure to a
  TEST-NET address as a 403 response rather than a JS exception, so the
  worker's catch->503/EMPTY path never fires; the error passes through.
  Finding stands: cold reads fail during an outage.
- Restore (OUTAGE:false, ~10.6s): 200 HIT again.
- **Cache gotcha (found while building)**: the Supabase gateway's Cloudflare
  front sets `Set-Cookie: __cf_bm` on EVERY response. `caches.default.put`
  refuses Set-Cookie responses and `waitUntil` swallows the rejection - a
  naive cache proxy silently never caches. Strip `set-cookie` before `put`.

## Process notes (loop-driven build)

- Modules were built by the sensor-gated loop (`.pi/harness-w*.json`,
  operator probe `.pi/probe-edge-resilience.sh` outside writeScope).
- The local rung (Gemma 4 26B via llama-server/loop) failed to produce a
  compilable W01 in 5 iterations across two runs (pseudocode placeholders,
  syntax garbage, tree thrash: literal-\n filenames, junk symlinks, build
  artifacts at repo root) and produced one W02 that passed plus one that
  leaked `Bun.serve` handles (probe hang). claude-sonnet-4.6 converged W01
  in 3 iterations, W02/W03 in 1, W04 in 1. For this harness, keep the local
  rung for single-file mechanical modules only.
- Operator edits and the loop fence do not mix: commit harness/spec changes
  BEFORE launching a run, or the writeScope fence reverts them as
  out-of-scope agent edits.

## Reproduce

```
make secrets-decrypt      # repo root, once
cd experiments/edge-resilience
make up                   # init + apply + keygen + worker-deploy + seed
make battery              # all 23 modules (W01-W13, W15-W24)
make down                 # when done
```

The acceptance gate is `.pi/probe-edge-resilience.sh W01[,W02...]` from
the repo root - it runs `make up`-equivalent checks and exits nonzero
unless every named module passes. `make probe ONLY=W04,W24
RUNNER_FLAGS=--destructive` (target: probe-destructive) covers the two
worker-mutating modules on their own.

## W05 - standby replication + token portability (2026-08-15, green)

The HA question: is a managed->managed warm standby possible, and what does
cutover cost? Standby: lab-edge-resilience-standby (ap-southeast-1; primary
ap-southeast-2), both tofu-managed.

- **Managed->managed logical replication WORKS**: subscription on the
  standby against the primary's DIRECT host (db.<ref>.supabase.co). A
  managed project's walreceiver reaches it fine - the IPv6 worry did not
  materialize.
- **The pooler gate fails at the tenant layer** (verbatim): `could not
  connect to the publisher ... FATAL: (ENOIDENTIFIER) no tenant identifier
  provided (external_id or sni_hostname required)` - consistent with the
  sbshift runbook's "pooler cannot stream WAL".
- **Initial sync ~3.1-6.5s** (3 rows + table sync machinery, two runs).
- **Replication lag 34ms-1057ms** across regions (three runs; sub-second
  typical).
- **Sessions survive cutover via TPA-OIDC**: register the primary's issuer
  (`https://<primary>.supabase.co/auth/v1`) as third-party-auth on the
  standby (resolves in ~60-120ms); a primary-issued user token then reads
  the standby's API with 200. No secret copying needed - and copying would
  be impossible anyway (jwt_secret PATCH is a no-op).
- **JWKS trust lag applies to cutover**: a first-time issuer's kid takes
  the cold ~30s PostgREST trust path (PGRST301 until warm, seen in the full
  suite); a previously-seen JWKS warms instantly (302ms). Rehearse cutover
  BEFORE you need it - the first real one otherwise eats the cold path.
- Module mechanics (hard-won): CREATE SUBSCRIPTION must be its own
  single-statement query (the query endpoint wraps multi-statement strings
  in a transaction, and Postgres rejects CREATE SUBSCRIPTION there);
  standby REST reads need the standby's own publishable key; dropping a
  subscription leaves its slot on the primary pinning WAL (dropped in
  cleanup).

## W06 - cold DR timing (2026-08-15, green, local-rung build)

10k rows (~681KB): pg_dump 12.4s, restore 6.4s through the pooler session
host, exact row count verified. The cold-DR floor for small datasets.

## W07 - break-glass edge minting (2026-08-15, green, local-rung build)

Escape hatch CONFIRMED: `GET /v1/projects/{ref}/postgrest` returns the
project's `jwt_secret`; an HS256 user token minted locally with it reads
the live API (200) with zero GoTrue involvement; wrong secret => 401.
During an Auth outage, valid tokens can be minted without Auth - but the
secret is the crown jewels: holding it at the edge trades outage
resilience for a much worse compromise blast radius. Document, don't
deploy casually.

## W08 - refresh-token rotation race (2026-08-15, green, local-rung build)

Two CONCURRENT refreshes of the same refresh token: both returned 200.
Simultaneous reuse does not hard-fail (rotation tolerates it within the
reuse window) - the multi-tab "intermittent 401" mode is NOT reproduced by
naive concurrency alone.

## Loop-build notes (W05-W08)

- The local rung one-shotted W06, W07, W08 (small, mechanical, tightly
  specced) - its confirmed weight class. W05 (two projects, replication,
  auth) exceeded it: 6 iterations across two runs with systematic "int"
  token corruption and a thin-pass that gamed the probe while missing the
  SPEC's evidence bar; the final module was hand-corrected against
  manually validated ground truth.
- Probe discipline lesson: a probe that checks only `status == "pass"`
  will accept a thin pass. The SPEC's evidence requirements (verbatim
  errors, specific measurements) are part of the contract - check them in
  the probe when they matter.

## W09 - auth store replication (2026-08-15, green, frontier build)

The answer is nuanced and measured:
- Publication on auth.users + auth.identities: creates fine.
- Subscription WITH copy_data=false + streaming=on: creates fine, rel
  states go 'r' immediately (no sync workers needed).
- BUT the apply worker never stabilized on the micro standby (pid null in
  pg_stat_subscription): a newly created user did NOT stream within 120s.
  Micro worker ceiling (max_worker_processes=6, platform bgworkers occupy
  most) - same class as the initial-sync stall seen in manual drilling.
- Manual drilling also established: initial table sync stalls in 'd'
  forever on micro (sync workers cannot spawn); the wedged-subscription
  recovery sequence is disable -> slot_name=none -> drop, in that order;
  subscriptions can vanish/reappear under platform management.
- Backfill limitation recorded: password_hash is not portable via the
  admin API - a backfill must copy hashes via direct SQL, or users
  re-authenticate. CORRECTION 2026-09-02: this was an assumption, not a
  measurement - W09 posted its backfill users without a password_hash.
  tenant-consolidation C03 (2026-08-04) posted a bcrypt password_hash to
  POST /auth/v1/admin/users and the user logged in with the original
  password, so the admin API IS a backfill path for bcrypt hashes. The
  reference and runbook were corrected the same day.
- INTERIM POSTURE (written to the reference): TPA portability keeps
  existing sessions reading; fresh logins post-cutover need either SQL
  hash backfill or forced re-login. auth.* streaming replication on micro
  is not viable.

## W10 - storage object fallback (2026-08-15, green, frontier build)

- Parity gap confirmed: object on primary, standby answers HTTP 400 with
  {"statusCode":"404","code":"NoSuchBucket"} - the real 404 lives in the
  body, not the status line.
- Sync path: download primary -> upload standby, 780ms for a small
  object, byte-identical after.
- Setup must be idempotent: crashed runs leave buckets behind and
  BucketAlreadyExists returns as HTTP 400.

## W11 - schema parity diff (2026-08-15, green, local-rung build)

- Gap measured: RLS policy, function, trigger, view created on primary
  are all absent on standby (table-data replication carries none of them).
- Remediation measured: applying the same DDL to the standby reaches
  parity - this is what pg_dump --schema-only operationalizes.

## W12 - realtime probe (2026-08-15, green, local-rung build)

- Connect ~280-800ms, join, INSERT via REST, postgres_changes event
  arrives (~0.5s on a fresh table), reconnect works (431ms).
- **The wedge finding**: dropping and recreating a table under realtime
  delivery kills events for that table NAME (new OID, stale channel
  metadata) - a fresh name delivers in ~0.5s. Stable canary tables only;
  never churn tables under active subscriptions.
- Service-vs-anon keys: both deliver once grants exist (default
  privileges cover fresh SQL tables).
- Battery-context flake: a join after 11 other modules can have the
  socket closed before the event - the module retries with backoff
  (recorded in measurements).

## W13 - edge function wall-clock limit (2026-08-15, green, local-rung build)

- 5s sleep: 200 (5002ms). 120s sleep: 200 (120002ms). 400s sleep:
  **504 IDLE_TIMEOUT "Request idle timeout limit (150s) reached"**.
- The wall-clock ceiling is 150s idle timeout, measured.

## Full battery (2026-08-15)

13/13 pass unattended in ~12 minutes via `.pi/probe-edge-resilience.sh
W01,...,W13` after `make up`. Lifecycle proven twice: `make down` ->
`make up` -> battery, fresh refs each cycle, same JWKS keypair.

## W14 - instance size vs the auth-replication wall (2026-08-15, manual drill)

The W09 "worker exhaustion on micro" hypothesis was WRONG - size is not
the variable. Standby recreated at `small` (tofu -replace; micro stays on
the primary):

- pg_settings DO scale: max_connections 60 -> 90, shared_buffers 256MB ->
  512MB. max_worker_processes stays 6 on BOTH sizes (platform-fixed).
- auth.* with copy_data=false: WAL sender connects, received_lsn stays
  NULL - zero changes stream, at any size.
- auth.* with copy_data=true: initial sync stalls in 'd' at any size; the
  sync worker hangs at IPC/BgworkerStartup with its publisher sync slot
  inactive.
- **The discriminator**: a CUSTOM non-public schema (lab_schema.t)
  replicates in ~4s on the same instances. storage.buckets does NOT
  replicate either. The wall is specific to PLATFORM-MANAGED schemas
  (auth, storage) - not size, not workers, not schema privacy.
- Writer role is not the filter: inserts via the postgres role into
  storage.buckets also fail to replicate.
- Cleanup lesson: slot_name=none + drop leaves the PUBLISHER slot behind;
  the full recovery is disable -> slot_name=none -> drop subscription ->
  pg_drop_replication_slot on the publisher.

**Conclusion (supersedes the W09 worker-ceiling note):** managed ->
managed replication works for public and custom schemas only. The
platform-managed schemas (auth.*, storage.*) do not replicate by any
tested path, at any tested size. Auth portability posture stands: TPA for
existing sessions + SQL-level backfill + forced re-login. Storage
portability: object sync (W10), not replication.

## W15 - DDL lands on the primary while a subscription is live (2026-08-16, green, module + manual drill)

- After a primary-side ALTER, zero rows arrive on the standby - even rows
  not using the new column. The stall is not table-scoped.
- Applying the same ALTER on the standby resumes replication in ~6.1s with
  both rows backfilled, no subscription recreation.
- Migration procedure: standby DDL first, or accept the stall window.

## W16 - sequence resync at cutover (2026-08-16, green, local-rung one-shot)

- First standby insert after cutover hits duplicate key - sequence values
  do not follow table-data replication (sequence drift).
- setval resync on the standby restores inserts.

## W17 - auth config parity inventory (2026-08-16, green, local-rung one-shot)

- Per-project auth config does not follow a cutover; baseline +
  post-change diffs recorded verbatim, restore confirmed.

## W18 - edge function cold start (2026-08-16, green, probe)

- Cold p50 284ms, p99 1433ms (5 invokes at 60s idle gaps); warm p50 98ms
  over 20 back-to-back invokes.
- Only the first invoke after deploy+idle carries the real cold start
  (~1.4s); idle-cold invokes 2-5 land at 121-302ms - the steady-state
  cold/warm gap is ~100-200ms, not seconds.

## W19 - imgproxy render-path failure modes (2026-08-16, green, probe)

- Valid PNG: render 200 (resized), plain 200.
- corrupt.png (text bytes under a .png name): render 400 InvalidRequest
  "The source image is invalid or unsupported for rendering"; the plain
  public URL still serves the original bytes (200).
- SVG: render path 200 returning the original SVG unchanged (no
  rasterization on this path); plain 200.
- The original always serves even when the transform fails - the render
  path degrades to the source object, never to a 5xx.

## W20 - statement timeout and lock-wait signature (2026-08-16, green, probe)

- statement_timeout '2s' against pg_sleep(5): HTTP 400 with verbatim
  ERROR 57014 "canceling statement due to statement timeout", wall 3467ms.
- Advisory-lock contender with lock_timeout '3s' (two pooler sessions):
  verbatim ERROR 55P03 "canceling statement due to lock timeout",
  wall 4533ms.
- The 04:54-05:00 battery artifacts show W20 failing with "JWT could not
  be decoded" - that battery ran without SUPABASE_ACCESS_TOKEN in env;
  an environment failure, not a module bug. Green on re-probe.

## W22 - initial sync at real table size (2026-08-16, green, probe)

- 1,000,000-row initial sync: 22728ms; streaming lag after sync 245ms.

## W23 - pg_cron across a restart (2026-08-16, green, probe)

- rows_before=2, rows_after=5, diff=3 - pg_cron resumes across a project
  restart and keeps firing on schedule.

## W24 - edge failover proxy with flap damping (2026-08-16, green, probe)

- Full sequence measured, all HTTP 200: prime=primary -> outage=standby
  -> holdover=standby (HOLD_MS=60000) -> return=primary.
- Worker bugs the drill surfaced: (1) the cache-first path ran before the
  failover logic, so HITs carried no x-drill-origin and masked the
  failover entirely - failover mode now skips cache-first; (2) CF Workers
  wraps TCP failures to unroutable origins as a 403 RESPONSE (the W04
  finding), not a throw and not a 5xx, so a >=500 failover condition
  never trips - the worker now treats 5xx, 403, and (under OUTAGE) any
  non-ok as origin failure.
- Drill-design fix: the _w24 cache-buster query param reached PostgREST,
  which treats unknown params as column filters and 400s every probe; the
  worker strips _-prefixed params from the origin URL while keeping the
  full URL in the cache key.
- Hold-window sizing: HOLD_MS=15000 was marginal against the ~11s redeploy
  + settle path between the last outage probe (which refreshes the failure
  timestamp) and the holdover probe, and measured an expired window;
  60000 holds.

## Full battery (2026-08-16)

22/22 pass unattended in ~27 minutes via `.pi/probe-edge-resilience.sh
W01,...,W24` (W14/W21 do not exist as modules). W24 exercised the fixed
failover worker against every other drill in sequence - no cross-test
interference from the cache/failover changes. Artifact:
out/run-2026-08-16T07-50-20-504Z.{json,md}.

## W21 - spend cap trip behavior (2026-08-17, green, module)

- Self-contained drill: provisions a Nano project in the Pro org
  (ErfiCorp) via the Management API, uploads 105 distinct images, and
  renders each once (Pro transform quota: 100 origin images/cycle).
- Finding: NO synchronous enforcement at quota+5 - all 105 renders
  returned 200, including the five past the documented "further usage
  disallowed" boundary. Already-transformed origins serve fine (200).
- Meaning: the spend cap is not a request-path circuit breaker. The
  observable consequences ride the billing path - notification, grace
  period, then Fair Use restrictions (402/pause/read-only) - not the
  API response at quota+1. Provisioning: fresh project healthy in 154s;
  storage tenant lags ACTIVE_HEALTHY (TenantNotFound), pool contended
  (429 SlowDown) for the first minutes.
- Cost of the drill: ~3 min of Nano compute (covered by credits) and
  zero overage charges - the cap being on is what makes it free.

## W25 - tenant routing table: stale row and the eject path (2026-08-17, green, probe)

- Poisoned routing row: tenant-a serves 200 while tenant-b (pointed at an
  unroutable origin) gets 502 - tenant isolation holds; a stale row
  degrades one tenant only.
- The eject cost is the finding: with the routing table in an env var,
  ejecting a tenant is a redeploy (10635ms). A production table in
  KV/D1 ejects without a redeploy; the drill's number is the deploy-bound
  floor.
- Drill mechanics worth keeping: deploy propagation to all PoPs lags the
  settle window (probes must retry toward the expected status, not probe
  once), and the tenant router strips _-prefixed drill params before the
  origin fetch (the W24 PostgREST-400 lesson).

## W26 - storage dual-write viability (2026-08-17, green, probe)

- Parallel dual-write of one object to primary + standby: 200/200, skew
  107ms, bytes equal both sides - the pattern's cost is the slower of
  the two writes, not a serialization.
- Partial failure is NOT atomic: primary 200 / standby 400 (aimed at a
  nonexistent bucket) leaves the object on one side only. Dual-write
  clients must handle the split-brain signature themselves.
- Recovery: sync-after (download primary, upload standby) closes the gap
  in 97ms for a small object - consistent with W10's 780ms first-sync.

## Full battery (2026-08-17)

25 modules (W01-W13, W15-W26), 24/25 pass unattended in ~30 minutes.
W17 failed on a race: the config-restore readback ran immediately after
the PATCH and read the pre-restore value (the config apply is async).
Fixed - the module now polls the readback - and W17 passes on re-probe
(artifact out/run-2026-08-17T08-13-34-645Z). The baseline diff also
recorded a platform finding: `custom_oauth_max_providers` defaults
differ across project generations (32767 vs 3) - auth config defaults
are not stable across time, which is itself config-parity-relevant.
Battery artifact: out/run-2026-08-17T07-41-07-229Z.{json,md}.

## W27 - PGRST303 body length through edge_logs, and the Logs Explorer split (2026-09-07, green, module)

Question: when PostgREST rejects a JWT with PGRST303, can a reader of
edge_logs tell "JWT issued at future" from "JWT expired" without the response
body, and does the byte-count discriminator the body implies survive the API
gateway into `response.headers.content_length`? Fresh micro project
(ap-southeast-2 per `experiment.tfvars`, tofu-managed, provisioned and
destroyed the same day; the artifact's `region` field reads ap-southeast-1,
which is the harness default label when no region is exported, not a project
read).
Artifact: `out/2026-09-07/run-2026-09-07T08-15-44-142Z.{json,facts.md}`,
4 pass, 0 fail. A first run three minutes earlier
(`evidence/20260907-161251/`, local-time stamp for run 2026-09-07T08:12:51Z,
private) had W27c fail on the schema-cache timing described below; W27a and
W27b passed identically in both.

Setup: legacy HS256 tokens minted locally under the project's own
`jwt_secret` (the W07 break-glass read, `GET /projects/{ref}/postgrest`),
sent with the `sb_publishable_` key as `apikey` against `public.w_probe`.
Each request carries a unique User-Agent so its edge_logs row can be found
without a body. Three claims sets: `iat` 300 s ahead (`exp` 3900 s ahead),
`exp` 300 s behind (`iat` 3900 s behind), and valid.

| row | request | wire | edge_logs (logs.all) |
| --- | --- | --- | --- |
| W27a/b future | iat +300 s | 401 PGRST303 "JWT issued at future", 79 bytes, `content-length: 79`, `proxy-status: PostgREST; error=PGRST303` | status_code 401, content_length "79", proxy_status "PostgREST; error=PGRST303", issued_at minus request timestamp 300 s, auth_user set |
| W27a/b expired | exp -300 s | 401 PGRST303 "JWT expired", 70 bytes, `content-length: 70`, same proxy-status | status_code 401, content_length "70", same proxy_status, issued_at minus request timestamp -3900 s, auth_user set |
| W27a/b valid | iat now | 200, 10 bytes (`[{"id":1}]`) | status_code 200, content_length "10", proxy_status null, issued_at minus request timestamp -1 s |
| W27c anon, publishable key only | table with all privileges revoked from anon and authenticated (`revoke all on table`) | 401 42501 "permission denied for table w27_locked", 190 bytes, no content-length header | status_code 401, content_length null, transfer_encoding "chunked", proxy_status "PostgREST; error=42501", no jwt payload, auth_user null |
| W27c anon, legacy anon JWT as bearer | same table | 401 42501, 190 bytes, no content-length header | as above, jwt payload role "anon", auth_user null |
| W27c authenticated (minted) | same table | 403 42501, 199 bytes, no content-length header | status_code 403, content_length null, transfer_encoding "chunked", proxy_status "PostgREST; error=42501", role "authenticated", auth_user set |

- **The 79 versus 70 discriminator was measured on this project.** The two
  PGRST303 bodies differ only in the message string, the response reaches the
  client with a `content-length` header (which hop sets it is not measured
  here), and edge_logs records the same value as
  `metadata.response.headers.content_length` (a string). 79 is
  "JWT issued at future", 70 is "JWT expired". The `proxy-status` response
  header (`PostgREST; error=PGRST303`) is also logged, so the class can be
  selected without the body at all.
- **The JWT payload is logged even on the 401.** Both rejected requests carry
  `metadata.request.sb.jwt.authorization.payload` with `issued_at`,
  `expires_at`, `role` and `subject` (the module's read) and `sb.auth_user`
  non-null; a hand read of the same rows also showed `algorithm` (HS256 here),
  a `signature_prefix`, and `auth_user` equal to `subject`, which the module
  does not assert. So the split
  does not need the byte count: `issued_at` minus the row's own `timestamp`
  (microseconds) reproduces the skew directly, 300 s for the future token,
  -3900 s for the expired one, -1 s for the valid one. Use the byte count as
  the cross-check, the payload as the primary read.
- **content_length is not universal.** The 42501 bodies (190 and 199 bytes)
  arrive chunked: no `content-length` on the wire, `content_length` null and
  `transfer_encoding` "chunked" in edge_logs. A content_length filter finds the
  PGRST303 rows and silently drops permission-denied rows; select on
  `proxy_status` for the class and only then read `content_length`.
- **Endpoint and lag.** `/analytics/endpoints/logs.all` answered the query
  below on every call; `/analytics/endpoints/logs` (the stream endpoint the
  shared `logsQuery` helper uses) answered `Backend error! Retry your query.
  Please contact support if this continues.` to the identical SQL, as S18
  recorded on 2026-09-03. Rows were queryable 46 s after the request in W27b
  (51 s in the first run) and 17 s in W27c; poll, do not read once.
- **42501 mapping through the same path (W27c).** anon -> 401, whether the
  request carried only the publishable key or the legacy anon JWT as bearer;
  authenticated -> 403. Same SQLSTATE in the body and in `proxy_status`
  (`PostgREST; error=42501`) for all three. Agrees with S21 (2026-09-03,
  security-lockdown), which measured anon 401 / authenticated 403 on the wire
  (module S21, no edge_logs read); this row adds the legacy-anon-JWT-as-bearer
  case and the edge_logs shape. The publishable-key-only row returns null for
  every `jwt.authorization.payload` field through the left join (the module's
  read); that `sb.apikey` carries the key prefix and hash is from a hand read
  of the row, not from the module.
- **Schema cache lag is a real hazard for this shape of probe.** The first run
  hit the table 1 s after `CREATE TABLE ... REVOKE` and the two anon requests
  answered 404 PGRST205 "Could not find the table 'public.w27_locked' in the
  schema cache" while the third request, seconds later, got the 403. The
  module now sends `notify pgrst, 'reload schema'` and polls 3 s apart for up
  to 120 s until the code is not PGRST205 (1 attempt, 1 s, in the green run).

The query that returned the rows, as sent to `logs.all` with a 1-hour
`iso_timestamp_start`/`iso_timestamp_end` window (the module's marker in the
`like` is the run's User-Agent prefix):

```sql
select id, timestamp, r.method, r.path, h.user_agent, res.status_code,
       rh.content_length, rh.transfer_encoding, rh.proxy_status,
       jp.issued_at, jp.expires_at, jp.role, jp.subject, sb.auth_user
from edge_logs
cross join unnest(metadata) as m
cross join unnest(m.request) as r
cross join unnest(r.headers) as h
cross join unnest(m.response) as res
cross join unnest(res.headers) as rh
cross join unnest(r.sb) as sb
left join unnest(sb.jwt) as jwt
left join unnest(jwt.authorization) as auth
left join unnest(auth.payload) as jp
where h.user_agent like 'pvlab-w27-%'
order by timestamp desc
```

To split an incident window instead of a marked probe, replace the User-Agent
predicate with `rh.proxy_status = 'PostgREST; error=PGRST303'` and add
`jp.issued_at - div(timestamp, 1000000) as iat_skew_s` to the select list;
rows with `iat_skew_s` above 30 s (a threshold chosen here, not measured) are
the future-iat class, rows with `jp.expires_at < div(timestamp, 1000000)`
(both in seconds) are the expired class. Neither predicate ran in the module,
which did the same subtraction client-side; `timestamp` is microseconds, so
comparing `expires_at` to it without the `div` classifies every row as
expired. Not settled here: whether a project provisioned in an earlier Logs
Explorer era exposes the same field paths, and the stale-time cache itself
(that needs a PostgREST build with a one-second skew, out of scope here).
