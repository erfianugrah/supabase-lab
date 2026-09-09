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

The runs recorded here use a free-plan org. The pause path needs a project the
API will pause, and a Pro org refuses (`400 Project is not free-tier`,
restore-paths key facts in AGENTS.md).

Sibling context: `sfp-platforms` measured what the platform plan *unlocks* and
established that the SfP-path create (no `desired_instance_size`) lands on
`nano`; `instance-sizing` I04 timed the *pause/restore* cycle (wake 162-204 s,
data API `HTTP 540` while parked). Neither touches scale-to-zero, which is a
different mechanism from pause and restore - the control plane models it as its
own state, `project_hibernating` (see the observable below).

## Method

Enumerated from the published OpenAPI document (2026-09-09) rather than
guessed, per the F05 method note in `platform-facts`: a negative result ("the
API cannot X") is only worth stating across the complete operation set. 169
operations total, 143 project-scoped, 52 of them GETs whose only path parameter
is `{ref}` and so callable with no extra setup. Those 52 are the read surface a
polling platform would plausibly hit, and they are what this experiment
measures first.

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
one-row probe table. The awake baseline on the free-plan ladder project was
0.04-0.11 s TTFB (RUNLOG, hibernation ladder).

## Status - CLOSED 2026-09-23, Z01 run 2026-10-13

Pause-path wake matrix, reads: DONE (Z01, 2026-10-13), 52 GETs, zero wakers.
Pause-path wake matrix, writes: Z02 is built and has never run.
Auto-pause: DONE - two free-plan projects auto-paused within 13 days and lost
their public DNS record (NXDOMAIN).
Scale-to-zero (hibernation) path: UNREACHABLE on any account available here,
and that is the end state rather than a pending result. See "Why the
hibernation arm closed" at the end.

The auto-pause fan-out (Z03/Z04) is built and has never fired. Z04 is usable
against free-plan projects; see "Running it" for the 2-active-project cap per
free org.

The plane classification in the working `MGMT-API-WAKE-MATRIX.md` was a
hypothesis about which handlers reach the instance. Z01 falsified its
usefulness as a wake predictor: 16 endpoints changed status code while the
project was parked and none woke it, so "touches Postgres" predicts an error
code, not a billing event.

## Measured: no Management API GET wakes a paused project (Z01, 2026-10-13)

One run, free-plan org, ap-southeast-1, local vantage. The project came up
healthy at the first status read on `nano` (Z01a), was swept awake (Z01b: 43 of
the 52 reads answered `200`, 9 non-2xx), then paused.

`POST /pause` -> `200`, `INACTIVE` in **62 s** via `PAUSING`. The data plane
answered `HTTP 540` while parked.

**All 52 parameter-free GETs were then called against the paused project, one at
a time, re-reading the project status after each. None woke it.** 16 answered a
different status code from the awake pass. The instrument is the ORG-scoped
project listing, so the observable sits outside the set under test.

`POST /restore` -> `200`, healthy in **181 s** via `COMING_UP`, `RESTORING`.

So a platform's control-plane polling does not restart a PARKED tenant's
compute. The endpoints that need the instance fail; they do not wake it.

Read the scope carefully: this is the manual-pause path. Whether the same holds
in the scale-to-zero state is NOT answered here - that is a different mechanism
and this experiment never reached it.

Scope: GETs only. The 91 project-scoped write operations are untested (Z02 has
never run), and `POST /restore` wakes a project by definition.

### Four reads answer 200 with an empty body while parked

They answered `200` with CONTENT while awake and `200` with a body the size of
an empty result while parked, so a caller that checks the status code cannot
tell "nothing to report" from "could not look".

| endpoint | awake | parked | what a naive caller concludes |
|---|---|---|---|
| `/api-keys` | `200`, 1524 B | `200`, 2 B (`[]` size) | this project has no API keys |
| `/advisors/performance` | `200`, 590 B | `200`, 12 B (`{"lints":[]}` size) | no performance findings |
| `/advisors/security` | `200`, 618 B | `200`, 12 B (`{"lints":[]}` size) | no security findings |
| `/config/database/pooler` | `200`, 568 B | `200`, 2 B (`[]` size) | no pooler configured |

So a fleet-wide advisor sweep across a platform's tenants scores every parked
project as clean.

The awake-vs-parked comparison is what makes this a finding rather than an
artefact. Several endpoints answer `[]` on a fresh project whether it is parked
or not, so Z01e compares the two passes on the same project rather than
thresholding a response size. Z01 also seeds a real advisor finding (a public
table with RLS disabled and an explicit grant to `anon`, `authenticated` and
`service_role`) before the awake pass, so the advisors endpoints have
something to lose. `SILENT_DEGRADERS` in `lib/surface.ts` lists the four, so a
fifth fails Z01e as new.

## Measured: auto-pause lands in INACTIVE with no DNS record (2026-09-23)

Two free-plan nano projects were created on 2026-09-09: `hib-ladder`, the
hibernation ladder's subject, and `hib-control`, which nothing touched after
its create call. By 2026-09-23 both were `INACTIVE` on their own.

Measured against two independent public resolvers (1.1.1.1 and 8.8.8.8, to
rule out local caching):

| project state | `<ref>.<suffix>` |
|---|---|
| `INACTIVE` after auto-pause (two projects) | **NXDOMAIN**, zero A records |
| `ACTIVE_HEALTHY` (a healthy sibling) | resolves (two edge addresses) |

`db.<ref>.<suffix>` is absent for both auto-paused projects too. The control
project carries this result: nothing in the harness put it there.

## Limitation: an auto-paused project is unreachable by construction

The wake path for a HIBERNATED project is traffic to the project URL, and on an
auto-paused project that URL does not exist, so no amount of traffic could
wake it. The Z01 result is narrower than it first appears:

- **Holds:** the Management API reaches the CONTROL plane, not the project
  hostname, so those calls were genuinely delivered and genuinely did not
  restart compute. That is a real result about the control plane.
- **Does not transfer:** anything about the scale-to-zero state, which is a
  different mechanism and was never reached here. Pausing cannot be used to
  stand in for it.

The hibernation arm is the only way to close this, and it needs a project
parked for days with zero query activity plus a sampler installed BEFORE the
window opens. No field in the project or org-listing responses records when a
project paused (OpenAPI document, checked 2026-11-13), so the moment cannot be
recovered afterwards.

## Why the hibernation arm closed (2026-09-23)

The original question was whether a Management API call wakes a scaled-to-zero
project and restarts billing. It is answered for every mechanism that could be
reached, and the one that could not is named rather than left open.

| mechanism | reachable here | wake result |
|---|---|---|
| manual `POST /pause` | yes, free plan | no Management API GET wakes it (52 tested, Z01 2026-10-13) |
| auto-pause after inactivity | yes, free plan | lands in `INACTIVE` with the DNS record gone (NXDOMAIN), so no traffic can reach it |
| hibernation / scale-to-zero | **no** | never observed on any account available |

Supabase's public pricing page puts free-project auto-pause at a week of
inactivity, so no window closes inside a session, and the lab's own setup
(creating a probe table, selecting from it) is itself query activity that
restarts the clock.

Hibernation is the one that got away. Four ladder rungs on a free-plan nano
project (to 2 hours idle) showed no elevated first-request latency and no
`project_hibernating`, and the subject then auto-paused instead, which ends
that arm - a probe against a parked project reaches NXDOMAIN, not a hibernating
instance. Whether hibernation is enabled at all on these accounts was never
established.

Practical answer for a platform operator, which is what the question was for:
control-plane polling does not restart a parked tenant's compute. The cost
risk, if it exists, is on the data plane - and on an auto-paused project even
that is moot, because the hostname is gone.

## Running it

From the repo root, against a free-plan org with a free project slot (a free
org allows two active projects), with `SUPABASE_ACCESS_TOKEN` exported:

```
PVLAB_ORG_SLUGS=<free-plan org slug> \
  bun harness/src/run.ts --where local --experiment s2z-wake --only Z01 --destructive --out out/
```

Z01 creates one project in ap-southeast-1 (no `desired_instance_size`), pauses
it, sweeps the 52 reads with a 5 s settle after each, restores it and deletes
it in `finally`. Budget for the pause and the restore on top of the sweep (62 s
and 181 s on 2026-10-13).

Z02 runs the same way with `--only Z02`. `PVLAB_S2Z_TERMINAL=1` adds the
operations flagged `terminal` in `lib/write-ops.ts` (upgrade, disk resize,
addon apply, password rotate), which are billable or project-ending; leave it
unset on any org that matters.

Z03 and Z04 are the auto-pause fan-out. Z03 (`PVLAB_S2Z_PROVISION=1`) creates
one untouched project per entry in `CANDIDATES` (`lib/wake-candidates.ts`, 12
today) in the first org of `PVLAB_ORG_SLUGS`, and writes the manifest outside
the repo to `PVLAB_S2Z_FLEET_FILE` (default
`~/.local/share/s2z-wake/fleet.tsv`). Z04 reads that manifest, refuses to fire
unless every fleet project is `INACTIVE` (Z04a), records whether each still
resolves DNS (Z04b), fires one candidate per project, and DISCARDS the run if
the `control` project woke without being fired at. Both modules read one org,
so under the 2-active-project cap of a free org the fleet has to shrink to the
`control` plus one candidate, or the modules have to learn to spread it across
orgs.
