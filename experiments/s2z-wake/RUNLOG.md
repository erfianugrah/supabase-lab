# s2z-wake RUNLOG

Chronological record of what was actually run. Project refs and org slugs are
not recorded here (the repo is public and `identifiers.test.ts` scans for the
shape); the org class and control plane are.

## 2026-09-09 - surface enumeration + awake baseline (platform-plan org, STAGING control plane, ap-southeast-1)

Prompted by the cost question: a Management API call that wakes a
scaled-to-zero project starts billing compute, so a platform's own polling
could be generating its tenants' compute bills.

- **Staging vs production surface**: fetched both OpenAPI documents and diffed
  the (verb, path) sets. 169 operations each, ZERO difference. So behaviour
  measured on staging is measured against the production surface. 143 of the
  169 are project-scoped; 52 are GETs whose only path parameter is `{ref}`.
- **Staging auth realm is separate**: the production PAT answers `200` on
  `api.supabase.com/v1/profile` and `401` on `api.supabase.green/v1/profile`.
  A staging PAT is its own credential.
- **The staging PAT is org-scoped**: `403` on `GET /v1/profile`, and `GET
  /v1/projects` returns `[]` even with a live project in the org, while `GET
  /v1/organizations/{slug}/projects` lists it correctly. A self-provisioning
  module that polls the account-wide list would conclude its own project does
  not exist.
- **Data-plane suffix is `supabase.red`** on this control plane, not
  `supabase.green` - the create response's `database.host` is
  `db.<ref>.supabase.red`. The direct host is IPv6-only and unreachable from
  the WSL vantage (consistent with the harness's `direct-db` capability being
  runner-only), so the data-plane observable goes through PostgREST over IPv4.
- **The org is genuinely `platform`-plan**: `GET /organizations/{slug}` reports
  `plan: platform`, `allowed_release_channels: [ga, preview, internal]`.
  Entitlements match the production platform org `sfp-platforms` measured:
  `compute_update_available_sizes` = `ci_micro`..`ci_16xlarge` (no nano - you
  cannot resize TO nano), `project_pausing` and `project_cloning` true,
  `pitr.available_variants` and `backup.schedule` false.
- **SfP-path create lands on nano, confirmed on staging**: create with no
  `desired_instance_size` returned `201` with `status: ACTIVE_HEALTHY` in the
  create response itself, and the org listing reports
  `infra_compute_size: nano`, `disk_volume_size_gb: 2`. Independent replication
  of the 2026-08-24 production reading.
- **The hibernation observable, found in the spec rather than by probing**:
  `ProjectUpgradeEligibilityResponse.validation_errors[].type` carries the enum
  value `project_hibernating` among ten blockers. Awake, `GET
  /upgrade/eligibility` reads `eligible: false, validation_errors: []`, so the
  presence of that type is a control-plane hibernation signal that needs no
  data-plane round trip. `RealtimeConfigResponse.suspend` is unrelated - it is
  a Realtime disable toggle.
- **Awake baseline, all 52 parameter-free GETs**: recorded in the README
  table. All answered; the non-200s are entitlement and state boundaries.
  `database/backups/restore-point` gives the same `400 "This endpoint is
  unavailable at the moment"` that S03 found on Pro, Team and platform orgs,
  which is now a fourth org class and a second control plane with that gate.
- **Data-plane observable calibrated**: a one-row probe table plus an anon
  select policy, queried through PostgREST with the publishable key. Awake:
  `200` in 0.07-0.35 s over five samples. An unauthenticated request is NOT a
  usable liveness signal - the `401 "No API key found in request"` comes from
  the edge gateway, not from PostgREST on the instance.
- **Incidental finding, security-relevant**: `GET /pgsodium` returns the vault
  root key in plaintext and `GET /api-keys` returns anon, service_role,
  publishable and secret keys UNREDACTED to any PAT holder. S14 documented
  that api-keys CREATE redacts without `?reveal=true`; that redaction does not
  apply to this listing.

IN FLIGHT at time of writing: the hibernation threshold. A watcher is parked on
the project touching only org-scoped metadata (60 s) plus `upgrade/eligibility`
(10 min), so it cannot itself count as data-plane activity. Until that
threshold is known, NO wake behaviour has been measured and the plane-based
classification of the 169 operations remains a hypothesis.

