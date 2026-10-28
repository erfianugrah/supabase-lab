# RUNLOG - cron-behaviour

Chronological record of what was run. Org and project identifiers are not
recorded; the org class is (Pro). Each process provisions its own throwaway
Micro through `POST /v1/projects` (ap-southeast-1) and CB99 deletes it.
Database times are `clock_timestamp()` / `pg_postmaster_start_time()` in
UTC; probe times are the orchestrator's clock, relative to the request.

## 2026-10-28 - CB01-CB05 (two runs), CB02 re-run

Harness: `make run LABEL=a` and `make run LABEL=b` in parallel (two
projects), lab commit c2de0d9 plus the uncommitted experiment; then `make
run LABEL=c IDS=CB02,CB99` after a fix to CB02a. Published in
`out/2026-10-28/`: run a `run-2026-10-28T08-24-27-769Z`, run b
`run-2026-10-28T08-25-24-631Z`, run c `run-2026-10-28T08-45-41-492Z` (each
`.json` and `.facts.md`). Postgres 17.11, pg_cron 1.6.4, pgmq 1.5.1. CB01-CB04
ran on Micro; CB05 resized Micro to Small (the variant after the resize was
not read back; the postmaster change was observed).

Settings (CB01a, both runs): `cron.use_background_workers=off`,
`cron.host=localhost`, `cron.log_run=on`, `cron.log_statement=on`,
`cron.max_running_jobs=32`, `cron.timezone=GMT`, all `postmaster` context;
`cron.launch_active_jobs` and `cron.log_min_messages` are `sighup`. So jobs
run over libpq connections to localhost, not background workers.

CB01 (transaction control, both runs identical). A procedure that inserts a
row and `COMMIT`s, 5 iterations, scheduled `'30 seconds'` and unscheduled
after one run:

- `CALL public.cb_loop('solo', 5)` alone: `succeeded`, return_message
  `CALL`, 5 rows in 5 distinct transaction ids.
- Alone with an error raised at iteration 3: `failed`, `ERROR: cb_loop err
  failing at iteration 3`; the 2 rows committed before the error kept (2
  transaction ids).
- `select 1; CALL ...`, `CALL ...; select 1`, and two CALLs in one command:
  all `failed` with `ERROR: invalid transaction termination` at the
  procedure's `COMMIT`, 0 rows kept. A multi-statement command string runs
  as one implicit transaction block, so the first `COMMIT` fails and the
  insert before it rolls back with it.
- Control: the same CALL through the Management API query endpoint
  succeeded with 5 rows.

CB02 (maintenance). Run c is the one to read for CB02a: in runs a and b
the CTE counted without `from d`, so `removed` read 1 whatever was deleted
(the delete itself ran: rows before 12, after 4, in both). Run c:
`cron.job_run_details` is owned by `supabase_admin`, `postgres` has DELETE
on it, and `delete ... where end_time < now() - interval '20 seconds'`
through the Management API removed 3 rows (7 before, 5 after; a filler job
added rows in between). As a `pg_cron` job (`'15 seconds'`, sparing its own
rows) the same delete ran 4 times, all `succeeded`, return_message `DELETE
N` (`DELETE 5` once and `DELETE 3` three times in runs a and b; `DELETE 6`
once and `DELETE 3` three times in run c). `cron.log_run` is `on`, context
`postmaster`: `SET` and `ALTER ROLE postgres SET` both answered `55P02:
parameter "cron.log_run" cannot be changed without restarting the server`,
`ALTER SYSTEM` answered `42501: permission denied to set parameter`. As
`postgres` run logging cannot be turned off; deleting old rows is the
available control (3 runs).

CB03 (pgmq on Micro, two runs; identical sizes in both). Message: 145 B
jsonb.

