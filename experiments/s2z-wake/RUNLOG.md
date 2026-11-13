# s2z-wake RUNLOG

Chronological record of what was actually run. Project refs and org slugs are
not recorded here (the repo is public and `identifiers.test.ts` scans for the
shape); the org class is.

## 2026-09-09 - hibernation ladder and its control parked (free-plan org)

The cost question: a Management API call that wakes a scaled-to-zero project
starts billing compute, so a platform's own polling could be generating its
tenants' compute bills. This arm tries to reach that state.

- **The hibernation observable, found in the spec rather than by probing**:
  `ProjectUpgradeEligibilityResponse.validation_errors[].type` carries the enum
  value `project_hibernating` among ten blockers, so the presence of that type
  is a control-plane hibernation signal that needs no data-plane round trip.
  `RealtimeConfigResponse.suspend` is unrelated - it is a Realtime disable
  toggle.
- Two nano projects created on a free-plan org: `hib-ladder`, probed at
  doubling idle rungs, and `hib-control`, which nothing touched after its
  create call. The ladder's procedure, state and first four rungs are in HOW TO
  RESUME below.

<!-- Append new runs below: date, org class, module ids, artifact path. -->

## 2026-09-23 - the check-back, 13 days in

### Both free-plan projects auto-paused

The ladder project and its control were read back 13 days after they were
parked. **Both went `INACTIVE` on their own** - including the control, which
nothing touched after its create call.

So the auto-pause arm (Z03/Z04) can run on free-plan projects, within the
2-active-project cap per free org - which means either one candidate per org
across several orgs, or a much smaller candidate set.

### Auto-pause tears the DNS record down

Measured on the two projects that auto-paused, against 1.1.1.1 and 8.8.8.8
independently: **`status: NXDOMAIN`, zero A records, and `db.<ref>` absent
too**, while a healthy sibling project resolved to two edge addresses.

The control project carries this result: it was never touched after creation,
so nothing in the harness put it there.

The four data-plane candidates in Z04 are moot on such a project because there
is no hostname left to send traffic to.

### The hibernation ladder is finished, not stalled

Four rungs ran (to 2 hours idle) before the timer died with the host, all
sub-second with no `project_hibernating`. Its subject has since auto-paused, so
the remaining rungs cannot run - a probe now reaches NXDOMAIN rather than a
hibernating instance. Final reading from that arm: no hibernation up to two
hours, then the project auto-paused instead.

**Hibernation was never reachable on any account available here.** That is the
honest end state of the original question, not a pending result.

## HOW TO RESUME (written 2026-09-09 for a check-back ~2026-09-14)

The ladder project and its control are parked. Nothing in this repo records the
project refs - they are account identifiers and the identifiers test scans for
that shape - so the state lives outside it:

```
~/.local/share/s2z-wake/
  hib-ladder.tsv      hibernation ladder results (idle rung, TTFB, validation_errors)
  hib-ladder.state    which rung is next
  hib-ladder.key      the ladder project's publishable key
  hib-ladder.sh       the ladder
```

**Nothing runs in the background, and nothing should.** The ladder ran from a
systemd user timer on 2026-09-09, and the host is a workstation that gets shut
down: the timer died with the box overnight after four rungs.

The reason no daemon is needed: **the inactivity clock runs on the platform's
side whether this machine is on or not.** Projects accumulate idleness on their
own. So the remaining questions are on-demand - park, walk away, come back,
run one command. `Z04` checks fleet readiness itself, and the ladder records
`actual_idle_s` separately from the intended rung, so a probe fired late is
still a valid "idle for X, TTFB was Y" reading. Coarser rung spacing is the
only cost, and the remaining rungs are hours long anyway.

Do not reinstate a timer here.

### 1. Did the free project hibernate?

`hib-ladder.tsv` is the answer, read with the noise floor in mind. The awake
baseline is 0.04-0.11 s TTFB, but sub-second spikes around 0.65 s occur on a
project known to be warm - measured 2026-09-09, a warm repeat came back
0.656 s while forced new TCP+TLS connections ran 0.048-0.056 s, so a spike that
size is neither a wake nor connection setup. The wake threshold is therefore
**over 3 s on the first sample of a rung**, not "elevated over baseline": the
first version of this check would have reported noise as a finding at every
rung.

Only the FIRST sample of a rung can show a wake; the two that follow are noise
context. `validation_errors` containing `project_hibernating` names the state
directly and is the stronger signal when present. All rungs at baseline latency
mean hibernation is not enabled for that account, NOT that there is no window.

#### Measured so far: no hibernation up to 2 hours idle

Four rungs ran on 2026-09-09 before the timer died with the host. Free-plan
nano project, `validation_errors: none` on every rung:

| idle | first sample | ctx2 | ctx3 |
|---|---|---|---|
| 15 min | 0.634 s | - | - |
| 32 min | 0.447 s | 0.047 s | 0.082 s |
| 64 min | 0.524 s | 0.078 s | 0.060 s |
| 122 min | 0.763 s | 0.068 s | 0.062 s |

Every first sample is sub-second, nowhere near a reclaim-and-reattach, and
`project_hibernating` never appeared. **No hibernation up to ~2 hours of
idleness on that account.**

