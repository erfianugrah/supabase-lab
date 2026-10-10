# pipelines

Supabase Pipelines (public alpha since 2026-07-21, renamed from Database
Replication on 2026-09-21): what can be measured about it without third-party
credentials, and what cannot.

Sources: https://supabase.com/changelog/pipelines,
https://supabase.com/docs/guides/database/replication/pipelines,
https://supabase.com/docs/guides/database/replication/pipelines/ducklake,
https://supabase.com/docs/guides/platform/manage-your-usage/pipelines.

## What is and is not driven here

The managed service is configured in the Dashboard. Its control plane is the
Dashboard's `/platform/replication/{ref}/...` route family, and a personal
access token is refused there (PL01), so no pipeline of the managed service is
created or operated by this experiment. Every figure about replication
behaviour comes from the open-source engine the docs say the managed service
runs (https://github.com/supabase/etl), started as a container from its public
image against a real Supabase Pro project. Read each figure as "the engine, at
the pinned commit, from a laptop" and not as a managed-service figure; the
RUNLOG says which claims that does and does not support.

Destination: DuckLake, with its Postgres catalog and S3-compatible object store
on local containers. A DuckLake destination needs no third-party account (the
managed form can use Supabase projects for both parts); BigQuery, ClickHouse
and Snowflake need accounts this lab does not have.

## Modules

| id | claim |
|---|---|
| PL01 | read-only: the public Management API description has no Pipelines route; a PAT is refused on the Dashboard's replication routes while the same PAT answers `/v1` |
| PL02 | source facts; initial copy of a 1M-row table: seconds, state timeline, slots, destination equals source |
| PL03 | steady-state lag at the engine's default batch wait and at a 1 s batch wait |
| PL04 | RLS: not applied on the copy or change path with a BYPASSRLS role; publication column lists and row filters do filter; a role without BYPASSRLS |
| PL05 | DDL: add / rename / drop column, drop and set NOT NULL, defaults, type change |
| PL06 | duplicates after SIGKILL (five trials) and after a graceful stop, tables with and without a primary key |
| PL07 | stopped pipeline: retained WAL, drain after restart, slot invalidation at `max_slot_wal_keep_size`, recreate |
| PL08 | the `etl_pipeline` billing add-on as the Management API lists it; billing-while-stopped is not measurable |
| PL99 | delete the project and local stack; confirm no `pl-` project remains |

## Run

Needs `SUPABASE_ACCESS_TOKEN`, `PVLAB_ORG_PRO` (slug of a Pro organisation),
docker with compose, `duckdb` and `psql` on PATH. Runs from source; the
compiled harness binary targets linux-x64.

```bash
cd experiments/pipelines
make probe      # PL01 only, no project
make run        # the battery; creates one pl-* project, deletes it in PL99
make teardown   # if a run died before PL99
```

The replicator image is pinned by commit in `lib/stack.ts` (`REPLICATOR_TAG`,
override with `PL_REPLICATOR_TAG`). `.run/` (generated config, throwaway
credentials, fixture state) is gitignored.

See RUNLOG.md for measured values.
