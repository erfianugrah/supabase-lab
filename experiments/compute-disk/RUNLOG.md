# RUNLOG - experiments/compute-disk

One project per module, self-provisioning (no tofu), Pro/Team/Free orgs.
Reference: COMPUTE-DISK.md at repo root. Probes: `.pi/probe-compute-disk.sh D01[,...]`. D10 runs directly:
`PVLAB_ORG_PRO=<slug> pvlab --where local --experiment compute-disk --only D10 --destructive`.
D13 (2026-11-04) runs through this experiment's Makefile: `make probe-bg ONLY=D13`
(`make sweep PREFIX=...` deletes what a dead run left).

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
- D13 (live IOPS/throughput raise, 2026-11-04, runs 3 and 4 of four on Large
  projects in `ap-northeast-1`): raising 3000 -> 4000 IOPS and 125 -> 250 MiB/s
  on a running gp3 volume restarted nothing and cost no held connection on
  direct 5432, the session pooler or the transaction pooler; the config read
  the new values 2.3 s after the POST and the same write load took 12672 to
  14919 ms from +180 s, against 42224 to 43985 ms before. A second change
  1501 s later answered
  `429 Database disk can only be modified once per four hours`. The Data API
  was not tested (org-level 402). See the 2026-11-04 entry.

## Operational notes

- The free-org module borders on the util endpoint: selects return 200, so
  `/config/disk/util` is available on free (check D05 measurements).
- Probe mapping: result ids D01..D09 live in modules D01, D02, D04, D05, D08
  - the probe maps result->module before passing --only.
- The first fill round ran a 5-mod disk increase burst without triggering
  the quota; the second round caught the cooldown on the second attempt.
  Recorded as nondeterministic, not a clean pass/fail.

## 2026-11-04 - raising disk IOPS and throughput on a running gp3 project (D13, #291)

Question: when provisioned disk IOPS and throughput are raised on a running
gp3 project, do connections through direct 5432, the Supavisor session pooler
(5432), the Supavisor transaction pooler (6543) and the Data API see an
interruption; does Postgres restart; how long until the new values are
reported and until they take effect; is a second change shortly after
refused, and how?

Claims under test (checked 2026-11-04 against the 2026-11-03 crawl of
supabase.com `guides/platform/compute-and-disk`): provisioning IOPS and
throughput "requires Large compute size or above"; "After any disk attribute
change, there is a cooldown period of approximately four hours"; downtime is
stated for compute changes and not for a disk performance change; Large's
compute disk limits are 79 MB/s and 3,600 IOPS baseline, 594 MB/s and 20,000
IOPS burst (docs figures, not found in the crawl; unverified), and sizes up to
2XL burst "for short periods of time, drawing on a disk IO budget". AWS (EBS user guide and the 2026-01-15 announcement, read
2026-11-04): up to four Elastic Volumes modifications per volume in a rolling
24 hours, each once the previous one is `completed`; the docs mirror's
ModifyVolume API page still says "wait at least six hours", an older text.

Module `tests/d13-live-iops-change.ts` (libs `lib/disk-change.ts`,
`lib/live-paths.ts`, unit tests in `lib/disk-change.test.ts`). One throwaway
project per run, Pro org, `ap-northeast-1`, created Large, IPv4 add-on on so
direct 5432 is reachable from this IPv4-only vantage (Singapore); deleted at
the end of the run. Paths, every sample kept with its phase: direct, session
pooler and transaction pooler, each as a held connection (`select
pg_postmaster_start_time()` every 1 s, reconnect on any error) and as a fresh
connection (connect, `select 1`, disconnect, every 2 s); 5 s connect and
query timeouts. Write load: two sessions each insert 500,000 rows of
`repeat('x', 1900)` into their own table (2049 MB heap, 1974 MB WAL per
load), timed as the longer of the two sessions' INSERT statements; an
`unlogged` variant (no WAL) is the control for how much of that time is WAL
I/O. All four artifacts read lab commit 9c57eea; the module was uncommitted
and changed between runs (run 1 required the Data API; runs 1 and 2 targeted
6,000 IOPS; run 3 has the `accepted_after_grow_post_s` bug; D13b lists every
attempt only since after run 4, so no artifact here has that list).

