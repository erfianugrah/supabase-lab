# RUNLOG - experiments/compute-disk

One project per module, self-provisioning (no tofu), Pro/Team/Free orgs.
Reference: COMPUTE-DISK.md at repo root. Probes: `.pi/probe-compute-disk.sh D01[,...]`. D10 runs directly:
`PVLAB_ORG_PRO=<slug> pvlab --where local --experiment compute-disk --only D10 --destructive`.

## Findings, by module

- D01 (pg_limits micro vs small): resize settled 107 s. micro/max_connections
  60, small 90; slots 10/10, senders 10/10; shared_buffers 256/512 MB.
- D02 (disk semantics): decrease rejected HTTP 400; increase accepted 201.
- D03 (quota): 429 "Database disk can only be modified once per four hours.
  Last modified at ..." - the doc's "4 per rolling 24h" and runtime disagree;
  enforcement appeared nondeterministic across runs (a first 5-mod burst was
  accepted, before and after).
- D04 (autoscale surface, Pro): GET answers 200 with all three fields null;
  PUT/POST/PATCH 404 - no public mutation surface.
- D05 (free-org disk): baseline 2GB (docs claim 1GB); disk did not grow
  during a 726MB db fill.
- D06 (free read-only): kicked at ~726MB (docs claim 500MB) with
  `ERROR: 25006: cannot execute INSERT in a read-only transaction`. SELECT
  still answers on the management query endpoint (201).
