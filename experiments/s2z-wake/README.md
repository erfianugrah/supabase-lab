# s2z-wake

Which Management API calls wake a scaled-to-zero project, and therefore start
billing compute again.

The commercial question behind it: on the platform plan a project's compute
scales to zero when idle, and `compute_usage_hours` bills the auto-pause-adjusted
fraction of the hour the database was running. A platform that polls its tenants'
projects from a control loop - a status page, a metrics scrape, a nightly
inventory job - could therefore be paying for compute that its tenants never
asked for, purely as a side effect of its own bookkeeping. Nobody has measured
which calls do that.

Run against the STAGING control plane (`api.supabase.green`), on a
`platform`-plan org, so a mistake costs nothing. Three staging-specific facts the
harness needs, all measured 2026-09-09:

- the data-plane host suffix is **`supabase.red`**, not `supabase.green`
  (`db.<ref>.supabase.red`), so `SUPABASE_API_HOST_SUFFIX=supabase.red`
- the staging OpenAPI document at `api.supabase.green/api/v1-json` carries the
  **identical 169 (verb, path) pairs** as production - diffed the same day, zero
  difference - so the surface under test is the production surface
- an org-scoped staging PAT answers `403` on `GET /v1/profile` and returns `[]`
  from `GET /v1/projects` while `GET /v1/organizations/{slug}/projects` works.
  Read the project list from the org-scoped route, or a self-provisioning
  module concludes its own project does not exist

Sibling context: `sfp-platforms` measured what the platform plan *unlocks* and
established that the SfP-path create (no `desired_instance_size`) lands on
`nano`; `instance-sizing` I04 timed the *pause/restore* cycle (wake 162-204 s,
data API `HTTP 540` while parked). Neither touches scale-to-zero, which is a
different mechanism from pause and restore - the control plane models it as its
own state, `project_hibernating` (see the observable below).

## Method

Enumerated from the published OpenAPI document rather than guessed, per the F05
method note in `platform-facts`: a negative result ("the API cannot X") is only
worth stating across the complete operation set. 169 operations total, 143
project-scoped, 52 of them GETs whose only path parameter is `{ref}` and so
callable with no extra setup. Those 52 are the read surface a polling platform
would plausibly hit, and they are what this experiment measures first.

### The observable

The control plane has its own word for a scaled-to-zero project:
`ProjectUpgradeEligibilityResponse.validation_errors[].type` carries the enum
value **`project_hibernating`**, alongside nine ordinary upgrade blockers
(`unsupported_extension`, `active_replication_slot`, `x86_architecture`, ...).
So `GET /v1/projects/{ref}/upgrade/eligibility` reports hibernation without a
data-plane round trip, and it reads `validation_errors: []` while awake.

That gives a cheap non-invasive check, and it is what makes the per-endpoint
protocol affordable:

1. confirm hibernating
2. call the endpoint under test ONCE; record status and TTFB
3. re-check hibernating
   - still hibernating -> that endpoint did NOT wake it, so continue with the
     next endpoint in the same park window
   - no longer -> that endpoint DID wake it; stop, re-park, resume from the
     next endpoint
4. separately time a data-plane query, because the control plane could report
   hibernating while the instance is already warming

Only a *waking* endpoint costs a park cycle. If most reads are non-waking the
whole 52 fit into a handful of windows, which is why the run is ordered
least-likely-to-wake first (analytics and control-plane metadata before
anything that has to open a Postgres connection).

Two independent signals, because neither is trusted alone: `project_hibernating`
from the control plane, and TTFB on an authenticated PostgREST select against a
one-row probe table. Awake, that select answers `200` in 0.07-0.35 s (median
~0.11 s, five samples).

## Status - CLOSED 2026-09-23

Awake baseline: DONE, all 52 endpoints.
Pause-path wake matrix: DONE, 52 GETs and 73 write operations, zero wakers.
Auto-pause vs manual pause: DONE - they land in the same state (both NXDOMAIN).
Scale-to-zero (hibernation) path: UNREACHABLE on any account available here,
and that is the end state rather than a pending result. See "Why the
hibernation arm closed" at the end.