| Run | Artifact (`out/2026-11-04/`) | What it did |
|---|---|---|
| 1 | `run-2026-11-04T09-13-48-724Z.json` | Stopped at probe-table seeding: the Data API answered 402 (below). Project deleted. |
| 2 | `run-2026-11-04T09-23-59-871Z.json` | Data API dropped. Size-only grow 8 -> 24 GB, then the IOPS change attempted 949.5 s later and refused. Ended by deleting its project (below). |
| 3 | `run-2026-11-04T09-53-29-290Z.json` | The change: 3000 -> 4000 IOPS and 125 -> 250 MiB/s in one POST, no size change, then a second change. |
| 4 | `run-2026-11-04T10-21-54-142Z.json` | Replicate of run 3. |

Results (runs 3 and 4 unless stated; n = 2 for the change):

- **The volume was big enough without a grow.** `GET /config/disk` read
  `gp3 8 GB 3000 IOPS 125 MiB/s` at the start of runs 3 and 4 (and
  `size_gb` 8 in run 2) on projects created Large; D10 and D12 read 2 GB on
  Micro projects in October. At 500 IOPS per GB (D11) 8 GB allows 4,000, so
  the target was 4,000 rather than the 6,000 first planned: 6,000 needs 12 GB,
  and a size change first starts the cooldown (run 2).
- **No interruption on any Postgres path.** From the accepted POST to +25 min,
  quiet windows only (`D13c`): run 3 `direct_held` 0/1434, `direct_fresh`
  0/717, `session_held` 0/1434, `session_fresh` 0/717, `txn_held` 0/1434,
  `txn_fresh` 0/717; run 4 the same six paths 0/1437, 1/717, 0/1437, 0/720,
  0/1437, 0/720. First 3 min after the POST (`D13c-change3min`): 0 failures on
  every path in both runs (held 0/180, fresh 0/89 in run 3; held 0/180,
  fresh 0/90 in run 4). Longest gap between successful held samples in the
  `D13c` windows 1.007 s (run 3) and 1.006 s (run 4) against a 1 s cadence
  (`D13c-change3min`: 1.005 s and 1.006 s). The one
  post-change failure (run 4, `direct_fresh`, `2026-11-04T11:00:20.972Z`,
  `5003ms timeout expired`, recovered on the next sample; max outage 5.003 s)
  came about 21 min after the POST, whose `last_modified_at` reads
  `2026-11-04T10:39:40.483Z`; see the next point: it is not attributed to
  the change, and run 2's timing does not exclude the change as its cause.
