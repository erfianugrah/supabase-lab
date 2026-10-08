# redundant-writes - RUNLOG

Local only: three throwaway containers, no managed project, no PAT, no tofu
state. See README.md for the question and the method; this file is the
per-run record. Every module figure below is pasted from the published
artifacts in `out/2026-10-08/` (`make facts` renders the newest evidence/ run,
of which out/ is the redacted copy); figures marked manual (VM spec, JIT
check, checkpoint_completion_target, superseded and scratch runs) are not in
an artifact.

## RW01-RW06 - first published run (2026-10-08)

Rig: `postgres:15-alpine` (15.19), `postgres:17-alpine` (17.11) and
`public.ecr.aws/supabase/postgres:17.11.0.004` (17.11, the image supabase CLI
2.120.0 starts), all pinned by digest in `compose.yml`, created fresh by
`make local-up` before the run. Docker Desktop on an Apple-silicon Mac:
linuxkit VM kernel 7.0.14, 10 CPUs, about 7.6 GiB for the VM (manual).

Artifacts:

- `out/2026-10-08/run-2026-10-08T13-10-22-155Z.{json,facts.md}` - RW01 to RW05,
  204 pass, 0 fail, 0 skip, run 13:10:22 to 13:35:14 UTC.
- `out/2026-10-08/run-2026-10-08T13-35-31-791Z.{json,facts.md}` - RW06,
  12 results (status `info`, the module records counts and passes nothing).

Both artifacts carry `lab commit e3408a6`; the experiment's own files were not
yet committed when they ran, so that stamp is the repo HEAD underneath them,
not the module source. The `region ap-southeast-1` in the artifact header is
the harness default and means nothing for a local run.

Sizes 10,000 / 100,000 / 1,000,000 rows, 3 reps per (target, size, case),
each rep on a freshly built fixture. Medians below; a range is given where
the three reps differed. WAL bytes, FPI counts, row versions and dead tuples
were identical across reps in every RW02 and RW03 cell; execution time and
VACUUM figures vary.

### Superseded run (not published; manual)

A first full run of RW01 to RW04 (`evidence/20261008-205544/`, 105 pass)
measured the VACUUM after each statement with a `pg_current_wal_lsn()` diff.
That function returns the WAL WRITE position, which lags WAL still sitting in
`wal_buffers`, and the run read 0 bytes for VACUUMs that had removed 10,000
dead tuples (pg17 and supabase at 10,000 rows). `lib/rig.ts` now uses
`pg_current_wal_insert_lsn()` for the statement window and parses VACUUM
(VERBOSE)'s own "WAL usage" line for the VACUUM. The statement figures from
EXPLAIN (ANALYZE, WAL) did not depend on either function and agree between
the two runs (pg17, 1,000,000 rows, plain upsert: 400162756 bytes both
times); the superseded run is cited once on the reference page, as
RUNLOG-only evidence.

### RW01 - the servers

| | pg15 | pg17 | supabase |
|---|---|---|---|
| server_version | 15.19 | 17.11 | 17.11 |
| build | aarch64-unknown-linux-musl, gcc (Alpine 15.2.0) | aarch64-unknown-linux-musl, gcc (Alpine 15.2.0) | aarch64-unknown-linux-gnu, gcc (GCC) 15.2.0 |
| wal_level | replica | replica | logical |
| full_page_writes / wal_compression / data_checksums / wal_log_hints | on / off / off / off | on / off / off / off | on / off / off / off |
| shared_buffers, checkpoint_timeout, max_wal_size | 128MB, 5min, 1GB | 128MB, 5min, 1GB | 128MB, 5min, 1GB |
| autovacuum_vacuum_threshold / scale_factor | 50 / 0.2 | 50 / 0.2 | 50 / 0.2 |
| pg_stat_force_next_flush() | yes | yes | yes |
| suppress_redundant_updates_trigger() | yes | yes | yes |

Both functions were checked with `to_regproc` on each server rather than
assumed from the version. `pg_stat_force_next_flush()` exists on all three
but is not described on the PostgreSQL 17 "Cumulative Statistics System" page
(searched 2026-10-08); the rig calls it and then disconnects, and a backend
flushes its pending counters at exit.

### RW02 / RW03 - checkpoint right before the statement, pg17