<!-- Append new runs below: date, org class, control plane, module ids, artifact path. -->

## 2026-09-09 - pause-path wake matrix, all 52 GETs (platform-plan org, STAGING control plane)

Pivoted once the idle window turned out to be measured in days rather than
minutes: scale-to-zero was never going to trigger inside a session. The
reachable mechanism on a platform org is `POST /pause`, which S06 proved is
enforced there and refused on every paid plan.

Artifacts (local, gitignored): `pause-wake-results.tsv`, `awake-vs-paused.tsv`,
`sweep-awake.tsv`, `park-clock3.tsv`.

- `POST /pause` `200`; `INACTIVE` after **71 s**. Data plane while parked:
  **`HTTP 540` in 0.42 s**, edge-served (matches I04's 540 on a free project,
  now also on a platform org and a second control plane).
- **All 52 parameter-free GETs: `no-wake`.** Called one at a time against the
  paused project, re-reading status from the ORG-scoped listing after each, so
  the instrument stays outside the set under test. No Management API read
  restarts a parked project's compute.
- 16 endpoints change status when parked. `544` carries `"Connection terminated
  due to connection timeout"` and costs the caller the full timeout -
  `/database/migrations` **20.0 s**. Seven answer `500` for what is an expected
  project state. `/health` gives `400 "No active services available"`,
  `/postgrest` gives `404 "Postgres config not found"`.
- **Four endpoints answer `200` with an empty result** rather than an error, so
  a status-code check cannot distinguish "nothing to report" from "could not
  look": `/api-keys` `[]`, `/advisors/security` `{"lints":[]}`,
  `/advisors/performance` `{"lints":[]}`, `/config/database/pooler` `[]`.
  Re-fetched against the still-`INACTIVE` project to confirm the bodies rather
  than inferring from response size. A fleet-wide advisor sweep would score
  every parked tenant as clean.
- `/restore` inverts correctly: `400 "not in a paused state"` healthy, `200`
  parked.
- **Control arm**: a second nano project parked in total silence (zero
  project-scoped calls after setup) stayed `ACTIVE_HEALTHY` throughout, which
  rules out "our own polling kept it awake" as the reason nothing hibernated.
- `project_hibernating` != `INACTIVE`: `upgrade/eligibility` read
  `validation_errors: []` while the project was `PAUSING`. The two mechanisms
  are distinct in the control plane's vocabulary, and eligibility cannot detect
  a pause.

Open: the project-scoped write operations, and the hibernation path, which
needs a project parked for days with zero query activity rather than more
wall-clock inside one session.

## 2026-09-09 - pause/restore timing, and the write surface

### Manual pause/restore timing (platform-plan nano, STAGING control plane)

Three pause cycles and two restore cycles on one project. n=1 is not a number
worth quoting, and the first cycle is why.

| op | seconds | state path |
|---|---|---|
| pause | 63, 69, 71 | `PAUSING -> INACTIVE` |
| restore | 168, 172 | `COMING_UP -> RESTORING -> ACTIVE_HEALTHY` |

Consistent with `instance-sizing` I04's 162-204 s free-org wake, now on a
platform org and a second control plane.

**Pause immediately after a restore is refused.** Cycle 1 issued `POST /pause`
the moment the org listing first reported `ACTIVE_HEALTHY` and got `400`; the
project stayed healthy. There is a settle period after restore before a pause
is accepted, so a platform that restores and re-parks on demand needs to
tolerate that 400 rather than treating it as a failure.

### The write surface does not wake a parked project either

Every operation in the published document that the parameter-free GET pass did
not cover, run against the same project once parked: **73 exercised, zero
wakers.** Every one left the project `INACTIVE`. Combined with the 52 reads,
no Management API operation restarts a parked project's compute.

The claim deliberately EXCLUDES `POST /pause` and `POST /restore`, which were
not in the swept set because they change project state by definition.

The candidates that looked most likely, measured:

| op | paused response | woke it |
|---|---|---|
| `POST /database/query` | `544` in 15.8 s | no |
| `POST /database/query/read-only` | `544` in 20.4 s | no |
| `POST /restart` | `500` in 3.6 s | no |
| `POST /database/migrations` | `544` in 15.7 s | no |
| `POST /database/webhooks/enable` | `544` in 15.5 s | no |