- **`direct_fresh` failed now and then, three times with no disk change
  made.** Run 4 had three `Connection terminated unexpectedly` (101 to
  105 ms) at `2026-11-04T10:36:28.223Z`, `10:36:42.228Z` and
  `10:38:50.270Z` in `quiet_pre_attempt1`, before the change POST; run 2 had
  one (106 ms) at `2026-11-04T09:55:39.049Z` in `baseline_main`, after its
  IOPS POST was refused but 1229.2 s after its accepted size-only grow
  (`last_modified_at` `2026-11-04T09:35:09.801Z`), about as long after a disk
  change as run 4's post-change failure. All are on the fresh direct
  connection over the IPv4 add-on; the held direct connection and all four
  pooler probes had no failure in those windows. Two causes fit all five
  (these four and run 4's post-change failure) and were not separated: something on the add-on path, and server-side work
  after the write loads (each pair of logged loads writes 2 x 1974 MB of WAL,
  close to `max_wal_size` 4GB; checkpoint timing was not read); for the two
  about 20 min after an accepted disk change, that change fits as well. Run 3
  had none at all.
- **No restart.** `pg_postmaster_start_time()` read
  `2026-11-04 09:54:57.206501+00` (run 3) and `2026-11-04 10:23:36.094154+00`
  (run 4) at setup, 25 min after the change and at the end
  (`postmaster_start_mgmt_before_main` repeats the setup read when no grow
  ran); the held connections saw one distinct start time per run and logged
  no connection error event.
- **Reported at once.** The config read the new values on the first poll,
  2.3 s after the POST (both runs), with `last_modified_at` set to the POST
  time. The project status read `ACTIVE_HEALTHY` on the first poll (+2.5 s,
  +2.4 s) and read nothing else at 10 s polls for 5 min, then 60 s polls to
  +25 min. The POST answered `201` with an empty body.
- **Effective by the first probe at +180 s.** The logged load took 43538 and
  42278 ms before the change in run 3 (42224 and 43985 ms in run 4), and
  12890, 14919, 12824, 12771 ms at +180, +420, +660, +900 s after it (run 4:
  12791, 12938, 12693, 12672 ms). WAL per second of insert: 45.3 and
  46.7 MB/s before, 132.3 to 154.6 MB/s after (run 4: 46.7 and 44.9, then
  152.6 to 155.8). The unlogged control took 2379 ms (run 3) and 2480 ms
  (run 4), so most of the logged time is WAL work, and the drop after a
  disk-only change puts that work on the disk. Nothing was measured
  between the POST and +180 s.
- **A second change 1501.2 s (run 3) and 1501 s (run 4) after the first was
  refused by a message naming four hours from the first.** Throughput
  250 -> 300 MiB/s: `429 {"message":"Database disk can only be modified once
  per four hours. Last modified at 04-11-2026 10:11:05 UTC"}` (run 4:
  `... 10:39:40 UTC`). The time is day-month-year and is the accepted
  change's own POST time. Of the four headers the module records, the
  response carried
  `x-ratelimit-limit=120; x-ratelimit-remaining=119; x-ratelimit-reset=60`
  (the request-rate limit) and no `Retry-After`.
- **A size change starts the same cooldown (run 2).** Size-only grow 8 ->
  24 GB: `201`, read back in 2.3 s, 0 failures on all six paths for the 10 min
  after it (held 0/603, fresh 0/302 each), postmaster start unchanged
  (`2026-11-04 09:25:42.512096+00`). The IOPS change 949.5 s later answered
  `429 ... Last modified at 04-11-2026 09:35:09 UTC`. In the run's
  `evidence/<ts>/run.log` (gitignored, local only), not the artifact,
  attempts 2 to 11 every 5 min (09:56 to 10:41 UTC) all answered 429 naming
  the same 09:35:09: the refusals did not move the stated last modification.
  The artifact keeps attempt 1 only (D13c, which lists later attempts, is
  built only after an accepted change).
- **The Data API, Realtime and the metrics endpoint were not testable.**
  Each of the four D13 projects answered HTTP 402 with the anon key. Runs 2,
  3 and 4 (`data_api_tested`) recorded `HTTP 402 {"message":"Service for this
  project is restricted due to the following violations:
  exceed_realtime_connection_count_quota. The project owner must upgrade
  their plan or remove spend caps to restore service."}`; run 1's summary
  `detail` keeps `rest_read=HTTP 402 Service for this project is restricted
  due to the following`, cut there. `/customer/v1/privileged/metrics` with
  the service_role key answered 402 with the same body (hand check on run 2's
  project, 10:41 UTC, not in an artifact). That is an org-level restriction:
  run 1 met it with no disk change made, and it was in place before run 1
  (hand check, 2026-11-04, not in an artifact). It is why no `rest_read` path
  and no node disk counters are in the artifacts. An unauthenticated request
  was answered 401 by the gateway before this check (hand check, 2026-11-04,
  not in an artifact), so a 401 does not show the Data API working.
- `CHECKPOINT` is refused to `postgres`: `42501 permission denied to execute
  CHECKPOINT command` (every load).
- IPv4 add-on: `PATCH 200`, A record first seen at the 80.3 s poll (10 s
  polling) and direct 5432 answering 81.1 s (run 3) and 81 s (run 4) after
  the PATCH, the same order pooler-checkout PC02d saw.

How runs 1 and 2 ended. Run 1's module required the Data API probe table and
stopped when it never served; the module now drops `rest_read` and records
why. Run 2 grew the disk first (the module still does when the volume is too
small for the target) and met the cooldown as designed, but parsed `04-11-2026`
as 11 April, so instead of waiting to 13:35 UTC it retried every 5 min and
would have given up at about 11:27 UTC. The run's process was not stopped,
so its project was deleted with `make sweep PREFIX=d13-iops-` at 10:41:37
UTC; every `baseline_main` failure from 10:41:42.979Z on in run 2's artifact
(`XX000 (ENOTFOUND) tenant/user ... not found`, `getaddrinfo ENOTFOUND`,
timeouts, `57P01` on the held pooler connections, the 404 `Resource has
been removed` on attempt 12) comes from that deletion. `parseCooldown` now
reads day-month-year (test with the observed string). Run 2's two loads at
3000 IOPS / 125 MiB/s on the grown volume took 43230 and 28945 ms; the
spread was not explained. In run 3's artifact `accepted_after_grow_post_s`
and the summary `detail` read 396.5 although no grow ran (it counted from
the point the grow was skipped); fixed before run 4, which reads `n/a (no
grow)`.

Not settled:

- The Data API path (and Realtime): org restriction, not run.
- Which of the two limits bound the load: both changed in one POST, and with
  no disk counters (402) the WAL rate cannot be split between IOPS and
  throughput. The post-change WAL rate (up to 155.8 MB/s) is above Large's
  79 MB/s baseline (the unverified docs figure above), which the docs put in
  burst; how long a project keeps the higher rate under sustained load was
  not measured.
- When between the POST and +180 s the change took effect.
- Whether a change of IOPS alone, an IOPS or throughput decrease, a change to 6,000 IOPS after a
  size change, io2, another region or another compute size behaves the same;
  whether the four hours end at exactly four hours (no run lasted that long);
  a change under an application's own write load.
- The cause of the isolated `direct_fresh` failures.
- n = 2 for the change, n = 1 for the size-only grow.

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
38a0f9c with this entry's module changes. Artifact:
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
ap-southeast-1, run from source at lab commit 080124a, project provisioned and
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
of this on the platform-plan org.

Evidence: `evidence/d10/` (run 1 log, recovery poll, D11 replay),
`evidence/d10v2/` (paced run, burst and recovery polls), `evidence/d10v3/`
(reproduction run of the final module: D10b/c/d pass - 2 -> 8 GB at 91.1%,
read-only at 95.1%, writable 492 s later on 12 GB). Gitignored; this entry is the
redacted record.

## 2026-09-23 - the disk write accepts autoscale fields and silently discards them

Question: can the Advanced Disk Settings cap be set programmatically, so that
automatic growth cannot add to the bill without approval?
Curl replay against a throwaway nano project on a platform-plan org, created
and deleted for the run.

- **No write verb exists on the autoscale route.** `PATCH`, `PUT`, `POST` and
  `DELETE` on `/config/disk/autoscale` all answer
  `404 {"message":"Cannot <VERB> /v1/projects/<ref>/config/disk/autoscale"}` -
  the same shape an entirely unknown path returns, checked as a control
  (`PATCH /config/disk/nonesuch`). `GET` answers `200` with
  `{"growth_percent":null,"min_increment_gb":null,"max_size_gb":null}`.
  This replicates the D04/D07 reading on Pro and Team, now on a third org
  class.
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