Every first touch of a page after a checkpoint writes a full-page image (FPI),
so these numbers are the upper regime. `versions` = rows with xmin = the
statement's xid; `xmax=stmt` = visible rows with xmax = the statement's xid
(rows it locked; on the plain upsert the lock is carried onto the new
version, so the count includes those); `dead` = `n_dead_tup` delta after a
forced flush, which matched `versions` in every cell; vacuum figures are from
VACUUM (VERBOSE) right after.

10,000 rows (heap 770048 bytes before):

| case | versions | xmax=stmt | WAL bytes | FPI | dead | vacuum WAL | vacuum removed | exec ms |
|---|---|---|---|---|---|---|---|---|
| upsert_plain_identical | 10000 | 10000 | 4008081 | 124 | 10000 | 115769 (111200-118417) | 10000 | 61.42 (59.25-62.91) |
| upsert_guarded_identical | 0 | 10000 | 1302726 | 94 | 0 | 0 | 0 | 54.35 (52.82-56.19) |
| upsert_guarded_1pct | 100 | 10000 | 1537403 | 123 | 100 | 23810 (21422-24590) | 100 | 52.42 (46.73-54.61) |
| upsert_prefiltered_identical | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2.7 (1.61-2.7) |
| upsert_prefiltered_1pct | 100 | 100 | 1002803 | 123 | 100 | 24302 (23218-24618) | 100 | 4.74 (4.41-5.05) |
| merge_guarded_identical | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3.83 (3.81-4.16) |
| merge_guarded_1pct | 100 | 0 | 997403 | 123 | 100 | 21338 (19702-24330) | 100 | 4.6 (4.43-4.9) |
| update_plain_identical | 10000 | 0 | 3468081 | 124 | 10000 | 118377 (113501-118869) | 10000 | 20.04 (13.93-20.36) |
| update_guarded_identical | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3.06 (2.6-3.35) |
| update_trigger_identical | 0 | 10000 | 1302726 | 94 | 0 | 0 | 0 | 6.9 (5.66-7.21) |
| upsert_plain_trigger_identical | 0 | 10000 | 1302726 | 94 | 0 | 0 | 0 | 56.22 (54.98-58.09) |

100,000 rows (heap 7659520 bytes before):

| case | versions | xmax=stmt | WAL bytes | FPI | dead | vacuum WAL | vacuum removed | exec ms |
|---|---|---|---|---|---|---|---|---|
| upsert_plain_identical | 100000 | 100000 | 40021870 | 1211 | 100000 | 1115070 (1114450-1117634) | 100000 | 536.19 (531.89-642.49) |
| upsert_guarded_identical | 0 | 100000 | 13027115 | 935 | 0 | 0 | 0 | 416.53 (402.49-492.7) |
| upsert_guarded_1pct | 1000 | 100000 | 15299694 | 1210 | 1000 | 179641 (178557-179957) | 1000 | 399.28 (396.93-401.25) |
| upsert_prefiltered_identical | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 24.69 (21-25.46) |
| upsert_prefiltered_1pct | 1000 | 1000 | 9953694 | 1210 | 1000 | 178369 (175037-179669) | 1000 | 30.24 (29.72-30.28) |
| merge_guarded_identical | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 24.19 (23.24-24.25) |
| merge_guarded_1pct | 1000 | 0 | 9899694 | 1210 | 1000 | 175125 (172873-179697) | 1000 | 31.34 (28.4-31.67) |
| update_plain_identical | 100000 | 0 | 34621870 | 1211 | 100000 | 1117098 (1114534-1117550) | 100000 | 145.74 (140.15-146.65) |
| update_guarded_identical | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 28.26 (25.13-29.42) |
| update_trigger_identical | 0 | 100000 | 13027115 | 935 | 0 | 0 | 0 | 49.49 (49.08-51.58) |
| upsert_plain_trigger_identical | 0 | 100000 | 13027115 | 935 | 0 | 0 | 0 | 439.91 (431.12-441.15) |

1,000,000 rows (heap 76562432 bytes before):

