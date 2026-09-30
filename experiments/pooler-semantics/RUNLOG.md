# pooler-semantics - RUNLOG

Written 2026-08-04 (see `docs/plans/2026-08-04-pooler-semantics.md`), first
run 2026-09-30. The experiment has no OpenTofu state of its own: the plan's
Task 6/7 scaffold was never created, and the modules run against another
experiment's project through that experiment's Makefile, which exports
`PVLAB_ENDPOINT_POOLER`, `_POOLER_SESSION`, `_POOLER_TXN`,
`_POOLER_TXN_USER`, `_SHARED_TXN` and `_POOLER_USER`
(`experiments/medium-serverless/Makefile`, `EXPERIMENT=pooler-semantics`).

## 2026-09-30 - S01 on a Medium project in ap-southeast-2 (out/2026-09-30/run-2026-09-30T04-41-49)

Vantage: IPv4-only, Singapore; the project had the IPv4 add-on so the direct
control row and the dedicated pooler were reachable. Postgres 17.6.

| Mode | Endpoint | User | Result |
|---|---|---|---|
| S01a direct 5432 (control) | `db.<ref>.supabase.co:5432` | `postgres` | 9/9 ok |
| S01b Supavisor session | `aws-0-ap-southeast-2.pooler.supabase.com:5432` | `postgres.<ref>` | 9/9 ok |
| S01c dedicated PgBouncer transaction | `db.<ref>.supabase.co:6543` | `postgres` | 9/9 ok |
| S01d Supavisor transaction | `aws-0-ap-southeast-2.pooler.supabase.com:6543` | `postgres.<ref>` | 9/9 ok |
| S01e | reproduces T11 (prepared statements on 6543) | | `prepared_first` ok |

Features: `pid_stable`, `prepared_first`, `prepared_reuse`, `advisory_lock`,
`listen_notify`, `session_guc`, `cursor_with_hold`, `temp_table`,
`explicit_txn`.

Reading: the matrix is one client per mode. An idle single client gets the
same server connection handed back on every statement, so session-scoped
state (GUC, LISTEN, temp table, cursor, advisory lock) appears to survive
transaction pooling on both poolers. That is a property of the probe shape,
not a licence: medium-serverless MS10b drove Supavisor transaction mode with
20 concurrent Prisma 6.19 clients and got `26000 prepared statement "s10"
does not exist` on 493 of 500 iterations, while the dedicated PgBouncer on
the same project ran the same load clean. S01 measures the protocol surface a
single connection sees; concurrency is a separate module.

Change made for this run: S01c and S02b take `ctx.endpoints.pooler_txn_user`
so the dedicated pooler can be dialled as bare `postgres` (it refuses the
tenant shape with `no such user`, medium-serverless MS01d).

## S02

See medium-serverless RUNLOG once run; `sbperf` is now `pg-analyser bench`
and is passed as `PVLAB_SBPERF`.
