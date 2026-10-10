# orioledb - RUNLOG

Hosted projects only, created and deleted through the Management API (see
README.md for the method). Dated 2026-10-10. Vantage: one machine, through the
session-mode pooler, 7.1 to 7.8 ms round trip to the pooler (OR05-rtt, `select 1`,
1 client). Region `ap-southeast-1`, compute `small`, Pro org. Every figure
below is pasted from the published artifacts in `out/2026-10-10/` (the
redacted copies of `evidence/`), except figures marked (manual), which were read
from an ad-hoc call during development and are not in an artifact, and figures
marked (derived), which are a division of two pasted figures.

Sources for the claims under test, all read 2026-10-10: the public beta
changelog entry (https://supabase.com/changelog/orioledb-public-beta), the launch post
(https://supabase.com/blog/select-2026-scale-without-limits) and the OrioleDB
guide (https://supabase.com/docs/guides/database/orioledb). The claims, and what
this experiment did with each:

| claim (source) | measured here? |
|---|---|
| no table bloat, no VACUUM (launch post) | partly: OR04 (ten all-row UPDATE rounds) and the VACUUM columns of OR02/OR03; one table shape, one size, no long-running readers |
| up to 1.8x throughput vs heap, TPC-C-derived, 8xlarge (guide, launch post) | not tested; OR05 is a 30 s TPC-B-like run on `small` |
| 64-bit transaction ids (launch post) | not tested; OR06b records types and small values only |
| per-table `USING heap` / `USING orioledb` (launch post) | yes: OR02 to OR06 |
| chosen at project creation, cannot be added or removed later (guide) | not tested |
| Free, Pro, Team and Enterprise can create OrioleDB projects (changelog) | yes: OR01c, OR10 |

## Runs and artifacts

All carry `lab commit 70e4244`, the repo HEAD underneath the uncommitted
experiment files, not the module source.

| run | artifact | what | result |
|---|---|---|---|
| A | `run-2026-10-10T07-19-18-849Z` | OR01 to OR10 and OR99, one self-provisioned set of 5 projects | 70 results. OR02 heap-control 1,000,000-row cases failed (disk full, below); OR03 threw (heap control unreachable), so none of its results were kept; OR04a for the heap control failed |
| B | `run-2026-10-10T07-57-30-073Z` | OR01 to OR04 on the heap control and the OrioleDB project's heap table, with disk diagnostics | 39 results; the heap-control 1,000,000-row upsert cases failed again |
| C | `run-2026-10-10T08-26-25-074Z` | OR02, OR03 on the OrioleDB table, 100,000 and 1,000,000 rows | 21 results, 0 fail |
| D | `run-2026-10-10T08-26-28-591Z` | OR03, OR04 on the heap control, 100,000 rows | 12 results |
| E | `run-2026-10-10T08-26-31-893Z` | OR02 on the heap control, 1,000,000 rows, default 2 GB disk | 8 results; both cases failed |
| F | `run-2026-10-10T08-44-06-736Z` | OR02, OR03 on the heap control, 1,000,000 rows, disk set to 8 GB first | 10 results, 0 fail |

An earlier full run the same day ended when the process died in OR08 (the
server closed a connection, the client library raised an unhandled `error`
event, and no artifact is written until a run ends). Its projects were deleted
and its console log is not published; `lib/pair.ts` now handles that event. In
that run one heap-control `pgbench` cell hung for about 27 minutes until I killed the
process (the module now bounds each `pgbench` run). Runs B to F exist because
run A lost the heap-control cells and OR03; they reuse the same modules with
`OR_TARGETS`, `OR_SIZES` and `OR_NO_EXTRAS` narrowing them, and each created
and deleted its own pair (OR99).

## OR01 - the pair, and what the hosted role can do

Run A for server facts, run C for the disk size (OR01a records it from run B on).

- Create body. `POST /v1/projects` with `postgres_engine: "17-oriole"` produced
  a project whose `GET /v1/projects/{ref}` reads `database.postgres_engine`
  `17-oriole`, `release_channel` `ga`, `database.version` `orioledb`; the control
  (field omitted) reads `17`, `ga`, `17.11.0.003` (OR01a). The published
  OpenAPI document (`api.supabase.com/api/v1-json`, fetched 2026-10-10 (manual))
  types `postgres_engine` and `release_channel` on that create body as
  deprecated `null`; branch creation lists `17-oriole`. The field was accepted
  and applied on the create route.
- Servers (OR01b). OrioleDB project: PostgreSQL 17.6 on aarch64, `orioledb 1.6`,
  `orioledb_version()` reads `OrioleDB public beta 14`, `default_table_access_method`
  `orioledb`, `wal_compression` `pglz`, `shared_buffers` 512MB, `orioledb.main_buffers`
  65536 (blocks). Heap control: PostgreSQL 17.11 on x86_64, `heap`, `wal_compression`
  `zstd`, `shared_buffers` 512MB, no OrioleDB extension. Both: `wal_level`
  `logical`, `max_wal_size` 4GB, `checkpoint_timeout` 5min, `autovacuum` on,
  `data_checksums` on. The pair therefore differs in Postgres build, CPU
  architecture and `wal_compression`, not only in storage engine.
- Hosted role. `postgres` is not a superuser, has `rolreplication` true and no
  `pg_checkpoint`; `CHECKPOINT` answers `permission denied to execute CHECKPOINT
  command` on both projects. OR02 to OR04 therefore ran without the
  checkpoint the local rig issued before each statement.
- `xmin` on an OrioleDB table: `orioledb tuples does not have system attribute:
  xmin`; `ctid` reads. On the heap table `xmin` reads. OR02/OR03 row-version
  counts exist for heap tables only.
- Disk (run C, OR01a): the OrioleDB project was created with an 8 GB gp3 disk
  and the heap control with 2 GB (same compute size, gp3, 3000 IOPS, 125 MiB/s
  on both). A manual read of a heap control from run B about 12 minutes after
  its creation showed `size_gb` 8 with a `last_modified_at` after creation
  (manual), consistent with the platform's disk autoscaling; the autoscale
  trigger was not probed.
- Entitlements (OR01c, `GET /organizations/{slug}/entitlements`): `instances.orioledb`
  `hasAccess=true` on the Pro, Team and Free orgs; `pitr.available_variants`
  `pitr_7|pitr_14|pitr_28` on Pro and Team, empty on Free; `replication.etl`
  true on Pro and Team, false on Free.
- OR01d: on the heap control `CREATE EXTENSION orioledb` and `CREATE TABLE ...
  USING orioledb` fail (`access method "orioledb" does not exist` for the
  table); the extension is absent from `pg_available_extensions`.

## OR10 - a Free org creates an OrioleDB project

`POST /v1/projects` in the Free org with `postgres_engine: "17-oriole"` and no
compute size: 201, `ACTIVE_HEALTHY`, `postgres_engine` `17-oriole`,
`orioledb_version()` `OrioleDB public beta 14`, `shared_buffers` 224MB,
`orioledb.main_buffers` 224MB. An earlier assumption was Pro and up; the
changelog says Free, Pro, Team and Enterprise, and this call agrees with the
changelog (one call, one Free org).

## OR02 / OR03 - redundant writes

Unchanged-row `INSERT ... ON CONFLICT DO UPDATE` and `UPDATE ... FROM` batch,
the statements of `experiments/redundant-writes`. Medians of 3 reps, each on a
fresh fixture, checkpoint state unknown (no `CHECKPOINT`); `wal_fpi` was 0 in every
100,000-row cell and 2 in the 1,000,000-row plain heap cells. Cell = WAL bytes
across the transaction (`pg_current_wal_insert_lsn()` diff) / row versions by
`xmin` (n/a on an OrioleDB table) / `n_dead_tup` delta / table size after, bytes.
Columns: `oriole_oriole` is an OrioleDB table in the OrioleDB project (run C),
`oriole_heap` a heap table in the same project (runs A and B), `heap_heap` a heap
table in the heap control (run B).

100,000 rows:

| case | oriole_oriole | oriole_heap | heap_heap |
|---|---|---|---|
| merge_guarded_1pct | 59064 / n/a / 1000 / 8445952 | 240744 / 1000 / 1000 / 7733248 | 248312 / 1000 / 1000 / 7733248 |
| merge_guarded_identical | 120 / n/a / 0 / 8445952 | 120 / 0 / 0 / 7659520 | 120 / 0 / 0 / 7659520 |
| update_guarded_identical | 192 / n/a / 0 / 8445952 | 120 / 0 / 0 / 7659520 | 184 / 0 / 0 / 7659520 |
| update_plain_identical | 5786176 / n/a / 100000 / 8445952 | 25330048 / 100000 / 100000 / 15319040 | 25337536 / 100000 / 100000 / 15319040 |
| update_trigger_identical | 224 / n/a / 0 / 8445952 | 5616584 / 0 / 0 / 7659520 | 5616552 / 0 / 0 / 7659520 |
| upsert_guarded_1pct | 59088 / n/a / 1000 / 8445952 | 5857280 / 1000 / 1000 / 7733248 | 5864776 / 1000 / 1000 / 7733248 |
| upsert_guarded_identical | 224 / n/a / 0 / 8445952 | 5616512 / 0 / 0 / 7659520 | 5616560 / 0 / 0 / 7659520 |
| upsert_plain_identical | 5786200 / n/a / 100000 / 8445952 | 30946504 / 100000 / 100000 / 15319040 | 30954048 / 100000 / 100000 / 15319040 |
| upsert_plain_trigger_identical | 224 / n/a / 0 / 8445952 | 5616560 / 0 / 0 / 7659520 | 5616560 / 0 / 0 / 7659520 |
| upsert_prefiltered_1pct | 59064 / n/a / 1000 / 8445952 | 297048 / 1000 / 1000 / 7733248 | 304480 / 1000 / 1000 / 7733248 |
| upsert_prefiltered_identical | 48 / n/a / 0 / 8445952 | 184 / 0 / 0 / 7659520 | 120 / 0 / 0 / 7659520 |

1,000,000 rows (four cases per target; the heap-control column is run F, its
disk set to 8 GB first):

| case | oriole_oriole | oriole_heap | heap_heap |
|---|---|---|---|
| update_guarded_identical | 112 / n/a / 0 / 84459520 | 112 / 0 / 0 / 76562432 | 120 / 0 / 0 / 76562432 |
| update_plain_identical | 57872376 / n/a / 1000000 / 84459520 | 251145760 / 1000000 / 1000000 / 153124864 | 251220680 / 1000000 / 1000000 / 153124864 |
| upsert_guarded_identical | 160 / n/a / 0 / 84459520 | 56164640 / 0 / 0 / 76562432 | 56164712 / 0 / 0 / 76562432 |
| upsert_plain_identical | 57864400 / n/a / 1000000 / 84459520 | 309578424 / 1000000 / 1000000 / 153124864 | 309558040 / 1000000 / 1000000 / 153124864 |

Server execution time of the plain upsert, ms, median of 3 and (min-max); same
instance for the two columns, two independent runs each (A and B for
`oriole_heap`, A and C for `oriole_oriole`). `heap_heap` is not compared on
time: different Postgres build and architecture.

| rows | oriole_oriole | oriole_heap |
|---|---|---|
| 100000, run A / run B or C | 584 (559-675) / 534 (532-562) | 863 (862-870) / 826 (825-863) |
| 1000000, run A / run B or C | 5447 (5388-5548) / 5413 (5382-5467) | 9120 (8939-9716) / 8995 (8763-11526) |

Measured:

- An unchanged-row upsert or UPDATE on an OrioleDB table wrote `57.9` bytes of
  WAL per row (derived: 5,786,200 / 100,000; 57,864,400 / 1,000,000) against
  `309.5` on a heap table (derived: 30,946,504 / 100,000; 309,578,424 /
  1,000,000), roughly one fifth. The OrioleDB table's size did not change
  (8,445,952 bytes before and after at 100,000 rows); the heap table's doubled
  (7,659,520 to 15,319,040).
- Every guard that stopped the write on a heap table also left the OrioleDB
  table at about 0 bytes (`merge_guarded_identical` 120 on both;
  `upsert_prefiltered_identical` 48 against 120 to 184).
- The guarded upsert and the `UPDATE` suppress trigger, which lock every row on a
  heap table, wrote `56.2` bytes of WAL per row there (derived: 5,616,512 /
  100,000; 56,164,640 / 1,000,000) and 224 bytes in total on the OrioleDB table
  (160 at 1,000,000 rows). Whether OrioleDB takes row locks without logging
  them was not separated from the statement not reaching a row write; only
  the WAL figure is measured.
- With 1% of rows changed, the guarded upsert wrote 59,088 bytes on the
  OrioleDB table against 5,857,280 on heap, of which 5,616,512 is the lock
  cost of the unchanged rows above.
- `n_dead_tup` rose by the number of updated rows on the OrioleDB table too
  (100,000 after the plain statement), though its size did not move and a manual
  `VACUUM (VERBOSE)` printed no section for the table (`vacuum_visits_table` 0;
  only its TOAST relation). On OrioleDB tables that counter is a statistics
  number, not a count of retained row versions (see OR04).
- A manual `VACUUM` of the heap table after the plain statement wrote 1,110,614
  bytes of WAL and took 71 to 96 ms at 100,000 rows (8,894,972 to 11,102,428
  bytes, 375 to 747 ms at 1,000,000); on the OrioleDB table it took 7.2 to 8.5 ms and
  logged nothing for the table. The millisecond figures are ranges of per-cell medians; the
  per-cell min-max (from the artifacts) is wider: the heap plain-statement cells
  span 69.5 to 113.2 ms at 100,000 rows and 369.9 to 1,622.6 ms at 1,000,000,
  and the OrioleDB cells 6.2 to 10.3 ms.
  The heap and OrioleDB ranges do not overlap at either figure, but the ratio
  between them is not pinned down.
- Pre-filtering the batch, the `WHERE` guard on `UPDATE`, MERGE and the built-in
  `suppress_redundant_updates_trigger()` all ran on the OrioleDB table; the
  trigger cases wrote 224 bytes there against 5,616,552 on heap.
- On OrioleDB tables `EXPLAIN (ANALYZE, WAL)` and the LSN diff agree at these
  sizes (5,762,249 vs 5,786,200 bytes at 100,000 rows, the difference being the
  commit record and other background WAL). A development smoke at 10,000 rows
  with 1% changed (manual, not published) showed `EXPLAIN` WAL 0 against an LSN
  diff of 6,048, so for small OrioleDB writes read the LSN diff.

Heap-control disk (OR02 runs A, B, E): the 1,000,000-row plain upsert on the heap
control (2 GB disk at creation, OR01a) failed in every one of those runs, in
the first case: `could not extend file ...: No space left on device` (run A),
`Connection terminated unexpectedly` (runs B and E); the server went into
recovery, and the next case in the module failed with `econnrefused` or
`No space left on device`. In run E the two completed reps recorded
`pg_ls_waldir()` at 687,866,220 then 1,290,535,276 bytes and
`pg_stat_archiver.archived_count` 35 then 65 with `failed_count` 0 on a project
where `walg_enabled` is true (OR09a); on the OrioleDB project, where
`walg_enabled` is false, `archived_count` stayed 0 and the same statement
completed. WAL per statement was 303 to 312 MB, so retained WAL plus the
fixture exhausted a 2 GB disk. Run F set the control's disk to 8 GB first
(`POST /v1/projects/{ref}/config/disk`) and the same cases completed (3 reps,
0 fail). Not isolated: whether WAL archiving, `max_wal_size` or checkpoint
timing explains the retention, and whether an 8 GB disk would survive a
longer sequence.

## OR04 - ten all-row UPDATE rounds, and autovacuum

OR04a, 100,000 rows, autovacuum disabled by reloption (accepted on both
engines), ten plain `UPDATE ... FROM src` rounds. Run A for `oriole_oriole` and
`oriole_heap`, run D for `heap_heap`.

| | oriole_oriole | oriole_heap | heap_heap |
|---|---|---|---|
| table size before | 8445952 | 7659520 | 7659520 |
| table size after round 10 | 8445952 | 84148224 | 84148224 |
| index size after round 10 | 0 | 6668288 | 6668288 |
| `n_dead_tup` after round 10 | 1000000 | 999353 | 999353 |
| WAL bytes, round 1 / all ten rounds | 5786096 / 57860696 | 25330256 / 249307680 | 25337520 / 249329008 |
| size after `VACUUM` | 8445952 | 84148224 | 84148224 |
| `VACUUM FULL` | refused | ok, 7659520 | ok, 7659520 |

`VACUUM FULL` on the OrioleDB table: `orioledb table "t" does not support VACUUM
FULL`. With autovacuum off, the heap table grew from 7,659,520 to 84,148,224
bytes in ten rounds and an ordinary `VACUUM` did not shrink it; the OrioleDB
table did not grow.

OR04b (run A), same project, autovacuum on, one OrioleDB and one heap table of
100,000 rows, three all-row rounds, polled every 15 s for 181 s: both tables
showed `n_dead_tup` 300,000 at 0 s. The heap table's `autovacuum_count` became 1
at 45 s (`n_dead_tup` 0 afterwards, size 30,621,696 bytes against 7,659,520 at
the start). The OrioleDB table's `autovacuum_count` stayed 0 with `autoanalyze_count` 1;
its `n_dead_tup` fell to 0 anyway and its size stayed 8,445,952. Whether a
background worker acted on the OrioleDB table beyond the auto-analyze was not
separated.

## OR05 - pgbench

Scale 20 (2,000,000 accounts), tables built by SQL in one schema per target
(OR05 header), 30 s per run, 2 runs per cell in alternating target order after
a discarded 15 s warm-up. Clients: 12 (the session-mode pooler answered
`EMAXCONNSESSION ... max clients are limited to pool_size: 15` above 15 in a
smoke run (manual)). Each cell is: mean tps of the two runs (range) / server-side
mean statement time per transaction in ms, from `pg_stat_statements` deltas. No
transaction failed in any cell. Run A.

| script, clients | oriole_oriole | oriole_heap | heap_heap |
|---|---|---|---|
| tpcb_like (7 round trips), 12 | 212 (202-222) / 1.958 | 214.1 (207-221) / 2.051 | 208.6 (206-211) / 2.434 |
| tpcb_fn (1 round trip), 12 | 1205 (1059-1352) / 0.387 | 1278 (1248-1308) / 0.429 | 1092.8 (995-1190) / 0.723 |
| tpcb_fn, 4 | 466.3 (466.1-466.5) / 0.229 | 463.3 (462.9-463.6) / 0.265 | 401.8 (384.7-418.9) / 0.376 |
| select_only, 12 | 1625 (1572-1678) / 0.019 | 1517 (1462-1573) / 0.044 | 1508 (1506-1511) / 0.066 |

The `tpcb_like` cells sit at the round-trip bound: 12 clients over 7 round
trips of about 8 ms is about 214 per second (derived), the measured value for
all three targets. `tpcb_fn` went from 466 to 1205 tps between 4 and 12
clients on the OrioleDB table, 2.6x (derived) for 3x the clients. Between the two
tables of the same project (`oriole_oriole` vs `oriole_heap`) the two-run ranges
overlap for `tpcb_like`, for `tpcb_fn` at 12 clients and for `select_only` (by
1 tps); at 4 clients they do not overlap (466.1 to 466.5 against 462.9 to 463.6,
under 1% apart, derived). No difference between an OrioleDB and a heap table in one project is
resolvable at this run count (two runs of 30 s per cell, one size, three client
counts); the `select_only` means differ by about 7% (1625 vs 1517 tps) and their
ranges barely overlap. The
heap-control column differs from the others in Postgres build and
architecture as well (OR01b), and was not the same disk size. Table sizes after
all runs (OR05-sizes): `pgbench_accounts` 297,893,888 bytes on the OrioleDB
table, 273,080,320 and 273,121,280 on the two heap tables; `autovacuum_count` on
the three small tables was 0 on the OrioleDB table set and between 8 and 11 on
the heap table sets.

Not run: the vendor's 8xlarge TPC-C-derived benchmark, runs longer than 30 s,
more than 12 clients, a vantage inside the region.

## OR06 - feature battery and mixed access methods

Run A, a separate `scratch` OrioleDB project, one execution per statement.
Of 37 probes, 31 behaved as expected (ok, or for `fk_violation_enforced` the
violating row was refused) and 6 refused. Refused, verbatim:

| probe | server answer |
|---|---|
| `CREATE INDEX CONCURRENTLY` | `concurrent index creation is not supported for orioledb tables yet` |
| `SERIALIZABLE` transaction | `orioledb does not support SERIALIZABLE isolation level` |
| `VACUUM FULL` | `orioledb table "f_o" does not support VACUUM FULL` |
| `CLUSTER` | `orioledb tables does not support CLUSTER` |
| `ALTER TABLE ... SET ACCESS METHOD heap` | `changing access method is not supported for OrioleDB tables` |
| `ALTER TABLE ... SET ACCESS METHOD orioledb` (on an OrioleDB table) | `changing access method is not supported for OrioleDB tables` |

Accepted (ok): GIN on `jsonb` and `tsvector`, GiST on a range and a point, BRIN,
hash, expression, partial, unique-secondary and INCLUDE indexes; foreign keys
heap to OrioleDB and OrioleDB to heap; `BEFORE UPDATE` trigger; an RLS policy;
`REPEATABLE READ`; `FOR UPDATE SKIP LOCKED`; `TRUNCATE`; `UNLOGGED` and `TEMP`
tables; an OrioleDB partition of a partitioned table; `ADD COLUMN ... DEFAULT`,
`DROP COLUMN`, `ALTER COLUMN TYPE`; `REPLICA IDENTITY FULL`; a 1,000,000-byte
`text` value; a table with no primary key; `VACUUM`, `REINDEX`, `ANALYZE`; and
`CREATE INDEX ... USING hnsw` plus an ordered query on a `pgvector` column of an
OrioleDB table (the probe checks that the statements run without error, not the
result). The guide says non-B-tree index types run through an index access
method bridge; a development probe printed `NOTICE: index bridging is enabled
for orioledb table 'f_o'` for GIN (manual).

OR06b: a join across a heap and an OrioleDB table returned 100 rows; one
transaction inserting into both committed (1 row each), a second rolled back (still
1 row each). Transaction ids: `orioledb_get_current_oxid()` 504, type `bigint`;
`pg_current_xact_id()` 1292, type `xid8`; `age(datfrozenxid)` 563. That records
types and small values; nothing here exercised the 64-bit claim.

## OR07 - logical replication, Realtime, Data API (scratch OrioleDB project)

One sequence per table (3 INSERT, 2 UPDATE, 1 DELETE), OrioleDB table and heap
table side by side, run A.

- OR07a: `CREATE PUBLICATION` ok, `pg_create_logical_replication_slot(..., 'pgoutput')`
  ok, decode ok for both tables. Messages by first byte, identical for both:
  B 6, C 6, I 3, U 2, D 1, R 1. Slots left after cleanup: 0. No subscriber
  was attached, so a downstream Postgres subscriber and Replication/ETL are
  not measured.
- OR07b: both tables added to `supabase_realtime` ok; the channel joined
  (`Subscribed to PostgreSQL`); events received, OrioleDB table INSERT 3, UPDATE 2,
  DELETE 1 (6 of 6), heap table the same.
- OR07c: `GET /rest/v1/<table>` 200 and `POST` 201 on both after an explicit
  `GRANT` to `anon` (response body 40 bytes each).

## OR08 - converting a heap table with `ALTER TABLE ... SET ACCESS METHOD orioledb`

The guide text read 2026-10-10 says an OrioleDB project cannot be added to an
existing project; it does not mention per-table conversion. A manual probe
while developing OR06 showed the statement is accepted when the table is heap.

OR08 (run A, two fresh OrioleDB projects, one shape each):

- OR08a, empty heap table with a primary key: `ALTER TABLE` returned
  `Connection terminated unexpectedly`; the next connection succeeded 3 s later and
  `select count(*)` on the table worked; project status `ACTIVE_HEALTHY`.
- OR08b, heap table with a foreign key to an OrioleDB table: `ALTER TABLE`
  returned ok; the following `INSERT` returned `Connection terminated
  unexpectedly`; reconnected after 3 s, `select count(*)` ok.

Two recorded attempts (OR08a, OR08b), both ended the backend connection and
both were reachable again after 3 s. Earlier the same day, while developing
OR06, two other projects were probed by hand; those observations were not
saved (no psql output or log excerpt is in the evidence, so treat them as
unverified, n=1 per shape) and no tally is drawn from them. They suggested that
a converted table can leave the server in a crash loop (log lines about a
startup process terminated by a signal, `unable to start recovery workers`)
that a project restart did not clear. OR08 did not reproduce that: its two
recorded projects recovered, and the platform's log query returned no matching
rows for them within the module's window (`log_signal_lines` 0), so no
segfault or recovery-worker line is published. Not isolated: whether a
converted table can wedge the server, what separates a 3 s recovery from a
loop (table shape, a prior checkpoint, or timing), and the instance-level cause.
All four projects were deleted.

## OR09 - PITR

`GET /billing/addons` lists `pitr_7`, `pitr_14`, `pitr_28` for both projects.
`GET /database/backups`: OrioleDB project `walg_enabled` false,
`daily_backups_listed` 0; heap control `walg_enabled` true,
`daily_backups_listed` 1; `pitr_enabled` false on both.

`PATCH /billing/addons` with `{addon_type: "pitr", addon_variant: "pitr_7"}`:

- OrioleDB project: HTTP 400, `{"message":"Projects using the OrioleDB Technical
  Preview image do not support PITR addon."}`. The message says "Technical
  Preview"; the changelog says public beta.
- Heap control: HTTP 200; `pitr_enabled` read true 1 s after the first PATCH
  (that is the backups endpoint's flag, not a completed restore point).

No restore was attempted on either project. A development repeat on another
pair the same day (manual, not published) gave the same 400 and 200.

## What this experiment did not do

- Compute sizes other than `small`; regions other than `ap-southeast-1`; one
  Pro org, one Free org.
- The 8xlarge TPC-C-derived benchmark behind the 1.8x claim; any run longer
  than 30 s; secondary indexes in OR02 to OR04; long-running readers.
- The 64-bit transaction id claim; PITR restore; a logical-replication
  subscriber; Replication/ETL pipelines; Realtime with RLS.
- A checkpoint-controlled WAL comparison (the hosted role cannot checkpoint).
- Why the heap control's 2 GB disk filled (the WAL-retention explanation is
  not isolated), and whether a converted table can wedge the server (OR08).