The three-sample design paid for itself. There is a consistent 0.45-0.76 s
penalty on the first request after idle against 0.05-0.08 s on the follow-ups,
and it does NOT scale with idle length - 122 min looks like 32 min - so it is a
routing or connection effect rather than compute starting. The original
"elevated over baseline" threshold would have called all four rungs a wake.

Remaining rungs are 4h, 8h, 16h, 24h, 48h. Run `hib-ladder.sh` by hand when
convenient; it reads its own state file and only probes when the next rung is
due.

### 2. Teardown

```
rm -rf ~/.local/share/s2z-wake
```

Then delete `hib-ladder` and `hib-control` on the free org. A paused project
must be restored before `DELETE` is accepted.

### Open questions, in priority order

1. Does an auto-paused project differ from a manually paused one? Z04b answers
   it in one read (DNS resolving or not).
2. Does anything wake an auto-paused project? Z04c, 12 candidates in parallel.
3. Is hibernation reachable on any account we control? The ladder answers it, or
   returns a null that means "not enabled here".
4. Z02 has never been executed.

## 2026-09-23 - the boundary this experiment did not cross, stated plainly

Everything in this experiment measures a PAUSED project, manual or automatic.
Scale-to-zero is a DIFFERENT mechanism, and this experiment never reached it,
so nothing here describes how a project in that state behaves.

The distinction matters for how far any null result on the pause path travels.
An auto-paused project has no DNS record, so traffic has nowhere to arrive; a
result read there does not automatically carry to a state that keeps its
hostname. Anyone extending this work should treat the two as separate
questions rather than assuming the paused answer generalises.

NOT MEASURED HERE, recorded so the next run does not re-derive it:

- Whether control-plane reads wake a project in the scale-to-zero state. That
  state was never reachable on any account available.
- Storage accounting while a project is in that state. This lab has no access
  to the hourly usage export and measured nothing about it.
- The idle window before it triggers. Four ladder rungs to two hours of
  idleness on a free-plan nano project saw no transition and no
  `project_hibernating`, so either the window exceeds two hours or the
  mechanism was not enabled on that account. Unresolved.

Reaching any of it needs an account where the mechanism is demonstrably
enabled, which is the prerequisite to establish first.

### Measured: there is no control-plane route for object storage size

`GET /v1/projects/{ref}/storage/buckets` lists buckets and carries
`created_at, id, name, owner, public, updated_at` - no size field - and no
other operation in the 169 exposes object storage size. Per-project bucket size
is therefore reachable only by listing objects and summing (usage-metering M01d
measured that exact to the byte) or from the hourly export. A parity gap with
the dashboard, which shows the figure directly.

Two routes a caller may expect do not exist at all: `/v1/projects/{ref}/quota`
and `/v1/projects/quota/active` are absent from the document, as is any `/v2`
namespace. Checked 2026-09-23.

## 2026-10-13 - Z01 on a free-plan org after the explicit grant (#128)

Task 20 of `docs/plans/2026-10-13-lab-backlog-waves.md` appended `grant
select, insert, update, delete on table public.z01_rls_off to anon,
authenticated, service_role` to the advisor seed. One run, local vantage, run
from source (harness unchanged since 080124a; the artifact stamps 10b97a7, a
docs-only commit that landed mid-run), free-plan org, ap-southeast-1.
Free-plan because a Pro org cannot pause (`400 Project is not free-tier`,
restore-paths key facts in AGENTS.md), so Z01c-Z01e need a pausable plan.
Project provisioned and deleted by the module.
Artifact (private, no `publish-evidence` target):
`evidence/20261013-115101/run-2026-10-13T03-51-01-878Z.json`.

| Probe | 2026-10-13 |
|---|---|
| Z01a | pass, healthy at the first status read, `nano` |
| Z01b | 52 endpoints, 43 answered 200, 9 non-2xx; advisor seed (create table + grant) 201 |
| Z01c | pause 200, `INACTIVE` in 62 s via PAUSING; data plane 540 |
| Z01d | no waker: all 52 reads left the project `INACTIVE`; 16 changed status code vs awake |
| Z01e | FAIL: 4 silent degraders, 1 unexpected: `/advisors/security` |
| Z01f | restore 200, healthy in 181 s via COMING_UP, RESTORING |

The seed did what it was added for: `/advisors/security` answered
200 with 618 bytes awake and 200 with 12 bytes (`{"lints":[]}` size) parked, so
the security advisor now has a finding to lose. `SILENT_DEGRADERS` in
`lib/surface.ts` still lists the three endpoints from before the seed existed,
so Z01e reports the fourth as new. This is the first recorded module run since
the seed was added. The other three degraders: `/api-keys` 1524
-> 2 bytes, `/config/database/pooler` 568 -> 2, `/advisors/performance` 590 ->
12. No Data API request touches `z01_rls_off`; the grant's evidence is the
seed's 201 and the advisor finding it produced.

## 2026-10-23 - `/advisors/security` added to the expected degraders (#174)

Code change only, no new run. `SILENT_DEGRADERS` in `lib/surface.ts` now lists
four endpoints: the three it already listed plus `/advisors/security`, all four
read on the 2026-10-13 run above (`/advisors/security`: 200 with 618 bytes
awake, 200 with 12 bytes parked).
Expected, not run: given the same readings, the next Z01 run passes Z01e with
four known degraders, and a fifth endpoint still fails it as new. The
2026-10-13 FAIL stays recorded as measured; its cause was the stale expected
list in the module.
