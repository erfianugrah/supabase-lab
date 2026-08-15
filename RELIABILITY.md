# Supabase incident & client-side resilience reference

For each recurring platform incident class: the mechanism, what the client
actually sees, what a client can DO about it, and which of those claims are
lab-validated (with numbers and dates) vs doc-claimed vs anecdotal.

Lab evidence lives in this repo (experiments/<name>/RUNLOG.md + evidence/);
the newest entries are from experiments/edge-resilience (2026-08-15).
Public evidence is cited per class.

## Class 1: JWT claim-validation rejection (PGRST303 "JWT issued at future")

**Mechanism.** PostgREST validates `iat`/`exp` on every request. If the
issuer's clock runs ahead of the validator's (NTP drift/failure), freshly
minted tokens carry a future `iat` and are rejected. Auth (`/auth/v1/user`)
can return 200 while the data API rejects the SAME token - the services
validate on different hosts (public: GitHub Discussion #48123, 2026-07-21,
ap-southeast-1).

**Client sees.** `401 {"code":"PGRST303","message":"JWT issued at future"}`
on /rest/v1 and other JWT-validating paths. Only tokens minted DURING the
skew window fail; tokens minted before it (past `iat`, valid `exp`) keep
working. The failure wave = every active session as its access token
expires and refreshes - default 1h TTL means a full wash within one TTL.

**Public incidents.** status.supabase.com 2026-08-14 "401 errors due to JWT
rejections" ("newly refreshed JWTs being rejected by the API"; identified
02:23 UTC, rollout 07:53 UTC), plus "Elevated JWT authorization errors" ~4
days earlier and a separate us-east-2 project-access incident the same day.
Recurring class, not a one-off.

**Lab-validated (edge-resilience W01, 2026-08-15).**
- Skew tolerance measured: +30s ACCEPTED, +31s REJECTED (401 PGRST303) on
  the final run; first run 31/60. Matches the documented 30s tolerance
  (PostgREST v11 auth reference) within mint-to-validate timing.
- Expired token => 401 PGRST303. Unknown key => 401 PGRST301.
- JWKS trust lags the Management API by ~30s (resolved != trusted);
  deletion lags by seconds. Config APIs are not request-path truth.
- `PATCH /config/auth {jwt_secret:...}` returns 200 and is a NO-OP
  (2026-08-14). Projects bootstrap ES256 in_use + HS256 previously_used;
  the HS256 secret is not API-readable (GET /projects/{ref}/postgrest
  exposes it, per http-tier-lockdown run 2). Arbitrary-claim minting for
  drills: lab-controlled issuer via TPA `jwks_url` (custom_jwks NEVER
  resolves - dead path; jwks_url resolves in ~80ms).

**Client-side mitigations.**
- **Raise `jwt_exp`** (access-token TTL): shrinks the cohort forced through
  refresh during a skew window. Scriptable via PATCH config/auth; readback
  immediate, issuer-effective in ~6.5s (W03, 2026-08-15). Restorable.
- **Detect by code, not status**: alert on PGRST303 rate - it separates
  claim rejection from generic 5xx.
- **Do not bother retrying mid-skew**: every refreshed token is equally
  future-iat; a refresh-retry loop just adds load. The default supabase-js
  correctly makes exactly 1 attempt on PGRST303 (W02).
- No runtime workaround for the window itself; the fix is platform-side
  (PostgREST update + NTP hardening).

## Class 2: Compute lifecycle downtime (restart / resize / upgrade / pause)

**Lab-validated (platform-downtime, 2026-08-06..08).**
- Restart gaps: REST ~10s, Storage ~26s, Auth ~75s (N=3, p50). Auth stays
  down ~7.5x longer than REST on the same event.
- Anonymous `pg_isready`-style probes see NOTHING - network accept is not
  readiness. Authenticated probes only, against a real table.
- Postgres itself continues serving through kong/auth deaths
  (http-tier-lockdown).
- Measure against the AUTH REST surface (signUp), not the password grant -
  RLS blocks password grant on a fresh project and a sensor will report an
  outage that is really its own permission model (F16).

## Class 3: Pooler (Supavisor) failure modes