| case | versions | xmax=stmt | WAL bytes | FPI | dead | heap after | vacuum WAL | vacuum removed | vacuum ms | exec ms |
|---|---|---|---|---|---|---|---|---|---|---|
| upsert_plain_identical | 1000000 | 1000000 | 400162756 | 12091 | 1000000 | 153124864 | 11109000 (11109000-11109020) | 1000000 | 280.5 (263.3-287.7) | 5598.37 (5541.25-5612.35) |
| upsert_guarded_identical | 0 | 1000000 | 130271034 | 9346 | 0 | 76562432 | 0 | 0 | 1.2 (0.9-1.7) | 4243.61 (4235.78-4245.2) |
| upsert_guarded_1pct | 10000 | 1000000 | 152922572 | 12080 | 10000 | 77332480 | 1732599 (1732571-1732627) | 10000 | 61.1 (59.8-61.4) | 4246.15 (4231.88-4305.43) |
| upsert_prefiltered_identical | 0 | 0 | 0 | 0 | 0 | 76562432 | 0 | 0 | 0.9 (0.8-0.9) | 241.04 (238-283.01) |
| upsert_prefiltered_1pct | 10000 | 10000 | 99462572 | 12080 | 10000 | 77332480 | 1732767 (1732739-1732795) | 10000 | 70.1 (61.5-70.5) | 363.07 (361.96-363.23) |
| merge_guarded_identical | 0 | 0 | 0 | 0 | 0 | 76562432 | 0 | 0 | 0.9 (0.9-1) | 364.03 (344.93-403.36) |
| merge_guarded_1pct | 10000 | 0 | 98922572 | 12080 | 10000 | 77332480 | 1732935 (1732907-1732963) | 10000 | 57.4 (56.8-57.5) | 435.85 (433.24-437.61) |
| update_plain_identical | 1000000 | 0 | 344004728 | 12091 | 1000000 | 153124864 | 8900964 (8899188-8901804) | 1000000 | 143.2 (137.5-163.7) | 1861.55 (1846.74-1884.48) |
| update_guarded_identical | 0 | 0 | 0 | 0 | 0 | 76562432 | 0 | 0 | 0.7 (0.7-0.8) | 286.61 (286.2-292.82) |
| update_trigger_identical | 0 | 1000000 | 130271034 | 9346 | 0 | 76562432 | 0 | 0 | 0.8 (0.8-0.9) | 630.17 (626.18-670.53) |
| upsert_plain_trigger_identical | 0 | 1000000 | 130271034 | 9346 | 0 | 76562432 | 0 | 0 | 1 (1-1.1) | 4720.58 (4689.17-4779.79) |

`n_tup_hot_upd` was 0 in every cell: the pages are full (fillfactor 100), so
no update could stay on its page. Autovacuum (disabled on the table for the
run) would have been triggered by every plain case (`n_dead_tup` above
50 + 0.2 x reltuples) and by none of the guarded, pre-filtered, MERGE or
trigger cases, including the 1% ones (100 / 1,000 / 10,000 dead tuples against
thresholds of 2,050 / 20,050 / 200,050).

### RW05 - pages already logged this checkpoint cycle (no-FPI regime), pg17

Same cases with the CHECKPOINT moved to before the fixture build. FPI was 0
in every pg17 cell except the 1,000,000-row plain upsert (1489 FPI, range
1471-1696, WAL 315515118 bytes, range 315365912-317161685); pg15 read 1296
FPI there (1137-1665), WAL 313903497 (312633950-316851134). The Supabase
image read 0 FPI and 303650416 bytes there, with no range. A checkpoint
starting mid-statement on the two vanilla images is the likely reading (they
run `checkpoint_completion_target` at its default and the Supabase image at
0.5 (manual: per supabase/postgres
ansible/files/postgresql_config/postgresql.conf.j2 on the develop branch,
read 2026-10-09, not pinned to 17.11.0.004; RW01 does not record the
setting), which moves the WAL-volume trigger point); that was not
instrumented.

