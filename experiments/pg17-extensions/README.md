# pg17-extensions

Extensions that Supabase Postgres 17 no longer ships, and what moving a
database that uses them to 17 takes, measured on throwaway projects. The
upgrade docs list `timescaledb`, `plv8`, `plcoffee`, `plls` and `pgjwt` as
unavailable on 17 (https://supabase.com/docs/guides/platform/upgrading); for
`timescaledb` hypertables the docs point to a conversion to native partitioning
managed by `pg_partman` (guides/database/migrating-to-pg-partman). PX01 runs that
guide as written and two logical-replication moves: the hypertable as-is, and
the table after conversion.

Self-provisioning, no OpenTofu state. PX01 creates a Postgres 15 project
(`postgres_engine: "15"` on `POST /v1/projects`) and a Postgres 17 project,
at the default compute size (not set on create), in ap-southeast-1 and the org
of role `team` (`PVLAB_ORG_TEAM`) unless `PVLAB_PX_REGION` or
`PVLAB_PX_ORG_ROLE` say otherwise, and deletes both in `finally`. Statements go through the Management API query endpoint, one
statement per call (`create subscription` needs a call of its own).

## Modules

| id | question |
|---|---|
| PX01a-b | extension availability on 15 and 17; `create extension timescaledb` on 15, version, license |
| PX01c | hypertables `messages` (identity, primary key (id, sent_at)) and `events` (no primary key), 1-day chunks over 30 days; compression, a continuous aggregate and a retention policy tried |
| PX01d, PX01h | `GET /upgrade/eligibility` with timescaledb installed, and after it is dropped |
| PX01e | a hypertable published as-is to a 17 project: what the publication lists, what a subscription into a plain table copies, rows inserted after |
| PX01f | the pg_partman guide verbatim on both hypertables |
| PX01g | a corrected order: `create_parent` before the copy, `overriding system value`, the identity sequence after the copy, drops, maintenance, the guide's `cron.schedule` line |
| PX01i | the converted partitioned table published with `publish_via_partition_root` into a plain table on 17; rows inserted after into a premade and the default partition |

## Run

```bash
# secrets injected per command, never exported: SUPABASE_ACCESS_TOKEN, PVLAB_ORG_TEAM
make -C experiments/pg17-extensions run
make -C experiments/pg17-extensions publish-evidence RUN=evidence/<ts>/run-<stamp>.json
```

Raw run artifacts go to `evidence/<ts>/` (gitignored: they carry project
refs). Measured values and caveats are in `RUNLOG.md`.