**Lab-validated (pooler-semantics, http-tier-lockdown).**
- Session mode: startup auth failure => clean 58P01 at connect.
- Transaction mode: connect SUCCEEDS, first statement fails 08P01/0A000;
  prepared statements unsupported.
- The same HTTP 400 can be "bad request" or capacity ceiling - read the
  SQLSTATE inside, never the HTTP status alone.
- Non-pooler 5432 accepts connections then silently blackholes packets
  (reads hang forever) when overloaded - pgbench only ever sees the pooler.

## Class 4: Capacity / control-plane failures

**Public incidents (2026 pattern).** 2026-04-12 APAC create failures ~1.3h;
2026-04-25, us-east-1/2 + ap-northeast-1, ~2h (create/resize/restart
disabled); 2026-06-30 multi-region project status change failures;
2026-05-08, us-east-1-az4, Supavisor/AZ network outage (~1 day);
2026-08-05 upgrade fix; 2026-08-14 us-east-2 project access/update/create.
Capacity is the second recurring class behind JWT claim rejection.

**Client sees.** Create/update/resize/restart operations fail or hang.
EXISTING projects usually unaffected (2026-06-30: "existing projects are
not affected unless restarted or resized during this incident").

**Mitigations.** Pre-provision a project pool for bursty provisioning;
smart region selection (capacity varies per region); never couple app
availability to control-plane availability.

## Class 5: HTTP tier / schema cache

**Lab-validated (http-tier-lockdown, 2026-08-10).**
- PostgREST schema-cache wedge => 503 PGRST002 "schema cache load"; fix is
  `pg_notify('pgrst','reload schema')`.
- PGRST001 on an EMPTY exposed schema is not a wedge; PGRST002 is.
- ACTIVE_HEALTHY means the HTTP tier is up, not that PostgREST can reach
  Postgres: killing Postgres on a healthy project yields 503 PGRST000/
  PGRST002 on /rest/v1 while status stays ACTIVE_HEALTHY (platform-facts
  F7). Probe a real table.

## Class 6: Storage image-transform billing shock

**Mechanism.** Billed per DISTINCT ORIGIN IMAGE per billing cycle
($5/1000, 100 included on Pro/Team; count resets each cycle). A library
that grows Nx in a month re-bills the whole live library every month it is
viewed. NOT per-request; CDN cache hits do not reduce the billable count.
Recurring public misread (expect per-request absorbed by caching).

**Client-side mitigations.**
- Pre-generate renditions at upload (docs-recommended architecture);
  transform-on-read only where unavoidable.
- Per-project transformations toggle as a hard stop - caveat: cached
  transformed images may still bill after disabling (internal overlap
  unresolved as of 2026-08; do not promise a clean zero).
- Spend cap is Pro-only; Team/Enterprise have NO ceiling and no per-line
  alerting. Org usage page + Upcoming Invoice show spend mid-cycle
  (weekly check at high growth); the only alerting offered is the
  Prometheus metrics endpoint (infra metrics, not billing lines).

## Class 7: Edge caching as an outage absorber

**Lab-validated (edge-resilience W04 + worker build, 2026-08-15).**
- Cache-first Cloudflare Worker: warm URLs served 200 HIT with
  byte-identical bodies while the origin was hard-down (outage simulated
  by repointing origin fetches at TEST-NET-1). Cold URLs failed (403) -
  only warm reads survive.
- CF Workers wraps TCP failures to unroutable/private IPs as a 403
  RESPONSE, not a JS exception - catch-based stale fallback never fires
  for that failure mode; handle it in the status branch too.
- GOTCHA: the gateway's Cloudflare front sets `Set-Cookie: __cf_bm` on
  EVERY response; `caches.default.put` refuses Set-Cookie responses and
  `waitUntil` swallows the rejection - a naive cache proxy silently NEVER
  caches. Strip `set-cookie` before `put`.
- Redeploy-based outage toggle takes ~10.5s (wrangler var change) - fine
  for drills, not for production failover logic.

## Class 8: Client retry behavior (supabase-js v2.112.3)

**Lab-validated (edge-resilience W02, 2026-08-15).**
- 401 PGRST303 => exactly 1 attempt (9ms elapsed). Default client does NOT
  retry claim rejections - no retry-amplification of a JWT incident.
- 503 PGRST002 x3 then 200 => 4 attempts, success in ~7.0s. Transient 5xx
  ridden out with backoff.
- Connection refused => "Unable to connect" after ~7.0s.
- Docs (guides/api/automatic-retries-in-supabase-js.md): built-in retries
  for 408/409/503/504 + network failures, default ON since v2.102.0;
  `fetch-retry` for custom policies (e.g. retryOn [520]).

## Class 9: Warm standby + cutover (the real HA tier)

**Lab-validated (edge-resilience W05, 2026-08-15, cross-region
ap-southeast-2 -> ap-southeast-1).**
- Managed->managed logical replication WORKS: subscription on a managed
  standby against the primary's direct host. Initial sync ~3.1-6.5s (small
  table); replication lag 34ms-1057ms across regions.