| case | WAL bytes 10,000 | WAL bytes 100,000 | WAL bytes 1,000,000 | exec ms 1,000,000 |
|---|---|---|---|---|
| upsert_plain_identical | 3034728 | 30363218 | 315515118 (315365912-317161685) | 5517.84 (5515.51-5562.84) |
| upsert_guarded_identical | 540000 | 5400000 | 54000000 | 4237.61 (4210.96-4246.94) |
| upsert_guarded_1pct | 564544 | 5645472 | 56454760 | 4236.6 (4227.27-4249.6) |
| upsert_prefiltered_identical | 0 | 0 | 0 | 262.17 (261.95-263.41) |
| upsert_prefiltered_1pct | 29944 | 299472 | 2994760 | 350.26 (348.97-352.52) |
| merge_guarded_identical | 0 | 0 | 0 | 373.86 (365.63-383.99) |
| merge_guarded_1pct | 24544 | 245472 | 2454760 | 410.4 (405.08-450.98) |
| update_plain_identical | 2494728 | 24963218 | 247483968 | 1847.31 (1845.57-1861.09) |
| update_guarded_identical | 0 | 0 | 0 | 311.75 (308.66-312.46) |
| update_trigger_identical | 540000 | 5400000 | 54000000 | 635.37 (615.88-664.87) |
| upsert_plain_trigger_identical | 540000 | 5400000 | 54000000 | 4753.88 (4721.26-4756.76) |

Per row, from the 1,000,000-row column (derived, not a separate
measurement): a row lock is 54 bytes of WAL (54000000 / 1,000,000), a plain
UPDATE about 247 bytes and a plain upsert about 304 bytes per row on the
Supabase image's FPI-free cell (303650416 / 1,000,000).

### All three servers at 1,000,000 rows

| module / case | WAL bytes pg15 | pg17 | supabase | exec ms pg15 | pg17 | supabase |
|---|---|---|---|---|---|---|
| RW02 upsert_plain_identical | 400079799 | 400162756 | 400162807 | 5638.89 | 5598.37 | 1870.69 |
| RW02 upsert_guarded_identical | 130271034 | 130271034 | 130271034 | 4563.98 | 4243.61 | 723.83 |
| RW02 upsert_guarded_1pct | 152839615 | 152922572 | 152922624 | 4741.56 | 4246.15 | 735.19 |
| RW02 upsert_prefiltered_identical | 0 | 0 | 0 | 249.93 | 241.04 | 229.11 |
| RW02 upsert_prefiltered_1pct | 99379615 | 99462572 | 99462624 | 385.79 | 363.07 | 310.5 |
| RW02 merge_guarded_identical | 0 | 0 | 0 | 345.93 | 364.03 | 332.59 |
| RW02 merge_guarded_1pct | 98839615 | 98922572 | 98922624 | 432.49 | 435.85 | 410.34 |
| RW03 update_plain_identical | 343921771 | 344004728 | 344004779 | 1886.87 | 1861.55 | 1720.63 |
| RW03 update_guarded_identical | 0 | 0 | 0 | 287.23 | 286.61 | 273.81 |
| RW03 update_trigger_identical | 130271034 | 130271034 | 130271034 | 644.21 | 630.17 | 597.78 |
| RW03 upsert_plain_trigger_identical | 130271034 | 130271034 | 130271034 | 4405.37 | 4720.58 | 894.67 |
| RW05 upsert_plain_identical | 313903497 | 315515118 | 303650416 | 5512.34 | 5517.84 | 1870.31 |
| RW05 upsert_guarded_identical | 54000000 | 54000000 | 54000000 | 4495.65 | 4237.61 | 729.11 |
| RW05 upsert_guarded_1pct | 56380000 | 56454760 | 56454760 | 4517.24 | 4236.6 | 725.52 |
| RW05 update_plain_identical | 247409208 | 247483968 | 247483968 | 1897.19 | 1847.31 | 1714 |
| RW05 update_trigger_identical | 54000000 | 54000000 | 54000000 | 637.93 | 635.37 | 600.45 |
| RW05 upsert_plain_trigger_identical | 54000000 | 54000000 | 54000000 | 4481.25 | 4753.88 | 887.16 |

