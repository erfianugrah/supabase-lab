# cron-behaviour

What hosted `pg_cron` does in the cases an app with scheduled jobs runs into:
runs whose scheduled time falls inside a restart or a compute resize
(executed late after recovery, or skipped), a run in flight when the
database restarts, a procedure that `COMMIT`s inside its loop scheduled as
the job command, keeping `cron.job_run_details` small as `postgres`, and a
Supabase Queues (`pgmq`) consumer driven by `pg_cron`.

Self-provisioning, no OpenTofu state: each process creates one Pro-org Micro
in ap-southeast-1 (name prefix `cb-`), runs CB01-CB05 on it and CB99 deletes
it. CB05 resizes it to Small, so it runs last. Sibling context:
`edge-resilience` W23 (pg_cron across a restart, row counts only),
`upgrade-integrity` UI06 (pg_cron across a major upgrade),
`pgnet-under-load` NL04 (pgmq with a pg_cron consumer, delivery).

## Modules

| id | claim measured |
|---|---|
| CB01 | `pg_cron` version and every `cron.*` setting with its `pg_settings` context (`use_background_workers`, `log_run`, ...); a procedure that inserts and `COMMIT`s 5 times, scheduled as `CALL proc()` alone, with an error raised at iteration 3, with `select 1;` before or after it, and as two CALLs in one command: per variant the run status, `return_message`, rows kept and the number of distinct transactions that wrote them; control: the same CALL through the Management API query endpoint |
| CB02 | owner of `cron.job_run_details` and `postgres`'s DELETE privilege on it; a direct `delete ... where end_time < now() - interval '20 seconds'` (rows removed); the same delete as a `pg_cron` job (status, `return_message`); `cron.log_run` value, context, and whether `postgres` can change it (SET, ALTER ROLE, ALTER SYSTEM) |
| CB03 | `pgmq`: queue and archive table size for 10,000 messages archived vs deleted; a `pg_cron` consumer (`pgmq.read(q, 30, n)` then `pgmq.archive` / `pgmq.delete`) with n = 10, 100, 1000: run duration from the function's own clock and from `job_run_details` |
| CB04 | `POST /v1/projects/{ref}/restart` with an every-minute job, a `'10 seconds'` job and a `pg_sleep(120)` run in flight: outage from a Management API probe and from the jobs' own rows, last run before and first after, scheduled instants missed, runs executed late or doubled after recovery; the in-flight run's status and `return_message`, and whether it re-runs |
| CB05 | the same across a compute resize Micro -> Small (`PATCH /v1/projects/{ref}/billing/addons`, `ci_small`) |
| CB99 | teardown |

## Measured (2026-10-28, Pro org, Micro, ap-southeast-1, Postgres 17.11, pg_cron 1.6.4, pgmq 1.5.1)

| question | result | n |
|---|---|---|
| runs scheduled inside a restart / resize | skipped, not run late: 1 every-minute instant missed per event, runs after = boundaries, 0 late, 0 duplicates; the `'10 seconds'` job resumed 10.2-10.3 s after the new postmaster, no burst | 2 restarts, 2 resizes |
| downtime (new postmaster answering after the request) | restart 49.5 s, 67.7 s; resize 67.7 s, 49.7 s | 2 + 2 |
| run in flight at the event | `failed`, never re-run; message `SSL connection has been closed unexpectedly` (run a) or `server restarted` (run b) | 4 |
| `CALL proc()` that COMMITs, as the whole command | `succeeded`; with an error at iteration 3 `failed` and the 2 earlier commits kept | 2 |
| same CALL with any other statement in the command string | `failed`: `invalid transaction termination`, 0 rows | 2 |
| `delete from cron.job_run_details` as `postgres` | works directly (3 rows removed) and as a pg_cron job (`DELETE N`, `succeeded`) | 1 (plus 2 for the job) |
| `cron.log_run` | `on`, context `postmaster`; SET / ALTER ROLE refused (55P02), ALTER SYSTEM refused (42501) | 3 |
| pgmq archive growth | 2555904 B (2.4 MiB) per 10k messages of 145 B; queue table 2523136 B queued, 5128192 B after the drain either way (no VACUUM) | 2 |
| consumer run (read + archive / delete), p50 | n=10 5 / 5-6 ms, n=100 8 / 7 ms, n=1000 25 / 19 ms | 2 x 4 runs |

Details, caveats and what was not run: RUNLOG.md.

## Run

```bash
export PVLAB_ORG_PRO=<pro-org-slug>
sx SUPABASE_ACCESS_TOKEN -- make run LABEL=a   # CB01-CB05, CB99; about 45 minutes
sx SUPABASE_ACCESS_TOKEN -- make run LABEL=b   # a second project in parallel, for n=2
sx SUPABASE_ACCESS_TOKEN -- make clean         # list leftover cb-* projects; DELETE=1 deletes
make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
```

`PVLAB_CB_OBS_S` (default 240) is how long CB04/CB05 watch after the new
postmaster answers. `PVLAB_CB_REF` reuses a project (development only; CB99
leaves it). Results and their limits are in RUNLOG.md.