- Pooler cannot be the replication source (verbatim: ENOIDENTIFIER no
  tenant identifier) - direct host only, per the sbshift runbook.
- Sessions survive cutover WITHOUT secret copying: register the primary's
  OIDC issuer as TPA on the standby (resolves ~60-120ms; X02 portability).
  jwt_secret PATCH is a no-op, so secret-copying was never an option.
- Cutover cold path: a first-time issuer's kid costs ~30s of PGRST301
  before PostgREST trusts it; a previously-seen JWKS warms in ~300ms.
  REHEARSE the cutover - the first real one otherwise eats the cold path.
- Cutover hygiene: resync sequences (they do not replicate), apply DDL to
  both sides, drop the orphaned replication slot on the old primary.
- **The parity gap (doc-only, not yet drilled)**: logical replication
  carries table data ONLY. RLS policies, grants, functions, triggers and
  views need a schema-only dump applied to the standby (and re-applied on
  change). auth.* replication is untested - TPA keeps EXISTING tokens
  valid, but fresh logins on the standby hit its own auth store. Storage
  objects do not follow their metadata (dual-write or S3 sync). Vault
  secrets replicate as useless ciphertext (project-scoped root key).
  pg_cron, function secrets and Realtime state do not move. A real cutover
  is a parity checklist, not a subscription.
- Cold DR floor: pg_dump 12.4s / restore 6.4s for 10k rows via pooler
  (W06).
- Break-glass: GET /projects/{ref}/postgrest returns jwt_secret; minting
  user tokens without GoTrue WORKS (W07) - an Auth-outage escape hatch
  with crown-jewel exposure. Document, gate access, prefer TPA portability.
- Refresh races: concurrent same-token refreshes both succeed (W08) -
  naive multi-tab concurrency alone does not break sessions.

## Class 10: What you cannot work around (be honest)

- Fleet-wide platform incidents: nothing client-side helps. Contractual
  SLAs + degradation prioritization are the remedy, not engineering.
- Control-plane outages (Class 4) for provisioning-dependent products:
  pre-provision; there is no runtime fallback.
- Multi-region active-active writes: no managed failover; read replicas
  are GET-only, never promoted, Auth always goes to Primary, and both the
  JWT secret AND the published kid must match for tokens to validate
  (platform-facts F14). PITR restore into another region is the managed DR
  path; restore time varies (tooManyConnections observed - drain first).
- Email-send rate limits: hosted signup is not a scriptable probe surface
  (over_email_send_rate_limit); use admin-create + password grant.

## Cross-cutting verification playbook (from lab RUNLOGs)

- A 200 from a config API is not effect: jwt_secret PATCH no-op, V03 vault
  "active" applying nothing, TPA custom_jwks 201-but-never-resolves, W03's
  ~6.5s issuer lag, W01's ~30s JWKS trust lag. Poll the REQUEST path.
- Anonymous network probes see nothing; authenticate every probe and hit a
  real table.
- The pgrest code (PGRST303/301/002/000, 58P01, 08P01) is the finding;
  HTTP status alone is ambiguous.
- Public docs can carry wrong hostnames (pooler doc, platform-facts F6) -
  repro against the real project before repeating.
- Readiness != exit code (tenant-promotion T27: already-live exits 0 with
  zero writes).