The auto-pause fan-out (Z03/Z04) was built and never fired: twelve nano
projects on a STAGING platform-plan org sat 13 days with zero activity and none
auto-paused, while production free-plan projects auto-paused over the same
window. The inactivity machinery appears not to run against staging. Z04 is
correct and usable - point it at production free-plan projects, and mind the
2-active-project cap per free org.

The plane classification in the working `MGMT-API-WAKE-MATRIX.md` was a
hypothesis about which handlers reach the instance. The pause-path run
falsified its usefulness as a wake predictor: the handlers that DO need the
instance fail rather than wake it, so "touches Postgres" predicts an error
code, not a billing event.

## Awake baseline (nano, ap-southeast-1, 2026-09-09)

Every parameter-free project GET against a healthy nano project - the comparison
set for the hibernating pass. Control-plane latency is not uniformly fast even
with the instance up: `network-restrictions` took 13.7 s, `config/auth` 8.1 s,
`usage.api-counts` 6.0 s.

| endpoint | http | ttfb (awake) |
|---|---|---|
| `(project root)` | 200 | 0.83s |
| `/actions` | 200 | 1.32s |
| `/advisors/performance` | 200 | 2.14s |
| `/advisors/security` | 200 | 2.80s |
| `/analytics/endpoints/functions.combined-stats` | 400 | 0.45s |
| `/analytics/endpoints/logs` | 200 | 2.43s |
| `/analytics/endpoints/logs.all` | 200 | 2.88s |
| `/analytics/endpoints/metrics` | 200 | 1.39s |
| `/analytics/endpoints/usage.api-counts` | 200 | 5.95s |
| `/analytics/endpoints/usage.api-requests-count` | 200 | 0.83s |
| `/api-keys` | 200 | 0.79s |
| `/api-keys/legacy` | 200 | 2.19s |
| `/billing/addons` | 200 | 1.67s |
| `/branches` | 200 | 1.07s |
| `/claim-token` | 404 | 0.42s |
| `/config/auth` | 200 | 8.11s |
| `/config/auth/signing-keys` | 200 | 2.09s |
| `/config/auth/signing-keys/legacy` | 200 | 0.69s |
| `/config/auth/sso/providers` | 200 | 4.14s |
| `/config/auth/third-party-auth` | 200 | 2.87s |
| `/config/database/pgbouncer` | 200 | 0.83s |
| `/config/database/pooler` | 200 | 2.94s |
| `/config/database/postgres` | 200 | 0.44s |
| `/config/disk` | 200 | 0.62s |
| `/config/disk/autoscale` | 200 | 0.63s |
| `/config/disk/util` | 200 | 2.42s |
| `/config/realtime` | 200 | 0.82s |
| `/config/storage` | 200 | 1.07s |
| `/custom-hostname` | 400 | 0.49s |
| `/database/backups` | 200 | 0.71s |
| `/database/backups/restore-point` | 400 | 1.05s |
| `/database/backups/schedule` | 402 | 0.54s |
| `/database/context` | 200 | 2.22s |
| `/database/jit` | 406 | 2.26s |
| `/database/jit/list` | 200 | 0.73s |
| `/database/migrations` | 200 | 0.87s |
| `/database/openapi` | 200 | 1.26s |
| `/functions` | 200 | 1.70s |
| `/health` | 200 | 2.50s |
| `/jit-access` | 200 | 1.48s |
| `/network-restrictions` | 200 | 13.69s |
| `/pgsodium` | 200 | 0.86s |
| `/postgrest` | 200 | 0.49s |
| `/readonly` | 200 | 3.85s |
| `/restore` | 400 | 0.94s |
| `/secrets` | 200 | 1.06s |
| `/ssl-enforcement` | 200 | 0.34s |
| `/storage/buckets` | 200 | 1.69s |
| `/types/typescript` | 200 | 3.14s |
| `/upgrade/eligibility` | 200 | 1.44s |
| `/upgrade/status` | 200 | 1.99s |
| `/vanity-subdomain` | 200 | 0.86s |

