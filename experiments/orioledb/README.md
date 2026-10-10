# orioledb

What an OrioleDB project does that a heap project does not, measured on
hosted projects: the redundant-writes counters (WAL, dead tuples, VACUUM, row
versions) for an unchanged-row UPDATE or upsert, a short pgbench pair, a heap
and an OrioleDB table side by side in one project, what refuses or crashes on
an OrioleDB table, and whether PITR, logical replication, Realtime and the
Data API work.

Sources for the claims under test: the public beta changelog
(https://supabase.com/changelog/orioledb-public-beta), the launch post
(https://supabase.com/blog/select-2026-scale-without-limits) and the OrioleDB
guide (https://supabase.com/docs/guides/database/orioledb), all read
2026-10-10. This experiment measures; it does not repeat the vendor's
TPC-C-derived benchmark (dbarena).

## Method

Self-provisioning, no OpenTofu state. `lib/pair.ts` creates through the
Management API, in the Pro org (`PVLAB_ORG_PRO`), region `ap-southeast-1`,
compute `small`:

| project | how it is created | modules |
|---|---|---|
| oriole | `POST /v1/projects` with `postgres_engine: "17-oriole"` | OR01 to OR05, OR09 |
| heap | same call, field omitted | OR01 to OR05, OR09 |
| scratch | as oriole | OR06, OR07 |
| conva, convb | as oriole | OR08 |

The scratch and conversion projects exist so a statement that wedges the
server (OR08) cannot take the measured pair with it. OR10 creates and deletes
one more OrioleDB project in the Free org. Everything is deleted by OR99 (and
by a `beforeExit` / SIGINT hook).

Connections go through the session-mode pooler (the direct host is IPv6-only
and the pooler caps session-mode clients at 15). The hosted `postgres` role
is not a superuser and has no `pg_checkpoint` (OR01b), so the local rig's
`CHECKPOINT` before each statement is unavailable; fixtures are built right
before the statement and every rep records its full-page images.

The redundant-writes SQL is imported from
`experiments/redundant-writes/lib/cases.ts`, so the statements are the ones the
local containers ran. Per-table access method: the fixture is created
`USING heap` or `USING orioledb`, giving three targets: `oriole_oriole` (an
OrioleDB table in the OrioleDB project), `oriole_heap` (a heap table in the
same project) and `heap_heap` (a heap table in the heap control).

| id | what |
|---|---|
| OR01 | the create-body field read back, server identity per project, hosted-role privileges, org entitlements, an OrioleDB table on the heap control |
| OR02 | the upsert cases (plain, guarded, pre-filtered, MERGE; identical and 1% changed) on the three targets, 100,000 and 1,000,000 rows |
| OR03 | the UPDATE cases (plain, guarded, `suppress_redundant_updates_trigger()`) on the three targets |
| OR04 | ten all-row UPDATE rounds: size and `n_dead_tup` per round, VACUUM and VACUUM FULL; autovacuum on an OrioleDB table vs a heap table |
| OR05 | pgbench: tpcb-like, a one-round-trip tpcb function, select-only; the three targets |
| OR06 | a 37-statement battery on an OrioleDB table; heap and OrioleDB tables in one transaction; transaction-id facts |
| OR07 | publication and logical slot decoding, Realtime `postgres_changes`, Data API, OrioleDB table vs heap table |
| OR08 | `ALTER TABLE ... SET ACCESS METHOD orioledb` on a heap table, and what the server does next |
| OR09 | the PITR add-on on the OrioleDB project and the heap control |
| OR10 | creating an OrioleDB project in a Free org |
| OR99 | teardown |

## Running

```bash
# needs SUPABASE_ACCESS_TOKEN and PVLAB_ORG_PRO (and pgbench on PATH);
# PVLAB_ORG_TEAM / PVLAB_ORG_FREE add OR01c / OR10
cd experiments/orioledb
make probe                                   # OR01-OR10 then OR99, about 40 minutes
make facts                                    # newest run's measurements as markdown
make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
```

Knobs: `OR_SIZES` (default `100000,1000000`), `OR_REPS` (3), `OR_TARGETS`,
`OR_SIZE` (compute, default `small`), `OR_REGION`, `OR_PB_SCALE` / `OR_PB_CLIENTS`
/ `OR_PB_SECONDS` / `OR_PB_REPS` (20 / 12 / 30 / 2), `OR_AV_WAIT_S`,
`OR_RT_WAIT_S`, `OR_CONV_WAIT_S`, `OR_PITR_WAIT_S`, `OR_NO_EXTRAS` (skip the three
extra projects), `OR_HEAP_DISK_GB` (resize the heap control's disk after
creation; the control was created with 2 GB and the OrioleDB project with 8 GB,
and the control's 2 GB disk filled during the 1,000,000-row cases, RUNLOG OR02).
To iterate on a module
against projects you already have, export `PVLAB_PEER_ORIOLE`,
`PVLAB_PEER_HEAP` (and `PVLAB_PEER_SCRATCH`, `PVLAB_PEER_CONVA`,
`PVLAB_PEER_CONVB`) plus `DB_PASSWORD`; reused projects are never deleted.

OR08 can leave two projects unreachable; OR09 starts the PITR add-on's
billing on the two measured projects until they are deleted. Cost for one
run: five `small` projects for about 40 minutes.

## Not covered

- Compute sizes other than `small`, regions other than `ap-southeast-1`.
- Hosted disk behaviour at an IO budget limit; concurrency beyond the
  pgbench client count; secondary indexes in OR02 to OR04.
- Whether PITR restore works (OR09 records whether the add-on is accepted,
  not a restore).
- A downstream logical-replication subscriber and Replication/ETL pipelines
  (OR07 stops at the decoded stream).
- Postgres-version and CPU-architecture effects: the OrioleDB project and the
  heap control run different Postgres builds (OR01b), so the heap-control
  column differs from the OrioleDB-project columns in more than the storage
  engine. The same-project comparison (`oriole_oriole` vs `oriole_heap`) does
  not.

Results: `RUNLOG.md`.