24 operations SKIPPED, and the reason is a finding rather than a defect: the
parameterised routes need an id from a list endpoint, and while parked those
list endpoints are the ones answering `544`/`500`. Captures have to be taken
while the project is AWAKE and carried into the paused pass. More staging time
does not fix it.

### Harness gotchas this run paid for

- **Cloudflare answers a non-browser User-Agent with `403` and a bare-text
  body `error code: 1010`.** The first full write pass was 71 of those and read
  exactly like an API scope refusal - nothing was tested. Any client here needs
  a real User-Agent. This is the same class of problem `mgmt.ts`'s
  `classifyBody` exists for, except the body is plain text rather than HTML, so
  it does not classify as `throttled`.
- **An org-scoped PAT is not a user-scoped PAT.** `GET /v1/profile` answers
  `403 "This endpoint requires a user-scoped access token"`, and
  `GET /v1/projects` returns `[]` even with live projects in the org. Read the
  project list from `GET /organizations/{slug}/projects`. `GET /v1/snippets`
  answers `500 "Cannot read properties of null (reading 'projects')"` for such
  a token, which looks like a server-side bug rather than an auth boundary.
- **There is no API-observable pause timestamp.** `GET /projects/{ref}` carries
  `status` and `created_at` only; `/actions` is CI action runs, not lifecycle
  events; the org listing adds only `inserted_at`. So the time a project
  auto-paused exists only if something was sampling when it happened - a
  check-back-later reads as a binary, never a threshold. Any future run of the
  hibernation arm has to install a sampler FIRST.

Still open: port both sweeps into the modules and run them (the numbers above
came from throwaway scripts, and Z01 compiles but has never executed), a
`.pi/probe-s2z-wake.sh` acceptance probe, and an operation count that
reconciles against the document's own 169.

### The pause path is unreachable by construction (same day, after the above)

Prompted by the right question: did nothing wake it only because we paused it
ourselves? Measured - a paused project has NO public DNS record. Two
independent public resolvers, same org, same moment: both `INACTIVE` projects
NXDOMAIN on `<ref>.<suffix>` and on `db.<ref>.<suffix>`, while the
`ACTIVE_HEALTHY` one resolved to two Cloudflare edge addresses.

So the wake path for a hibernated project (traffic to the project URL) cannot
exist on a paused one. The sweep result is real about the CONTROL plane - those
125 calls were delivered and did not restart compute - and says nothing about a
hibernated project, which keeps its DNS and is designed to look healthy.

Also corrects the `HTTP 540` reading recorded earlier today: 540 was measured
seconds after the pause completed, with DNS still live or locally cached. At 13
and 50 minutes parked the answer is NXDOMAIN.

Consequence for the hibernation arm: install the sampler BEFORE the idle window
opens. A durable 15-minute sampler now runs outside the repo
(`~/.local/share/s2z-wake/`, a systemd user timer) reading org-scoped metadata
only, because a tenant query would reset the very clock being measured.

## 2026-09-09 - Z01 executed for the first time; it reproduced the result and found two bugs in itself

`.pi/probe-s2z-wake.sh Z01` against the platform-plan org on the staging
control plane. The module reproduced the headline independently of the
throwaway scripts that first produced it: **`wakers=0`, all 52 reads left the
project `INACTIVE`.**

It also failed its own Z01e assertion, correctly:

- **The silent-degrader detector was wrong.** It flagged any `200` with a body
  under 14 bytes while parked, and reported eight "new" degraders: `/actions`,
  `/branches`, `/functions`, `/secrets`, `/config/database/postgres`,
  `/config/auth/third-party-auth`, `/database/jit/list` and
  `/analytics/endpoints/usage.api-counts`. All eight are legitimately empty on a
  fresh project, awake or parked. Fixed to compare the awake and parked passes
  on the same project.
- **`/advisors/security` was in the expected set for the same bad reason.** A
  fresh project has no security lints, so it reads `{"lints":[]}` awake AND
  parked, and this experiment could never have distinguished "no findings" from
  "could not look". Removed; the genuine set is three:
  `/api-keys` (1524 B -> `[]`), `/advisors/performance` (763 B ->
  `{"lints":[]}`), `/config/database/pooler` (574 B -> `[]`).