Non-200s are entitlement and state boundaries, not failures:
`claim-token` `404` (no token issued), `custom-hostname` `400` (add-on absent),
`database/backups/restore-point` `400 "This endpoint is unavailable at the
moment"` (the same gate `sfp-platforms` S03 found on three org classes),
`database/backups/schedule` `402 entitlement_required`, `restore` `400 "not in a
paused state"`, `database/jit` `406`, and
`analytics/endpoints/functions.combined-stats` `400` (needs `interval` and
`function_id`).

Two of these reads return live credential material in full rather than
redacted, to any caller holding the PAT. Treat a PAT as equivalent to full
project access and scope it accordingly - it is not a read-only analytics
credential. The `?reveal=true` redaction that `sfp-platforms` S14 documented
applies to the api-keys CREATE response and does not extend to every read.
Point this experiment at staging only.

## Measured: no Management API GET wakes a paused project (2026-09-09)

Scale-to-zero itself did not trigger in any observation window (see below), so
the mechanism that IS reachable on a platform org got measured instead: `POST
/pause`, which `sfp-platforms` S06 established is enforced on the platform plan
and refused everywhere else. On a platform org that is the tenant-parking lever
a builder actually has today.

`POST /pause` -> `200`, `INACTIVE` after **71 s**. The data plane answers
**`HTTP 540` in 0.42 s** while parked - edge-served, so a paused project's
refusal is fast rather than a timeout.

**All 52 parameter-free GETs were then called against the paused project, one at
a time, re-reading the project status after each. Every one came back
`no-wake`. Zero wakers.** The instrument is the ORG-scoped project listing, so
the observable sits outside the set under test.

So a platform's control-plane polling does not restart a PARKED tenant's
compute. The endpoints that need the instance fail; they do not wake it.

Read the scope carefully: this is the manual-pause path, and a paused project
has no DNS record at all (see the limitation section at the end), so it is a
state nothing could wake. Whether the same holds in the scale-to-zero state is
NOT answered here - that is a different mechanism and this experiment never
reached it.

Scope: GETs only. The 91 project-scoped write operations are untested, and
`POST /restore` wakes a project by definition.

### The failure modes are not uniform, and four of them lie

Sixteen endpoints change status when the project is parked. `544` is a
Supabase-specific code carrying `"Connection terminated due to connection
timeout"`, and it costs the caller the full connection timeout - `/database/
migrations` took **20.0 s** to return it. Seven answer `500`, which is a server
error for what is a known, expected project state.

Three endpoints are worse than an error: they answered `200` with CONTENT while
awake and **`200` with an empty result** while parked, so a caller that checks
the status code cannot tell "nothing to report" from "could not look".

| endpoint | awake | parked | what a naive caller concludes |
|---|---|---|---|
| `/api-keys` | `200`, 1524 B | `200` `[]` | this project has no API keys |
| `/advisors/performance` | `200`, 763 B | `200` `{"lints":[]}` | no performance findings |
| `/config/database/pooler` | `200`, 574 B | `200` `[]` | no pooler configured |

So a fleet-wide advisor sweep across a platform's tenants scores every parked
project as clean.

The awake-vs-parked comparison is what makes this a finding rather than an
artefact, and getting it wrong is easy. An earlier version of this section
listed FOUR endpoints, including `/advisors/security`, and an earlier version of
the Z01e check flagged eight - because `/actions`, `/branches`, `/functions`,
`/secrets` and `/config/database/postgres` are legitimately `[]` on a fresh
project whether it is parked or not. `/advisors/security` is the same story: a
fresh project has no security lints, so it reads `{"lints":[]}` both ways and
this experiment cannot tell whether parking silenced it. Z01 now seeds a real
advisor finding (a public table with RLS disabled) before the awake pass so the
advisors endpoints have something to lose, and Z01e compares the two passes on
the same project rather than thresholding a response size.

`/restore` inverts, correctly: `400 "This project is not in a paused state"`
while healthy, `200` while parked.

### Full matrix

