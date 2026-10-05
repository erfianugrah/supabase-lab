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
- D09 (resize/downgrade timing with 250ms sampling, local vantage):
  upgrade micro->small 105s (max contiguous REST outage 1.0s), upgrade
  small->large 61s (17.0s), downgrade large->small 61s (0s), downgrade
  small->micro 73s (0s); Auth /auth/v1/health showed no contiguous outage in
  any op. Adjacent resize PATCHes are rate-limited: 429
  `We are still processing addon changes, please try again in N minute(s)`.
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

Prompted by a customer-facing draft that stated the paid-plan read-only and
import rules as fact while the lab only had them from the docs. Pro org,
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

Prompted by a customer asking whether the Advanced Disk Settings cap can be set
programmatically, so that automatic growth cannot bill them without approval.
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