WAL volume, row versions and dead tuples are the same on all three servers to
within 0.1% in RW02 and RW03 at 1,000,000 rows (up to 0.9% at 10,000 rows,
pg15 vs pg17). In RW05 the plain upsert differs by the FPI noted above, and
the pre-filtered and MERGE 1% cells read 2.5-3.1% lower on pg15 than on pg17
at every size (2920000 vs 2994760 and 2380000 vs 2454760 at 1,000,000 rows). Execution time is not: every `INSERT ... ON CONFLICT` case that
reaches the conflict path for all 1,000,000 rows ran in 4236.6 to 5638.89 ms
on the two Alpine images and 723.83 to 1870.69 ms on the Supabase image, while
plain UPDATEs and the pre-filtered and MERGE paths were within 25% of each
other across the three. The two Alpine images are musl builds and the
Supabase image a glibc build (RW01 `version()`); whether that is the cause was
not tested. A manual check the same evening ruled out JIT: `pg_jit_available()`
is true on both Alpine images and false on the Supabase image, but EXPLAIN
reported no JIT section for the guarded upsert at 1,000,000 rows, and
`set jit = off` gave 4370.808 ms (pg15) and 4504.429 ms (pg17) against
4094.439 ms and 4187.63 ms with it on (one run each, not a module; manual).

### RW04 - count(*) vs reltuples, and the count sources across events (1,000,000 rows)

| | pg15 | pg17 | supabase |
|---|---|---|---|
| fresh: reltuples / n_live_tup / count(*) | 1000000 / 1000000 / 1000000 | 1000000 / 1000000 / 1000000 | 1000000 / 1000000 / 1000000 |
| count(*) plan scan node | Seq Scan | Seq Scan | Seq Scan |
| warm count(*) ms, median (range) | 13.45 (12.65-15.09) | 12.82 (11.95-14.2) | 11.98 (11.63-12.35) |
| warm reltuples lookup ms (client), median (range) | 0.33 (0.31-1.08) | 0.33 (0.33-1.07) | 0.4 (0.33-0.47) |
| cold count(*) ms, median (range) | 15.56 (13.31-16.61) | 12.98 (12.35-13.17) | 13.63 (13.22-33.84) |
| cold count(*) shared blocks read | 9346 | 9346 | 9346 |
| cold reltuples lookup ms, median (range) | 2.27 (0.87-2.63) | 2.08 (0.85-2.14) | 1.73 (0.87-2.01) |
| n_live_tup after first clean restart | 1000000 | 1000000 | 1000000 |
| after pg_stat_reset(): n_live_tup / reltuples / count(*) | 0 / 1000000 / 1000000 | 0 / 1000000 / 1000000 | 0 / 1000000 / 1000000 |
| +100000 rows, no ANALYZE: reltuples / planner rows / n_live_tup / count(*) | 1000000 / 1100043 / 100000 / 1100000 | 1000000 / 1100043 / 100000 / 1100000 | 1000000 / 1100043 / 100000 / 1100000 |
| after ANALYZE: reltuples / n_live_tup | 1100000 / 1100000 | 1100000 / 1100000 | 1100000 / 1100000 |
| after SIGKILL + start: n_live_tup / reltuples / count(*) | 0 / 1100000 / 1100000 | 0 / 1100000 / 1100000 | 0 / 1100000 / 1100000 |