- Storage, 10,000 messages: the queue table went from 24576 B empty to
  2523136 B with 10k queued and to 5128192 B after all 10k were read and
  archived, and the same 5128192 B after they were read and deleted (no
  VACUUM run; `pgmq.read` rewrites each row to set its visibility timeout,
  which is the likely reason it doubles: inference). The archive table grew
  2555904 B (2.4 MiB) for 10k archived (10000 rows); in delete mode it stayed
  at 24576 B. Draining 10k in 10 batches of 1,000 from one Management API
  call took 636 ms archiving and 310 ms deleting (run b).
- Consumer run duration (`pgmq.read(q, 30, n)` then archive or delete of
  the ids, 4 runs per cell, `job_run_details` end minus start, p50):

  | n | archive run a | archive run b | delete run a | delete run b |
  |---|---|---|---|---|
  | 10 | 5 ms | 5 ms | 5 ms | 6 ms |
  | 100 | 8 ms | 8 ms | 7 ms | 7 ms |
  | 1000 | 25 ms | 25 ms | 19 ms | 19 ms |

  The function's own time (clock_timestamp inside it), p50 at n=1000:
  archive 19.9 ms (run a) and 20.7 ms (run b), delete 15.2 ms and 15.4 ms.
  One archive n=1000 run in run b took 59 ms (function 52.6 ms). Every run
  got the full batch. The schedule used was `'10 seconds'`, not every
  minute; it sets how often the consumer runs, not what one run costs.

CB04 / CB05 (restart and resize, one each per run, n=2 each). Jobs across
the event: every minute, `'10 seconds'`, and a once-a-day `pg_sleep(120)`
started at the minute before the request (running at the request in all 4
events).

| event | new postmaster after request | every-minute last before / first after | instants missed | runs after / boundaries since restart | 10 s gap | 10 s runs not started |
|---|---|---|---|---|---|---|
| restart, run a | 49.5 s | 08:34:00.024 / 08:36:00.131 | 1 (08:35) | 4 / 4 | 62.4 s | 5 |
| restart, run b | 67.7 s | 08:35:00.116 / 08:37:00.086 | 1 (08:36) | 4 / 4 | 83.7 s | 7 |
| resize, run a | 67.7 s | 08:40:00.076 / 08:42:00.021 | 1 (08:41) | 4 / 4 | 81.7 s | 7 |
| resize, run b | 49.7 s | 08:41:00.063 / 08:43:00.017 | 1 (08:42) | 4 / 4 | 61.8 s | 5 |

- No catch-up in 4 of 4 events. The every-minute instant inside the
  window was skipped, not run late: in run a's restart the new postmaster
  started at 08:35:01.369, just after the missed 08:35 instant, and the
  next run was at 08:36:00.131. After recovery every every-minute run
  started 0 to 0.2 s past its boundary (0 late runs, 0 same-minute
  duplicates, as many runs as boundaries). The `'10 seconds'` job's first
  run came 10.2 to 10.3 s after the new postmaster started, then every 10
  to 10.1 s: no burst. `job_run_details` held only `succeeded` for both
  jobs (no row for the skipped instants).
- The run in flight was recorded `failed` in 4 of 4 events and never
  re-run (0 runs after the restart; the next scheduled one was a day
  away). The message differed: run a (restart and resize) `SSL connection
  has been closed unexpectedly`, with an end_time seconds after the request
  (request 08:34:15.755, end 08:34:17.757; request 08:40:16.391, end
  08:40:20.038); run b (restart and resize) `server restarted` with no
  end_time, the row pg_cron marks at startup for runs left pending. Which
  one appears depends on whether the old scheduler recorded the lost
  connection before it stopped (inference; the order was not observed).
- Probe outage (Management API `select`, 2 s cadence): 49.3 s and 67.6 s
  (restart), 67.5 s and 47.4 s (resize).

Not run: `cron.use_background_workers=on` (postmaster setting, not
changeable as `postgres`), a job longer than its interval across a restart,
more than one missed minute, a consumer on an every-minute schedule, VACUUM
after the drain, Small or larger compute for CB01-CB04, other regions.
