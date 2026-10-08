# redundant-writes

How much write work does an upsert or UPDATE of rows that did not change
cause in Postgres, and how much of it does each guard pattern remove? And how
far can `pg_class.reltuples` stand in for `count(*)`?

## Background

A write that re-sends rows the table already holds pays for every one of them
when it uses a plain `INSERT ... ON CONFLICT (id) DO UPDATE`: Postgres writes
a new row version whether or not any column changed. That is WAL, dirty pages
the checkpointer has to write back, a dead tuple per row for vacuum to remove,
and index entries when the update cannot be HOT. The question is which of
those writes a guard removes, and which guard removes all of them. This
experiment measures that across sizes, versions and guard patterns, and
records where the remaining WAL comes from.

## Method

Three throwaway containers, no managed project, no PAT, no tofu state
(`compose.yml`):

| target | image | why |
|---|---|---|
| `pg15` | `postgres:15-alpine` (15.19), pinned by digest | an older supported major |
| `pg17` | `postgres:17-alpine` (17.11), pinned by digest | current major |
| `supabase` | `public.ecr.aws/supabase/postgres:17.11.0.004`, pinned by digest | the Postgres image supabase CLI 2.120.0 starts for `supabase start` (tag read from the CLI binary), run standalone the way `checkpointer-reset` runs `supabase/postgres` |

The image's own `postgresql.conf` is used on each; RW01 records the settings
that move WAL volume (`full_page_writes`, `wal_compression`, `data_checksums`,
`wal_log_hints`, `wal_level`) and the autovacuum thresholds.

Fixture (`lib/rig.ts` `buildFixture`), rebuilt before every rep:
`t (id bigint primary key, a int, b text)` with N rows (`b` = 32-character
md5 text) and a batch table `src` with the same N ids, either identical to
`t` or with 1% of rows (`id % 100 = 0`) carrying a changed `b`. Both tables
have autovacuum disabled (reloption) and are vacuumed and analysed before the
statement, so there are no dead tuples, and hint bits and the visibility map
are set. Primary key only, no secondary index, fillfactor 100.

Measurement (`lib/rig.ts` `measure`), one statement per fixture:

- New row versions and rows carrying the statement's xid in `xmax`, counted
  inside the statement's own transaction before `COMMIT` (xmin/xmax against
  `pg_current_xact_id()`), so no post-commit scan prunes the pages first.
- WAL records, full-page images (FPI) and bytes from
  `EXPLAIN (ANALYZE, WAL, BUFFERS, TIMING OFF)`, plus the
  `pg_current_wal_insert_lsn()` diff across the transaction.
- Shared buffers hit, read, dirtied and written.
- `n_tup_upd`, `n_tup_hot_upd`, `n_dead_tup` deltas from
  `pg_stat_user_tables`, read on a new connection after the measuring
  connection called `pg_stat_force_next_flush()` (when the server has it,
  checked with `to_regproc`) and disconnected. Cumulative statistics are
  flushed asynchronously from PG 15 on; a same-session read can show the old
  value.
- Heap and index size before and after, whether `n_dead_tup` crosses the
  server's autovacuum vacuum threshold, and the WAL, tuples removed and time
  of a manual `VACUUM (VERBOSE)` afterwards (parsed from its own INFO
  output).

Two checkpoint regimes: RW02/RW03 checkpoint right before the statement (every
page's first touch writes an FPI, the worst case); RW05 checkpoints before the
fixture build (pages already logged this cycle, almost no FPI). Real runs land
between the two.

Modules:

| id | what |
|---|---|
| RW01 | server version, WAL-relevant settings, `pg_stat_force_next_flush` and `suppress_redundant_updates_trigger` present |
| RW02 | upsert cases: plain, `DO UPDATE ... WHERE (...) IS DISTINCT FROM (...)` guard, pre-filtered batch (anti-join before `ON CONFLICT`), guarded `MERGE`; identical and 1% changed |
| RW03 | UPDATE cases: plain, `WHERE` guard, `suppress_redundant_updates_trigger()`; plain upsert with the trigger |
| RW04 | `count(*)` vs `reltuples` at the largest size, warm and cold (container restart + Docker VM page cache dropped); `n_live_tup` vs `reltuples` across `pg_stat_reset()`, a 10% insert with no ANALYZE, a clean restart and a SIGKILL |
| RW05 | RW02 + RW03 cases in the no-FPI regime |
| RW06 | `n_live_tup` after an insert and `VACUUM (ANALYZE)` on one connection vs two, at 1,000 to 1,000,000 rows |

The SQL for every case is verbatim in `lib/cases.ts`.

## Running

```
make all                      # up, run RW01-RW06, publish to out/<date>/, down
make local-up && make probe   # or step by step
make facts                    # newest run's measurements as markdown
make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
make local-down
```

Knobs: `RW_SIZES` (default `10000,100000,1000000`), `RW_REPS` (default 3),
`RW_TARGETS` (default `pg15,pg17,supabase`), `ONLY` (module ids). A smoke run:
`make all RW_SIZES=1000 RW_REPS=1`.

RW04 restarts and SIGKILLs the rig's containers and drops the Docker VM's page
cache (a privileged container writing `vm.drop_caches`), which evicts cached
pages for every container on the VM, not only this rig's.

## Not covered

- Hosted disk behaviour: the Supabase disk IO budget, IOPS and throughput
  ceilings, gp3 vs io2. Everything here is WAL bytes, buffers and row
  versions on a local Docker VM.
- Concurrency: two writers upserting the same rows.
- Secondary indexes, TOASTed columns, fillfactor below 100 (HOT updates).
- Batches sent from the client as `VALUES` or `unnest()` rather than read
  from a table.

Results: `RUNLOG.md`.