| endpoint | awake | paused | paused TTFB | note |
|---|---|---|---|---|
| `(project root)` | 200 | 200 | 1.14s |  |
| `/actions` | 200 | 200 | 0.16s |  |
| `/advisors/performance` | 200 | 200 | 1.27s | **silent degradation** - `{"lints":[]}` - reports no findings |
| `/advisors/security` | 200 | 200 | 1.99s | **silent degradation** - `{"lints":[]}` - reports no findings |
| `/analytics/endpoints/functions.combined-stats` | 400 | 400 | 0.63s |  |
| `/analytics/endpoints/logs` | 200 | 200 | 2.11s |  |
| `/analytics/endpoints/logs.all` | 200 | 200 | 2.30s |  |
| `/analytics/endpoints/metrics` | 200 | 400 | 0.77s | changed |
| `/analytics/endpoints/usage.api-counts` | 200 | 200 | 0.74s |  |
| `/analytics/endpoints/usage.api-requests-count` | 200 | 200 | 0.61s |  |
| `/api-keys` | 200 | 200 | 5.27s | **silent degradation** - `[]` - reports no API keys at all |
| `/api-keys/legacy` | 200 | 200 | 0.23s |  |
| `/billing/addons` | 200 | 200 | 4.22s |  |
| `/branches` | 200 | 200 | 2.32s |  |
| `/claim-token` | 404 | 404 | 1.24s |  |
| `/config/auth` | 200 | 200 | 4.42s |  |
| `/config/auth/signing-keys` | 200 | 500 | 1.42s | changed |
| `/config/auth/signing-keys/legacy` | 200 | 500 | 0.50s | changed |
| `/config/auth/sso/providers` | 200 | 500 | 0.70s | changed |
| `/config/auth/third-party-auth` | 200 | 200 | 0.93s |  |
| `/config/database/pgbouncer` | 200 | 200 | 7.77s |  |
| `/config/database/pooler` | 200 | 200 | 1.79s | **silent degradation** - `[]` - reports no pooler config |
| `/config/database/postgres` | 200 | 200 | 5.79s |  |
| `/config/disk` | 200 | 200 | 1.06s |  |
| `/config/disk/autoscale` | 200 | 200 | 0.31s |  |
| `/config/disk/util` | 200 | 500 | 0.98s | changed |
| `/config/realtime` | 200 | 200 | 0.81s |  |
| `/config/storage` | 200 | 200 | 3.86s |  |
| `/custom-hostname` | 400 | 400 | 0.84s |  |
| `/database/backups` | 200 | 200 | 2.80s |  |
| `/database/backups/restore-point` | 400 | 400 | 0.77s |  |
| `/database/backups/schedule` | 402 | 402 | 0.18s |  |
| `/database/context` | 200 | 500 | 11.00s | changed |
| `/database/jit` | 406 | 406 | 3.03s |  |
| `/database/jit/list` | 200 | 200 | 0.30s |  |
| `/database/migrations` | 200 | 544 | 19.97s | changed |
| `/database/openapi` | 200 | 400 | 0.47s | changed |
| `/functions` | 200 | 200 | 0.45s |  |
| `/health` | 200 | 400 | 0.57s | changed |
| `/jit-access` | 200 | 200 | 1.03s |  |
| `/network-restrictions` | 200 | 200 | 0.59s |  |
| `/pgsodium` | 200 | 200 | 3.04s |  |
| `/postgrest` | 200 | 404 | 1.94s | changed |
| `/readonly` | 200 | 544 | 15.53s | changed |
| `/restore` | 400 | 200 | 1.56s | changed |
| `/secrets` | 200 | 200 | 1.76s |  |
| `/ssl-enforcement` | 200 | 500 | 2.06s | changed |
| `/storage/buckets` | 200 | 500 | 0.25s | changed |
| `/types/typescript` | 200 | 400 | 1.99s | changed |
| `/upgrade/eligibility` | 200 | 400 | 0.45s | changed |
| `/upgrade/status` | 200 | 200 | 0.56s |  |
| `/vanity-subdomain` | 200 | 200 | 0.86s |  |