- D06b (recovery): TRUNCATE rejected in read-only; DELETE+vacuum needed.
- D07 (autoscale surface, Team): identical gap to D04.
- D08 (IOPS/throughput gate): POST config/disk accepted AND verified applied
  on Micro (the dashboard's "LARGE required" text is a UI gate only).
- D09 (resize up/down, local vantage, 2026-10-23 module, n=1): every resize
  took all three data paths down for 144.528 to 254.886 s. Longest `rest_read`
  outage 231.465 s Micro -> Small, 223.28 s Small -> Large, 152.466 s
  Large -> Small, 254.886 s Small -> Micro; `auth_health` and `realtime_join`
  within 10 s of it in each op. The project read `ACTIVE_HEALTHY` about 18 to 35 s
  before REST recovered. The 2026-08-19 figures that stood here (1.0 s,
  17.0 s, 0 s, 0 s; 61 s for two ops) came from the accounting defect and
  from refused PATCHes: see the 2026-10-23 entry. Adjacent resize PATCHes are
  rate-limited: 429 `We are still processing addon changes, please try again
  in N minute(s)`.
- D10 (paid fill, 2026-10-01): Pro starts on 2 GB; a 1.90x burst did not trip
  read-only; autoscale at 90% went 2 -> 8 GB, then 8 -> 12 GB; read-only at
  95% measured with automatic return after the grow; with the manual quota
  spent a fast burst hit `53100` disk full and a 7 min outage in one run of
  two, read-only in the other. See the
  2026-10-01 entry.
- D11 (grow steps, 2026-10-01): from 2 GB, 4 and 5 GB rejected on the gp3
  IOPS floor, 6 GB accepted.
- D12 (spend cap vs manual grow, 2026-10-05): with the spend cap ON, a fresh
  Pro project's single manual `POST /config/disk` 2 -> 12 GB answered 201
  and was applied. The cap is a billing control and did not act at resize
  time.

## Operational notes

- The free-org module borders on the util endpoint: selects return 200, so
  `/config/disk/util` is available on free (check D05 measurements).
- Probe mapping: result ids D01..D09 live in modules D01, D02, D04, D05, D08
  - the probe maps result->module before passing --only.
- The first fill round ran a 5-mod disk increase burst without triggering
  the quota; the second round caught the cooldown on the second attempt.
  Recorded as nondeterministic, not a clean pass/fail.

## 2026-10-23 - D09 outage accounting fixed; a resize is minutes down, not seconds (#175)

The 2026-10-13 entry below found that D09 dropped an outage still open when a
phase ended and timed refused PATCHes as resizes. This entry fixes the module,
re-reads both earlier runs with the fixed accounting, and re-runs D09 once.

What changed in the module (`tests/d09-compute-resize-timing.ts`,
`lib/outage.ts`):

- One sample timeline per path for the whole run. An outage (first failing
  sample to the first success after it) belongs to the phase it started in, at
  full length, even when it runs into a later phase; the later phase reports
  that time as `carried_in_s`. An outage still open when sampling stops is
  closed at the stop and flagged `outage_open_at_end`. `lib/outage.test.ts`
  rebuilds the 2026-10-13 sample counts as a synthetic stream: the old
  per-phase accumulator gives 0 and 15.063 s on it, the timeline gives one
  49.813 s outage on Micro -> Small and 0 s plus 15.063 s carried in on the
  next phase (the synthetic sample times, not the run's, set the 49.813 s).
- A PATCH answered `429 ... try again in N minute(s)` is retried after N
  minutes, and a phase starts only at an accepted PATCH
  (`<op>_addon_429_retries`). After `ACTIVE_HEALTHY` the module waits until
  every path has been up for 15 s before the next PATCH.
- Probes: `rest_read` and `realtime_join` from `harness/src/real-probes.ts`
  (#204) replace the old `dpython_probe` read; `auth_health` is
  `GET /auth/v1/health` WITH the anon key. The old module sent that request
  with no key. On 2026-10-23 the endpoint answered `401` without a key
  (`auth_health_noapikey_status`), and only `200` counted as up.

### Re-read of the 2026-08-19 and 2026-10-13 runs (offline)

The old module kept, per phase, the OK samples, the total and the longest
outage that a later success closed. A closed outage of d seconds holds at most
d / 0.25 failures (sample starts are at least 250 ms apart), and there are at
most as many closed outages as successes, so any failures beyond that were
still open when the phase ended (`openTailLowerBound` in `lib/outage.ts`,
tested). The 2026-10-13 artifact is published at
`out/2026-10-13/run-2026-10-13T03-46-20-408Z.json`; it holds an uptime
percentage, not counts or PATCH statuses, so the PATCH statuses and OK/total
counts below are from the runs' console output. The 2026-08-19 artifact was
written to a temporary directory and is lost. Neither console output is
committed.

| Run | Op | PATCH | Old `_s` | Old REST max | REST OK | Re-read |
|---|---|---|---|---|---|---|
| 2026-08-19 | micro -> small | accepted | 105 | 1.0 s | 6 of 69 | at least 39 failures open at the phase end, at least 9.5 s |
| 2026-08-19 | small -> large | 429 "... 2 minute(s)" | 61 | 17.0 s | 130 of 154 | no resize ran; 61 s is the 60 s status wait |
| 2026-08-19 | large -> small | 429 "... 1 minute(s)" | 61 | 0 | 245 of 245 | no resize ran |
| 2026-08-19 | small -> micro | accepted | 73 | 0 | 12 of 51 | 39 failures open when sampling stopped, at least 9.5 s, end not observed |
| 2026-10-13 | micro -> small | accepted | 39 | 0 | 17 of 46 | 29 failures open at the phase end, at least 7.0 s |
| 2026-10-13 | small -> large | 429 "... 3 minute(s)" | 61 | 15.063 s | 175 of 195 | no resize ran |
| 2026-10-13 | large -> small | 429 "... 2 minute(s)" | 61 | 0 | 244 of 244 | no resize ran |
| 2026-10-13 | small -> micro | 429 "... 1 minute(s)" | 63 | 0 | 250 of 250 | no resize ran |

Reading (inference from the aggregates, not a sample-level measurement):

- The 17.0 s (2026-08-19) and 15.063 s (2026-10-13) outages sat in phases whose
  PATCH was refused, right after a Micro -> Small phase that ended mid-outage.
  Read as the tail of the Micro -> Small outage, that outage was one window of
  at least 26.5 s on 2026-08-19 (9.5 + 17.0; the aggregates cap it at 121 s)
  and between 22.063 and 50.313 s on 2026-10-13 (7.0 + 15.063 at the least;
  the open tail started no earlier than the 18th sample, 4.25 s in, and ended
  by the phase end under 39.5 s, so at most 35.25 s). This assumes the refused
  phase opened on a failing sample, which the aggregates do not show.
- No Small -> Large resize ran in either run, so neither run measured one.
  The "61 s" figures are the module's 60 s wait for a status change that a
  refused PATCH never causes.
- The 2026-08-19 Small -> Micro "0 s" was an outage of at least 9.5 s that
  was still open when the module stopped sampling.
- The old Auth column read 0 s in every op. If `/auth/v1/health` answered `401`
  without a key then as it did on 2026-10-23, no Auth sample ever counted as
  up and no outage was ever closed, so 0 s meant "never closed". Not
  re-checked against those dates.

### Re-run (D09, 2026-10-23)

One run, local vantage, Pro org, `ap-southeast-1`, one throwaway project
created and deleted by the module, run from the working tree on lab commit
661afdf with this entry's module changes. Artifact:
`out/2026-10-23/run-2026-10-23T07-56-13-302Z.json` (facts next to it).
Probe table ready 7 s after seeding; baseline 0 failures on every path (0/39
`rest_read`, 0/40 `auth_health`, 0/10 `realtime_join`). Every PATCH answered
`200` on the first attempt; none of the three follow-on PATCHes was refused,
each sent after the data paths had been up for 15 s (whether that wait is what
avoided the 429 was not separated), and the compute read back as `ci_small`,
`ci_large`, `ci_small`, `ci_micro` in turn.

| Op | `ACTIVE_HEALTHY` after | `rest_read` max outage | `auth_health` max outage | `realtime_join` max outage | `rest_read` recovered | Last failure, any path |
|---|---|---|---|---|---|---|
| upgrade micro -> small | 218 s | 231.465 s | 231.433 s | 228.188 s | 249.832 s | 250 s |
| upgrade small -> large | 216 s | 223.28 s | 223.516 s | 223.421 s | 233.974 s | 234 s |
| downgrade large -> small | 136 s | 152.466 s | 152.375 s | 144.528 s | 171.37 s | 171 s |
| downgrade small -> micro | 245 s | 254.886 s | 254.869 s | 244.941 s | 273.785 s | 274 s |

Times are seconds after the accepted PATCH was sent. `rest_read` and
`auth_health` each had two outages per op, the shorter one 1.3 to 2.0 s
(total minus max); the long one carries the figure above. No outage was open
at a phase end and nothing was carried into the next phase (`carried_in_s` 0
throughout). Failure modes: `HTTP 521` and `timeout` on REST and Auth;
`pg_changes: {:error, "Too many database timeouts"}` and
`timeout at pg_changes` on Realtime.

- A resize in either direction took REST, Auth and Realtime down together for
  between 144.528 and 254.886 s in this run (n=1 per op). Downgrades were not
  free: Small -> Micro was the longest of the four.
- `ACTIVE_HEALTHY` came before the data paths: REST recovered about 32, 18,
  35 and 29 s after the status poll first read healthy (recovered minus the
  whole-second `ACTIVE_HEALTHY` figure, per op; the poll runs every 3 s). The old
  module stopped sampling at that status, which is how its open outages arose.
- platform-downtime's 2026-10-23 data-path re-measure of Micro -> Small saw a
  `rest_read` window of 171 s (first failure to sustained recovery, a
  different metric on a different project); this run's 231.465 s is the same
  order. n=1 each; not a like-for-like comparison.

## 2026-10-13 - D09 re-run after the explicit Data API grant (#128)

Task 20 of `docs/plans/2026-10-13-lab-backlog-waves.md` appended `grant
select, insert, update, delete on table public.dpython_probe to anon,
authenticated, service_role` to the SQL that creates the table D09's REST
sampler reads with the anon key. One run, local vantage, Pro org,
ap-southeast-1, run from source at lab commit 8ec7f86, project provisioned and
deleted by the module. Artifact:
`out/2026-10-13/run-2026-10-13T03-46-20-408Z.json` (published 2026-10-23).

| Op | PATCH | `_s` | REST max outage | REST samples OK | Findings line above |
|---|---|---|---|---|---|
| micro -> small | accepted | 39 | 0 | 17 of 46 (37%) | 105 s, 1.0 s |
| small -> large | 429 "try again in 3 minute(s)" | 61 | 15.063 s | 175 of 195 (89.7%) | 61 s, 17.0 s |
| large -> small | 429 "... 2 minute(s)" | 61 | 0 | 244 of 244 | 61 s, 0 s |
| small -> micro | 429 "... 1 minute(s)" | 63 | 0 | 250 of 250 | 73 s, 0 s |

Auth `/auth/v1/health`: no outage in any op, as before. No 42501: the anon key
read `dpython_probe` on the first 17 samples and on every sample of the last
two ops, and a missing grant would fail every sample.

Only the first PATCH was applied; the other three were refused by the addon
rate limit the findings line already records. For a refused op the module
still records a duration: it waits up to 60 s to see the project leave
`ACTIVE_HEALTHY`, so 61-63 s is that wait, not a resize. The REST outage
accounting has a gap: `PhaseStatsAccumulator` closes an outage only on the
next success, so a run of failures still open when a phase ends is dropped.
17 OK of 46 with a max outage of 0 means the 29 failures came after the last
success of the micro -> small phase, and the 15.063 s in the next (refused)
phase reads as the tail of the same outage. The findings-line figures
(committed 2026-08-19 in cdfd05a, also in AGENTS.md) carry the
same pattern (61 s for two ops, 17.0 s outage on an op after the first) and
may have the same cause; their artifact was not re-read here. (Re-read and
corrected in the 2026-10-23 entry above.)

## 2026-10-05 - the spend cap does not gate a manual grow past 8 GB (D12)

The database-size guide (Free Plan section) says to disable the spend cap for
a Pro instance to auto-scale beyond the 8 GB disk size limit, which reads as
the cap blocking the resize. The spend cap is an org billing control: Cost
Control lists Disk Size as a covered item, past whose quota (8 GB included on
Pro) "further usage of that item is disallowed until the next billing cycle".
D12 asks whether that shows up at resize time, on a fresh throwaway Micro
project in `ap-southeast-1`, Pro org, cap on (stated by the operator as
`PVLAB_SPEND_CAP=on`: the Management API does not expose the cap). D10's
8 -> 12 GB autoscale ran in the same org, but its cap state was not
recorded, so it is not evidence either way.

- Baseline `GET /config/disk`: `gp3 / 2 GB`, as in D10.
- One `POST /config/disk` with `size_gb: 12` (iops 3000, throughput 125):
  `201`, empty body; `GET` read 12 GB within the polling window.
- Reading: the cap did not refuse a resize past the included 8 GB; the
  guide's sentence does not describe a request-time block. A project that
  stays above 8 GB under the cap is over quota on Disk Size, and the billing
  FAQ routes that to notification, grace and Fair Use restriction - the
  billing path W21 measured for other items. That path was not run here.

Evidence: run artifact `run-2026-10-05T08-17-21-368Z` (gitignored). Project
deleted the same run.

## 2026-10-01 - paid-plan fill: autoscale, read-only, and a full disk (D10, D11)

The lab had the paid-plan read-only and import rules from the docs only;
this run measures them. Pro org,
throwaway Micro projects in `ap-southeast-1`, each deleted the same day. Three
fill runs (module D10, harness plus curl replay for the parts the first module
version did not cover) and one curl replay of the grow steps (D11).

- **A fresh Pro project starts on 2 GB, not 8 GB.** `GET /config/disk` read
  `gp3 / 2 GB / 3000 IOPS / 125 MiB/s` on all three, the same volume the
  platform-plan org gets (sfp-platforms S08) and the Free org (D05).
- **WAL is half the disk on that volume.** `min_wal_size` reads 1GB and
  `max_wal_size` 4GB on Micro. Under bulk inserts `pg_wal` sat at 816-992 MB,
  so at the first read-only trip the database was 803 MB of a 2 GB volume.
  Alerting on database size alone misses the disk by about 1 GB.
- **D10a: the ">1.5x the current size" rule did not fire as written.** 385 MB
  loaded onto a 203 MB database (1.90x) in 26 s: no refusal, read-only off.
  What trips is disk utilisation (data + WAL + system against the volume), so
  the ratio only matters when it pushes utilisation over the line.
- **D10b: autoscale fires at 90%, and the first step goes to 8 GB.** Paced
  25 MB batches: the util sample crossed 90% (91.1%) and the volume grew
  2 -> 8 GB within about two minutes, writes never refused. Run 1 (unpaced)
  grew 2 -> 8 GB as well. A later grow on the same project went 8 -> 12 GB
  (+50%). So the first step lands on the 8 GB plan baseline, not +50%. The
  autoscale email reads "Each expansion increases the disk by 50%" above
  "Disk Size: 2GB -> 8GB".
- **Read-only at 95% measured (run 1).** Seed 700 MB then 100 MB batches on
  2 GB: the write path returned `57P03 the database system is not accepting
  connections` for about three minutes, then
  `ERROR: 25006: cannot execute INSERT in a read-only transaction` with
  `GET /readonly` `{"enabled":true}` and `default_transaction_read_only` on.
  The postmaster did not restart. Autoscale grew the volume about four minutes
  after the trip (`last_modified_at` 00:09:13), and read-write came back on its
  own once the grow landed: `enabled:false`, INSERT accepted, no restart.
- **D10c: with the modification quota spent, a burst hit a FULL DISK in one
  run of two.** After the paced run's 2 -> 8 GB grow, a manual `POST
  /config/disk` answered `429 Database disk can only be modified once per four
  hours`. A 100 MB-per-6 s burst then ran data + WAL from 1.7 GB to 7.66 GB and
  died on `ERROR: 53100: could not extend file "base/5/...": No space left on
  device`. Read-only never engaged that time: the util sample is five minutes
  apart and the burst covered the 90-95% band in under a minute. The
  reproduction run (same module, same burst rate, 01:2x UTC) got read-only
  instead: `25006` at 95.1% data + WAL of 8 GB. So read-only usually wins the
  race, and the full disk is a real but not certain outcome.
- **The full disk cost a seven-minute outage that the project status did not
  show.** Every query, including `GET /readonly`, answered `57P03` from 00:42
  to 00:49; `GET /projects/{ref}` read `ACTIVE_HEALTHY` throughout. The
  postmaster restarted (uptime 3 min at first answer). In the reproduction
  run the read-only path also ended with a restart: first accepted write 492 s
  after the refusal, postmaster uptime 242 s. Both 8 -> 12 GB grows came with a
  restart; the 2 -> 8 GB grow in run 1 did not. Autoscale grew the disk
  8 -> 12 GB at 00:47:13, ten minutes after its previous grow and inside the
  window where the manual POST was refused - so the four-hour cooldown binds
  manual changes, not autoscale. The project came back read-write with nothing
  done by the caller.
- **`/config/disk/util` is a five-minute sample.** It returned the same
  timestamp and value for up to five minutes, and in run 1 kept the
  pre-fill baseline (12.9%) while the disk was full. After a grow it kept
  reporting the old filesystem size until the next sample. Anything gating on
  it is up to five minutes late.
- **D11: grow steps from 2 GB.** `size_gb` 4 and 5 rejected `400 Invalid IOPS
  value for gp3 volume 3000. Minimum is 3000. Max is 500 IOPS per GB or 80,000,
  whichever is lower.` 6 accepted (`201`, empty body, visible within 10 s). An
  immediate 7 answered the four-hour 429. The 80,000 ceiling in the message
  differs from the 16,000 gp3 maximum on the docs page.

Not run: recovery by freeing space under the override GUC on a paid plan
(every refusal here was cleared by autoscale before we acted), Fair Use (a
billing-cycle restriction, not reproducible on a throwaway project), and any
of this on the platform-plan org (separate control plane and token).

Evidence: `evidence/d10/` (run 1 log, recovery poll, D11 replay),
`evidence/d10v2/` (paced run, burst and recovery polls), `evidence/d10v3/`
(reproduction run of the final module: D10b/c/d pass - 2 -> 8 GB at 91.1%,
read-only at 95.1%, writable 492 s later on 12 GB). Gitignored; this entry is the
redacted record.

## 2026-09-23 - the disk write accepts autoscale fields and silently discards them

Question: can the Advanced Disk Settings cap be set programmatically, so that
automatic growth cannot add to the bill without approval?
Curl replay against a throwaway nano project on a platform-plan org, STAGING
control plane, created and deleted for the run.

- **No write verb exists on the autoscale route.** `PATCH`, `PUT`, `POST` and
  `DELETE` on `/config/disk/autoscale` all answer
  `404 {"message":"Cannot <VERB> /v1/projects/<ref>/config/disk/autoscale"}` -
  the same shape an entirely unknown path returns, checked as a control
  (`PATCH /config/disk/nonesuch`). `GET` answers `200` with
  `{"growth_percent":null,"min_increment_gb":null,"max_size_gb":null}`.
  This replicates the D04/D07 reading on Pro and Team, now on a third org
  class and a second control plane.
- **The documented disk write accepts autoscale fields and ignores them.**
  `POST /config/disk` with a full valid `attributes` object plus autoscale keys
  answers `201` in every shape tried - keys inside `attributes`, keys at the
  top level, and a nested `autoscale` object. `GET /config/disk/autoscale` still
  reads all-null after a 60 s settle. So a caller who reaches for the obvious
  workaround gets a success code and no effect, which is a worse failure than
  the 404: nothing tells them the cap was not applied.
- Getting there needs the full attribute set. A partial body is rejected on the
  missing field rather than on the autoscale keys (`attributes.type: Invalid
  discriminator value. Expected 'gp3' | 'io2'`, then `attributes.iops: Invalid
  input: expected number, received undefined`), so a probe that stops at the
  first 400 concludes "rejected" when the real answer is "accepted and
  discarded".

Consequence for anyone billing on provisioned capacity: there is no API lever
to cap growth, and no error to detect a failed attempt. The readable half is
the mitigation - `GET /config/disk/autoscale` and `GET /config/disk/util` are
both per-project reads, so utilisation can be polled and capacity raised
deliberately with `POST /config/disk` after approval. That does not stop
autoscale firing between polls.
