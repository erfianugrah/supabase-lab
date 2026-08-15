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
make init apply keygen worker-deploy seed
make probe ONLY=W01,W02,W03
make probe-destructive    # W04 (redeploys the worker twice)
make destroy              # when done
```

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
  re-authenticate.
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