"Cold" here is cold-ish: `docker restart` empties shared_buffers and a
privileged container emptied the linuxkit VM's page cache (3 of 3 reps on each
target), so the scan read all 9346 heap pages (76562432 bytes) from below
Postgres. The macOS page cache underneath the VM's disk image was not dropped,
so those reads very likely came from host memory; the cold count(*) is not a
disk read time and says nothing about a network volume. Warm runs also read
blocks from below shared_buffers on every scan (pg17 median 6539 shared blocks
read): a large sequential scan reuses a 256KB ring of buffers rather than
filling shared_buffers (Postgres `src/backend/storage/buffer/README`, "Buffer
Ring Replacement Strategy"), so the table never becomes fully cached there.

After `pg_stat_reset()`, `n_live_tup` counted only rows inserted since the
reset (100000 after the 100,000-row insert); `reltuples` stayed at its last
VACUUM/ANALYZE value, and the planner's own estimate (1100043) already tracked
the insert because it scales `reltuples` by the current page count.

### RW06 - n_live_tup after an insert and VACUUM (ANALYZE) on one connection

| target | rows | same connection: n_live_tup (3 reps) | two connections: n_live_tup | insert ms (3 reps) |
|---|---|---|---|---|
| pg15 | 1000 | 2000,2000,2000 | 1000,1000,1000 | 3.8,2.7,4.2 |
| pg15 | 10000 | 20000,20000,20000 | 10000,10000,10000 | 19.5,21.1,21 |
| pg15 | 100000 | 200000,200000,200000 | 100000,100000,100000 | 116.6,117.7,117.4 |
| pg15 | 1000000 | 2000000,2000000,2000000 | 1000000,1000000,1000000 | 922,936.5,941.9 |
| pg17 | 1000 | 2000,2000,2000 | 1000,1000,1000 | 1.6,2.6,4.3 |
| pg17 | 10000 | 20000,20000,20000 | 10000,10000,10000 | 11,12.8,11.5 |
| pg17 | 100000 | 200000,200000,200000 | 100000,100000,100000 | 120.1,120.6,121.4 |
| pg17 | 1000000 | 2000000,2000000,2000000 | 1000000,1000000,1000000 | 938.6,988.7,931.1 |
| supabase | 1000 | 2000,2000,2000 | 1000,1000,1000 | 2.2,3.7,2.5 |
| supabase | 10000 | 20000,20000,20000 | 10000,10000,10000 | 20.3,20.9,20.7 |
| supabase | 100000 | 200000,200000,200000 | 100000,100000,100000 | 110.9,113.4,116.6 |
| supabase | 1000000 | 2000000,1000000,2000000 | 1000000,1000000,1000000 | 905,1013.1,842.6 |

35 of 36 same-connection reps read exactly double the row count; the one that
did not is the only rep whose insert took over a second (1013.1 ms). That fits
the documented flush rule (a backend flushes when it goes idle, at most once
per second): a quick insert's counters are still pending when VACUUM writes
its absolute count, and the later flush adds the insert on top. RW04's fixture
inserts two 1,000,000-row tables before its VACUUM and read the true count.
The flush timing itself was not instrumented, so the mechanism is the
reading that fits, not a measurement.

### What this run shows

- A plain upsert or UPDATE of unchanged rows writes a full new version of
  every row on all three servers: 1,000,000 versions and 1,000,000 dead tuples
  at 1,000,000 rows, heap 76562432 -> 153124864 bytes, 400162756 bytes of WAL
  for the upsert with a checkpoint just before it (pg17).
- `DO UPDATE ... WHERE (...) IS DISTINCT FROM (...)` stops the versions and
  the dead tuples but not the row locks: 0 versions, 1,000,000 rows locked,
  130271034 bytes of WAL (54000000 in the no-FPI regime), and 4243.61 ms
  against 5598.37 ms for the plain upsert (pg17).
- `suppress_redundant_updates_trigger()` behaves the same way: 0 versions,
  1,000,000 rows locked, 130271034 bytes of WAL, on UPDATE and on the
  upsert path.
- Filtering before the write removes all of it for unchanged rows: a WHERE
  guard on UPDATE, an anti-join before `INSERT ... ON CONFLICT`, or a guarded
  `MERGE` wrote 0 bytes of WAL and locked 0 rows on identical batches.
- With 1% of rows changed, WAL is set by pages touched, not rows changed, when
  the change lands on the first touch after a checkpoint: 10,000 changed rows
  spread one per page wrote 12080 FPI and 99462572 bytes through the
  pre-filtered upsert, against 2994760 bytes in the no-FPI regime.

### Not measured

- Anything on a hosted project: the Supabase disk IO budget, IOPS and
  throughput ceilings, burst behaviour, gp3 vs io2, and how WAL bytes or
  dirtied pages translate into the IO a host bills or throttles.
- Disk read latency: the cold count(*) read through the macOS page cache.
- Concurrency: two writers upserting the same rows, and what the pre-filter
  does when a concurrent writer changes a row between the anti-join and the
  insert.
- Secondary indexes, TOASTed values, fillfactor below 100 (HOT updates), and
  batches sent from a client as VALUES or unnest() rather than read from a
  table.
- `wal_compression` on (off on all three servers here).
- The cause of the ON CONFLICT execution-time gap between the Alpine images
  and the Supabase image.
- The scratch run before this experiment (2026-10-08, earlier the same day; a
  one-off, not a module; manual: PG 15, 100,000 identical rows, 28.5 MB and
  5.8 MB of WAL) was not part of this record; its WAL figures fall
  between this run's two regimes for that size (RW02 40021870 and 13027115
  bytes, RW05 30363218 and 5400000, both pg17) and are not cited.
