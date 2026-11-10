# RUNLOG - pg17-extensions

Vantage: one macOS machine in Singapore (Bun 1.3.14), projects in
ap-southeast-1 on a Team-plan organization, created by the module and deleted
in its `finally`. Figures are quoted from the published artifact; the raw
artifact is in `evidence/` (gitignored).

| module | artifact | note |
|---|---|---|
| PX01 | `out/2026-11-10/run-2026-11-10T09-16-49-541Z.json` | one run; the artifact names lab commit 6e78709, the module itself was first committed with this write-up, after the run (at least the PX01a title text has changed since) |

## PX01 - TimescaleDB before Postgres 17

One run, 2026-11-10 09:16 to 09:19 UTC. P was created with
`postgres_engine: "15"` and T with no engine; neither create call set a compute
size, so both ran at the size the API assigns when none is set (the artifact's
PX01a title says Micro, which was not read back). Hypertables use 1-day chunks over 30 days of
generated rows.

Docs say (read 2026-11-10): `timescaledb` is deprecated on Postgres 17 and must
be dropped before upgrading; for hypertables, convert to native partitioning
managed by `pg_partman`
(https://supabase.com/docs/guides/database/extensions/timescaledb). The guide
(`migrating-to-pg-partman`) renames the hypertable, creates
`(like ... including all, primary key (sent_at, id)) partition by range`, copies
with `insert ... select *`, drops the hypertable and the extension, and only
then calls `partman.create_parent`.

- PX01a (pass): P 15.19 lists `pg_cron 1.6.4, pg_partman 5.3.1, timescaledb
  2.16.1`; T 17.11 lists `pg_cron 1.6.4, pg_partman 5.3.1` and no
  timescaledb.
- PX01b (pass): `create extension timescaledb with schema extensions`
  succeeded on P: version 2.16.1, `timescaledb.license` `apache`.
- PX01c (pass, meaning the fixture was built): `messages` (`id bigint generated always as identity`,
  primary key `(id, sent_at)`) and `events` (no primary key), 300,000 rows
  each, 31 chunks each. Compression (`alter table ... set
  (timescaledb.compress ...)`), a continuous aggregate and
  `add_retention_policy` were each refused with SQLSTATE 0A000,
  `not supported under the current "apache" license`.
  `timescaledb_information.jobs` listed 3 jobs, which were not identified.
- PX01d (pass): `GET /v1/projects/{ref}/upgrade/eligibility` answered 200,
  `eligible` false, `validation_errors`
  `[{"type":"unsupported_extension","extension_name":"timescaledb"}]`,
  `warnings` `[]`.
- PX01e (fail, which is the result): `create publication px_ht for table
  public.messages` on P succeeded and `pg_publication_tables` listed 32
  tables, 31 of them in `_timescaledb_internal` (the chunks; alphabetically
  first `_timescaledb_internal._hyper_1_10_chunk`). `create subscription` on T, into
  a plain `public.messages`, failed with SQLSTATE 3F000 `schema
  "_timescaledb_internal" does not exist`. 60 s later T held 0 rows. P then
  took 200 more rows (100 into an existing chunk, 100 into a new chunk 10 days
  ahead), reaching 300,200; 30 s later T still held 0, including 0 of the
  200.
- PX01f (pass, meaning both renames ran; the guide's statements failed as
  below): the guide verbatim. On `messages`, the `create table (like
  public.ht_messages including all, primary key (sent_at, id)) partition by
  range (sent_at)` failed with SQLSTATE 42P16 `multiple primary keys for
  table "messages" are not allowed`. On `events` the same statement
  succeeded, and `insert into public.events select * from public.ht_events`
  failed with SQLSTATE 23514 `no partition of relation "events" found for
  row`.
- PX01g (pass): a corrected order. `pg_partman` 5.3.1 in schema `partman`;
  `partman.create_parent(... p_interval := '1 day', p_premake := 7,
  p_start_partition := <first day of the data>)` before each copy.
  `events` (guide's `create`, then `create_parent`): 300,000 rows copied in
  2178 ms; `events` then had 39 child partitions including the default, 0
  rows in the default. `messages`
  (`like ... including defaults including constraints including identity
  including generated`, primary key `(sent_at, id)`): `insert ... select *`
  failed with SQLSTATE 428C9 (`id` is `GENERATED ALWAYS`); `insert ...
  overriding system value select *` copied 300,200 rows in 1294 ms, 100 of
  them into the default partition (by date, PX01e's 100 rows 10 days ahead,
  past the 7 premade days). The next insert without an id got id 1 while `max(id)`
  was 300200, and 2 rows then had id 1; the primary key `(sent_at, id)` did
  not refuse it. After `select setval(pg_get_serial_sequence('public.messages',
  'id'), (select max(id) from public.messages))` the next insert got 300201. `drop table` on both
  hypertables, `drop extension timescaledb`, `call
  partman.run_maintenance_proc()` and the guide's `select
  cron.schedule('@daily', $$call partman.run_maintenance_proc()$$)` (job 1)
  all succeeded.
- PX01h (pass): eligibility after the drop answered 200, `eligible` true,
  `validation_errors` `[]`.
- PX01i (pass): `create publication px_np for table public.messages with
  (publish_via_partition_root = true)` on the partitioned table; a
  subscription on T into a plain `public.messages`; every table `r` at the
  first 10 s check; 300,202 rows on both. 100 rows inserted on P dated 3 days ahead (a
  premade partition) and 100 dated 30 days ahead (the default partition,
  which then held 200) reached T within 30 s: 300,402 rows, 100 and 100.
- PX01p: both projects deleted (200, 200).

Reading PX01 (one run):

- On this 15.19 project `timescaledb.license` read `apache`, and compression,
  continuous aggregates and retention policies were refused; changing the
  setting was not tested. With it at `apache` a project holds plain
  hypertables only, so there is no compressed data to expand and no aggregate
  to rebuild before a move.
- A hypertable cannot be replicated as-is to Postgres 17: the publication
  carries the chunk tables and the subscription fails on the missing
  `_timescaledb_internal` schema. Converting to native partitioning on 15 first
  and publishing with `publish_via_partition_root` worked, including rows
  that arrive after the copy in a premade partition or the default
  partition.
- The guide as written failed on both shapes. Three changes made it work:
  replace `including all` with `including defaults including constraints
  including identity including generated` when the hypertable already has a
  primary key (tested on `(id, sent_at)`; dropping the guide's `primary key
  (sent_at, id)` instead was not tried, and TimescaleDB's rule that the key
  includes the time column was not tested here);
  call `create_parent` before the copy; and for an identity column, copy with
  `overriding system value` and move the sequence past `max(id)` afterwards.
  Skipping the sequence move fails silently: the next insert got id 1 while
  `max(id)` was 300200, 2 rows had id 1, and no error was raised.

Not measured: a copy at production size (`events`, 300,000 rows, took
2178 ms and `messages`, 300,200 rows, took 1294 ms, one sample each), what writers see between the guide's rename and the copy, application
SQL that calls `time_bucket()` or other timescaledb functions, hypertables
with foreign keys or space partitioning, what the 3 jobs were, pg_partman
retention, and an in-place upgrade after the conversion (eligibility only).