- Z01 now seeds a real advisor finding (a public table with RLS disabled)
  before the awake pass, so the advisors endpoints have content to lose, and
  records the seed's status so a null result stays interpretable.

Timing from this run widens the earlier distribution: pause **53 s** (previous
range 63-71), restore **222 s** (previous 168-172). So pause is ~50-70 s and
restore ~170-220 s, n=4 and n=3.

Runtime note for anyone running the probe: Z01 takes ~35 minutes. The parked
sweep pays a 15-20 s connection timeout on each `544` endpoint plus a 5 s
settle per endpoint, and the restore alone is ~3 minutes.

## HOW TO RESUME (written 2026-09-09 for a check-back ~2026-09-14)

Two fleets are parked and two systemd user timers are sampling them. Nothing in
this repo records the project refs - they are account identifiers and the
identifiers test scans for that shape - so the state lives outside it:

```
~/.local/share/s2z-wake/
  status.tsv          15-min status samples, both orgs (env column: green | prod-free)
  fleet-sfp.tsv       the 12-project auto-pause fleet: candidate -> ref
  hib-ladder.tsv      hibernation ladder results (idle rung, TTFB, validation_errors)
  hib-ladder.state    which rung is next
  sample-status.sh    the sampler
  hib-ladder.sh       the ladder
```

Timers: `systemctl --user list-timers 's2z-*'`.

### 1. Did the SfP fleet auto-pause?

```
awk -F'\t' '$2=="green" && $5=="INACTIVE"' ~/.local/share/s2z-wake/status.tsv | head
```

The fleet's clock started 2026-09-09T08:50Z. Do not predict the parking date -
read `status.tsv`, which is the only thing that pins it, because there is NO
API-observable pause timestamp and the moment is unrecoverable if the sampler
was not running. For scale: Supabase's public pricing page puts free-project
auto-pause at a week of inactivity, so budget days rather than hours before
checking.

If every fleet project is `INACTIVE`, run the wake matrix:

```
secretctl exec keyfile:~/.supabase/green-access-token --as SUPABASE_ACCESS_TOKEN -- \
  env PVLAB_ORG_SLUGS=<green org slug> \
      SUPABASE_MGMT_BASE_URL=https://api.supabase.green/v1 \
      SUPABASE_API_HOST_SUFFIX=supabase.red \
      PVLAB_S2Z_FLEET_FILE=$HOME/.local/share/s2z-wake/fleet-sfp.tsv \
      ./harness/dist/pvlab --where local --experiment s2z-wake --only Z04 --destructive --out out/
```

Z04 refuses to fire unless ALL 12 are parked, checks whether an auto-paused
project still resolves DNS (Z04b - a manually paused one does not), fires one
candidate per project, and DISCARDS the run if the `control` project woke
without being fired at.

### 2. Did the free project hibernate?

`hib-ladder.tsv` is the answer. Awake baseline is 0.04-0.11 s TTFB; a rung with
a multi-second TTFB is a wake, and the window sits between that rung and the
one before it. `validation_errors` containing `project_hibernating` names the
state directly. All rungs at baseline latency means hibernation is not enabled
for that account, NOT that there is no window.

### 3. Teardown

```
systemctl --user disable --now s2z-wake-sample.timer s2z-hib-ladder.timer
rm -rf ~/.local/share/s2z-wake ~/.config/systemd/user/s2z-*.{timer,service}
```

Then delete the projects: 12 `z04-*` plus `s2z-wake-*` / `s2z-writes-*` on the
staging org, and `hib-ladder` / `hib-control` on the production free org. A
paused project must be restored before `DELETE` is accepted.

### Open questions, in priority order

1. Does an auto-paused project differ from a manually paused one? Z04b answers
   it in one read (DNS resolving or not).
2. Does anything wake an auto-paused project? Z04c, 12 candidates in parallel.
3. Is hibernation reachable on any account we control? The ladder answers it, or
   returns a null that means "not enabled here".
4. Z02 has never been executed. The write-surface numbers in the README came
   from a throwaway script; the module has to reproduce them before they are
   reproducible by anyone else.