### Scale-to-zero did not trigger

A second nano project was parked in TOTAL silence as a control - zero
project-scoped calls after setup - to separate "the idle window is long" from
"the watcher's own polling keeps the project awake". It stayed
`ACTIVE_HEALTHY` throughout. No spontaneous transition was observed on either
arm.

Measured here: no transition on either arm across the first hour of silence.
For scale, Supabase's public pricing page puts free-project auto-pause at a week
of inactivity, so the window does not close inside a session and this
experiment cannot reach it from a standing start. Any run that wants that path
has to park a project with genuinely zero query activity and wait - and the
lab's own setup (creating a probe table, selecting from it) is itself query
activity that restarts the clock.

`project_hibernating` is NOT the same state as `INACTIVE`: `upgrade/eligibility`
read `validation_errors: []` while the project was actively `PAUSING`, so that
endpoint cannot detect a pause, and the hibernation and pause mechanisms are
distinct in the control plane's own vocabulary. Treat the two as separate
questions; this experiment answers the pause one.

## Limitation: a paused project is unreachable by construction

The "zero wakers" result above is about a state that CANNOT be woken by
traffic, because a paused project has no public DNS record.

Measured 2026-09-09 against two independent public resolvers (1.1.1.1 and
8.8.8.8, to rule out local caching), on the same org, at the same moment:

| project state | `<ref>.<suffix>` |
|---|---|
| `INACTIVE` (two projects) | **NXDOMAIN** |
| `ACTIVE_HEALTHY` | resolves (two Cloudflare edge addresses) |

`db.<ref>.<suffix>` is absent in both paused cases too.

This matters for how far the result generalises. The wake path for a
HIBERNATED project is traffic to the project URL - and on a paused project
that URL does not exist, so no amount of traffic could ever wake it. The
125-operation sweep therefore establishes something narrower than it first
appears:

- **Holds:** the Management API reaches the CONTROL plane, not the project
  hostname, so those calls were genuinely delivered and genuinely did not
  restart compute. That is a real result about the control plane.
- **Does not transfer:** anything about the scale-to-zero state, which is a
  different mechanism and was never reached here. Pausing cannot be used to
  stand in for it, because the DNS teardown removes the very condition under
  which a wake could occur.

Correction to an earlier reading in this file's history: the data plane answers
`HTTP 540` only TRANSIENTLY, measured seconds after the pause completed while
DNS was still live or locally cached. At 13 and 50 minutes parked the answer is
NXDOMAIN, not 540. `instance-sizing` I04 recorded 540 on a free-org project;
whether that persists there or was also measured early is untested.

The hibernation arm is the only way to close this, and it needs a project
parked for days with zero query activity plus a sampler installed BEFORE the
window opens (there is no API-observable pause timestamp to recover afterwards).

## Why the hibernation arm closed (2026-09-23)

The original question was whether a Management API call wakes a scaled-to-zero
project and restarts billing. It is answered for every mechanism that could be
reached, and the one that could not is named rather than left open.

| mechanism | reachable here | wake result |
|---|---|---|
| manual `POST /pause` | yes | no Management API operation wakes it (125 tested) |
| auto-pause after inactivity | yes, on production free-plan only | same state as manual pause (NXDOMAIN), so the above transfers |
| hibernation / scale-to-zero | **no** | never observed on any account available |

Both pause routes tear the project's public DNS down, which is what makes the
null result robust: there is no hostname for traffic to arrive at, so nothing
CAN wake a parked project by traffic, and the control plane declines rather
than starting compute.

Hibernation is the one that got away. Four ladder rungs on a free-plan nano
project (to 2 hours idle) showed no elevated first-request latency and no
`project_hibernating`, and the subject then auto-paused instead, which ends
that arm - a probe against a parked project reaches NXDOMAIN, not a hibernating
instance. Whether hibernation is enabled at all on these accounts was never
established.

Practical answer for a platform operator, which is what the question was for:
control-plane polling does not restart a parked tenant's compute. The cost
risk, if it exists, is on the data plane - and on a parked project even that is
moot, because the hostname is gone.
