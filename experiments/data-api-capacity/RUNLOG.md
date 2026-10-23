# RUNLOG - data-api-capacity

Chronological record of what was run. Org and project identifiers are not
recorded; the org class is (Pro). Each run provisions one throwaway project
through `POST /v1/projects` (ap-southeast-1, `desired_instance_size: small`),
resizes it to Large in DC01c and deletes it in DC99. Postgres 17.11 and
PostgREST 14.18 (the `application_name` of its connections) were read from
the runs' console output, not from the published artifacts; DC01a records
both from the next run on. Vantage: this lab's Mac in Singapore over the
public internet, so every client time below includes the round trip. "Docs"
means the source named in the module header; "measured" means the artifact.

## 2026-10-23 - DC05-DC07, the pool metrics, aborted connections, pool size under load (one run)

Harness: `make run ONLY=DC05,DC06,DC07,DC99` with
`PVLAB_DC_REGION=ap-northeast-2` and `PVLAB_DC_SIZE=small`, lab commit
661afdf plus the uncommitted DC05-DC07 modules. One Pro-org project, Small
for the whole run (shared CPU per the compute docs, no core count published; `max_connections` 90 was
read by DC04a on the same size, not in this artifact; `db_pool` unset at
creation), deleted by DC99. The artifact's top-level `region`
(ap-southeast-1) is the harness default; the project's region came from
`PVLAB_DC_REGION` and is not recorded in this artifact (DC04a and DC05a
record it as `project_region_requested` from the next run on). Same client
as DC04: this lab's Mac in Singapore; `oha` 1.16.0 for DC07 (console, not
in the artifact's tool versions). The PostgREST version is not recorded in
this artifact (DC04a, same day and region, read 14.18). Metric series are
`pgrst_db_pool_*` from `/customer/v1/privileged/metrics`; "truth" is
`pg_stat_activity` for `usename = 'authenticator'` read through the
Management API query endpoint. Published:
`out/2026-10-23/run-2026-10-23T07-49-11-858Z.json` (17 results) and its
`.facts.md`.

What the two pool series are, from PostgREST v14.18 source (source-read;
Supabase's build is assumed to match the tag, not checked):
`pgrst_db_pool_waiting` goes up when a request asks the pool for a
connection and down when its session returns (`usePool` in
https://github.com/PostgREST/postgrest/blob/v14.18/src/PostgREST/AppState.hs),
so it counts requests queued for a connection plus requests holding one;
its help text, "Requests waiting to acquire a pool connection", describes
only the first part. `pgrst_db_pool_available` is connections opened minus
connections in use (`calcAvailable` in
https://github.com/PostgREST/postgrest/blob/v14.18/src/PostgREST/Metrics.hs),
so open idle pool connections.

### DC05a - how often the metric series change

1 s scrapes for 100 s while held `dc_sleep_xl` requests stepped 0, 5, 15,
25, 0 every 20 s (holds of 18 s), truth about every 2.5 s.

| measured | value |
|---|---|
| scrapes | 100 (0 failed) |
| distinct waiting/available/max tuples | 2: `0/1/30` from 0 s to 60 s, `25/0/30` from 62 s to 99 s |
| changes | 1 |
| lag from each step (5, 15, 25, 0 held) to the first changed scrape | 41.5, 21.5, 1.5, -1 (none) s |
| response headers (first scrape only) | `cf-cache-status=DYNAMIC`, `date` current |
| truth, authenticator total/in PgSleep/idle | 2/0/2 to 20 s; 6/5/1 from 22 s; 16/15/1 from 41 s; 16/0/16 at 58 s; 26/25/1 from 61 s; 26/0/26 from 81 s |

Reading: the series moved once in 100 s while the truth moved five times.
No refresh landed between about 22 s and 58 s (the 5- and 15-held states
never appeared) or between 81 s and 99 s (the 25-held state was still
shown 18 s after the holds ended). The step lags in the table are all the
one change at 62 s, measured from different starts. The endpoint answered
`DYNAMIC` with a current `date` on the first scrape, so the staleness sits
behind the edge. If the payload refreshes on a fixed period, that period is
at least about 40 s; no upper bound was measured.

### DC05b - what the series read, against pg_stat_activity

10 then 40 requests held for 30 s on a pool of 30; five scrapes 1.5 s apart
from 12 s into the hold, truth at the third.

| held | scrapes (waiting/available/max) | truth total / in PgSleep / idle | "available" if it meant open idle / max minus checked out | hold outcomes |
|---|---|---|---|---|
| 10 | `25/0/30` x4, then `10/15/30` | 26 / 10 / 16 | 16 / 20 | 200:10 |
| 40 | `10/15/30` x5 | 31 / 30 / 1 | 1 / 0 | 200:40 |

Readings, against the source definitions above (three snapshots that line
up with a known state):

- `available` read 15 with 10 held (16 idle `authenticator` backends), 0
  with 25 held (DC05a, 62 s; 1 idle) and 1 at rest (DC05a, 0 s; 2 idle).
  That agrees with open idle pool connections; max minus checked out would
  have read 20, 5 and 30. In those three, one idle `authenticator` backend
  was not counted, which fits a connection outside the pool (PostgREST's
  listener; not identified).
- `waiting` read 25 with 25 held and 10 with 10 held on a pool of 30 where
  nothing queued: the holders alone, as queued-plus-holding predicts. DC07
  pool 15 at c=128 read 31 waiting on a pool max of 15, so it does include
  queued requests when there are some.
- The 40-held row is the 10-held snapshot, still being served; the queued
  state (30 in PgSleep, 10 waiting for a connection) was never scraped.

### DC05c - pool max after a db_pool PATCH

| PATCH | status | restart line after | `pgrst_db_pool_max` read the new value after |
|---|---|---|---|
| `db_pool` 20 (from unset, 30) | 200 | 1.2 s | 1.4 s (first scrape) |
| `db_pool` 30 | 200 | 1 s | 28.9 s (22 scrapes) |

Reading: the PATCH restarted PostgREST within about 1 s both times; the
metric followed after 1.4 s once and 28.9 s the other time. The 1.4 s case
needs a refresh in the 0.2 s after the restart line, so a competing reading
is that a restart resets or refreshes the payload; not separated. Either
fits DC04d, where each arm read the previous arm's pool.

### DC06 - statement timeouts from a lock, then the pool

20 workers looping anon GETs on `dc_items` (anon `statement_timeout` 3 s,
measured by DC03a in an earlier run on another project, not in this
artifact); `begin; lock table public.dc_items in access exclusive mode;
select pg_sleep(N); commit;` through the Management API; 75 s observed
after the lock; `authenticator` states every 5 s. Control (2 s) ran first.
One run per arm. The pool was 30 (DC05c's last PATCH) against 20 workers,
so no request waited for a pool connection: a cancellation while queued
for the pool was not exercised.

| lock asked / held | before | during (to 4 s after the lock) | after (4 s to 75 s after) | 25P02 after | most `idle in transaction (aborted)` seen | requests |
|---|---|---|---|---|---|---|
| 2 s / 2.7 s | 200:2034 | 200:664 | 200:9857 | 0 | 0 | 12555 |
| 12 s / 12.6 s | 200:2050 | 200:643, 500 57014:60 | 200:9920 | 0 | 0 | 12673 |

States sampled in the 12 s arm: `active:20 idle:1` twice during the lock,
`idle:21` from 1.4 s after it, with at most 2 `idle in transaction` (not
aborted) in any later sample.

Reading: 60 requests were cancelled by anon's statement timeout while
waiting on the lock, and none of the pooled connections they used was left
aborted: every request from 4 s to 75 s after the lock answered 200, and no
sample showed an aborted backend. The competing hypothesis in the module
header stays open: a stall where Postgres stops as a whole (cancellations
landing at a different protocol step) was not made, since this lab has no
way to SIGSTOP Postgres on a managed project.

### DC07 - db_pool 15, 30, 60 on Small under closed-loop load

Each arm: PATCH, wait for the restart line, 30 s settle, then the DC04 step
(`oha`, 40 s, one indexed point read `GET
/rest/v1/dc_items?id=eq.4242&select=id,payload`, anon key) at 128, 256,
512 concurrent, 20 s apart. Success is 200s over all attempts, client-side
errors included.

| `db_pool` (restart after PATCH) | concurrency | req/s | p50 / p99 ms | success | waiting max (available then, of max) | `authenticator` mid-step | client errors | client load1 |
|---|---|---|---|---|---|---|---|---|
| 15 (1.1 s) | 128 | 814 | 147 / 422 | 1 | 31 (1 of 15) | idle:12 idle in transaction:4 | none | 8.8 |
| 15 | 256 | 853 | 288 / 667 | 1 | 0 (15 of 15) | idle:15 idle in transaction:1 | 1 connection closed | 12.9 |
| 15 | 512 | 863 | 615 / 1073 | 0.992 | 0 (15 of 15) | idle:16 | 280, 262 of them os error 51 | 11.7 |
| 30 (1.5 s) | 128 | 834 | 147 / 376 | 1 | 0 (0 of 30) | idle:28 idle in transaction:1 | none | 4.9 |
| 30 | 256 | 902 | 281 / 470 | 0.998 | 0 (28 of 30) | idle:28 idle in transaction:1 | 60 timeouts | 3.6 |
| 30 | 512 | 878 | 618 / 863 | 0.985 | 0 (28 of 30) | idle:27 idle in transaction:2 | 516, 478 of them os error 51 | 4.2 |
| 60 (1.3 s) | 128 | 836 | 147 / 348 | 1 | 0 (0 of 60) | idle:35 | none | 3.7 |
| 60 | 256 | 909 | 277 / 579 | 1 | 0 (34 of 60) | idle:31 idle in transaction:4 | 17 timeouts | 4.2 |
| 60 | 512 | 868 | 615 / 940 | 0.993 | 0 (34 of 60) | idle:34 idle in transaction:1 | 238, 165 of them os error 51 | 3.6 |

Every `db_pool` PATCH answered 200 and read back the value set. Every
answer in every step was a 200; the failures are client-side (`Network is
unreachable (os error 51)`, timeouts, closed connections). Node CPU was not
computed in any step (-1): the CPU counters on the metrics endpoint did not
change across any step's scrapes. The pool columns are snapshots (DC05).

Readings:

- Pool size made no difference this run can separate. Pool 15 / 30 / 60
  gave 814 / 834 / 836 req/s at 128, 853 / 902 / 909 at 256 and
  863 / 878 / 868 at 512. The same configuration measured twice (DC04b,
  default pool 30, against this run's pool 30) differed by 9, 23 and 40
  req/s at 128, 256 and 512, against 56 req/s between pool 15 and 60 at
  256. One step per cell, no repeats; the pool 15 arm also ran with the
  Mac's load1 at 8.8 to 12.9 against 3.6 to 4.9 in the others.
- The same Mac reached 1699 req/s at 256 and 3158 at 512 against a 4XL
  (DC04c, same day). The Small ceiling here is about the DC04b figure (925
  at 256), with latency doubling per step as there.
- Mid-step, most `authenticator` backends were idle at every pool size, and
  the 60 pool never showed more than 35 `authenticator` backends. Which
  process used the node's CPU was not measured.
- Upstream PostgREST issue #5336
  (https://github.com/PostgREST/postgrest/issues/5336) reports throughput
  collapsing when requests wait for a pool connection, growing with
  PostgREST's cores: mild at 2 cores (5,714 req/s, 293 us per request in
  its table), collapsing at 8 and 16; its pool 20 against 200 contrast was
  on 4 cores. Its workaround is a `db-pool` at least as large as the number
  of concurrent requests; the fix it points to is hasql-pool PR #58
  (https://github.com/nikita-volkov/hasql-pool/pull/58). On a shared-CPU Small
  with Postgres, flat throughput across pool sizes is consistent with the
  issue's small-core rows. Whether requests queued for a connection at all
  in the 30 and 60 arms is not established (the pool series are snapshots).

### Not run

- A pool metric refresh interval measured directly (a longer 1 s scrape
  window across several refreshes); a scrape of `waiting` while requests
  are known to queue for a connection.
- A per-process CPU split between PostgREST and Postgres; node CPU in
  DC07 (not computed, see above).
- DC07 on a size with more vCPU, or with requests that hold a connection
  longer than a point read, where waiting for a connection is certain;
  DC07 from a client whose load stays level across arms.
- For DC06: a whole-instance stall; a pool smaller than the workers, so a
  request is cancelled while queued; the authenticated role's 8 s timeout;
  RPC or write requests under cancellation.
- Repeats of any row.

### Cost

Project time about 21 minutes (07:49:11 to 08:09:57 UTC, the artifact's
start and finish stamps), Small throughout, deleted by DC99 (DELETE 200,
gone from the listing at once). `make clean` afterwards listed 0
`pvlab-dc-` projects (console, not in the artifact).

## 2026-10-23 - DC04, request rate instead of request duration (one run)

Harness: `make run ONLY=DC04,DC99` with `PVLAB_DC_REGION=ap-northeast-2`
and `PVLAB_DC_SIZE=small`, lab commit 4141477 plus the uncommitted DC04
module. One Pro-org project, Small, resized to 4XL (`ci_4xlarge`) in DC04c,
deleted by DC99. Load generator: `oha` 1.16.0, closed loop, 40 s per step,
one GET `/rest/v1/dc_items?id=eq.4242&select=id,payload` (indexed point read
on a 100,000-row table) with the legacy anon key, from this lab's Mac in
Singapore, so every latency includes the Singapore-Seoul round trip (p50 141
to 150 ms at low load). Pool series are `pgrst_db_pool_*` read from
`/customer/v1/privileged/metrics` every 3 s; node CPU from
`node_cpu_seconds_total`; `authenticator` states read once mid-step through
the Management API query endpoint. Published:
`out/2026-10-23/run-2026-10-23T07-13-34-754Z.json` (19 results) and its
`.facts.md`.

### DC04a - what the metrics endpoint exposes

9 `pgrst_*` series: `pgrst_db_pool_available`, `pgrst_db_pool_max`,
`pgrst_db_pool_timeouts_total`, `pgrst_db_pool_waiting`, three JWT cache
series and two schema cache series. Small: pool max 30, `db_pool` null,
`max_connections` 90, `application_name` "PostgREST 14.18". 4XL (DC04c
resize, settled 68 s after the PATCH): `max_connections` 480, `db_pool`
null, pool max 70.

### DC04b - Small (shared CPU)

| concurrency | req/s | p50 / p99 ms | success | waiting max (available then, of max) | timeouts | node CPU % | `authenticator` mid-step | client errors |
|---|---|---|---|---|---|---|---|---|
| 16 | 108 | 143 / 374 | 1 | 0 (1 of 30) | +0 | -1 (not computed) | idle:7 | none |
| 32 | 214 | 144 / 345 | 1 | 1 (5 of 30) | +0 | 9.5 | idle:7 | none |
| 64 | 428 | 145 / 334 | 1 | 1 (5 of 30) | +0 | 21.7 | active:1 idle:18 | none |
| 128 | 825 | 149 / 370 | 1 | 7 (11 of 30) | +0 | 49.1 | idle:16, idle in transaction:3 | none |
| 256 | 925 | 269 / 526 | 1 | 139 (11 of 30) | +0 | 73.9 | idle:16, idle in transaction:3 | 2 |
| 512 | 918 | 547 / 1039 | 0.993 | 139 (11 of 30) | +0 | -1 | idle:27, idle in transaction:4 | 277 |
| 1024 | 1020 | 1110 / 1748 | 0.872 | 0 (30 of 30) | +0 | -1 | idle:22, idle in transaction:9 | 5,323 |

Reading: from 256 on, throughput stopped at about 920 to 1,020 req/s while
latency doubled per step, and at 256 the pool reported 139 requests
waiting while 11 connections were available, timeouts flat, and the
`authenticator` backends idle. That is the waiting-with-free-slots pattern,
on Small (shared CPU), with node CPU at 73.9 %. Postgres and PostgREST share that node,
so node CPU does not say which process used it; no per-process figure was
read. The 512 row repeats the 256 row's pool figures exactly and the 1024
row reads 0 waiting with every slot available while 12.8 % of requests
failed on the client; the pool series appear to update less often than the
3 s scrape (a reading, not separated). Treat the pool columns as coarse.

2026-10-23, after DC05: `pgrst_db_pool_waiting` counts requests queued for
a connection plus requests holding one (PostgREST v14.18 source), and the
pool columns are snapshots that change at most about every 40 s. The 139
waiting / 11 available pair was one snapshot: the 256 step's waiting median
was 7, and the 512 step showed 139 / 11 on all 12 scrapes. If that snapshot
is internally consistent, 139 includes at most 30 holders, so at least 109
requests were queued while 11 open connections sat idle. Node CPU 73.9 % is
the change between two payload refreshes, not the whole step.

### DC04c - 4XL (16 vCPU)

| concurrency | req/s | p50 / p99 ms | success | waiting max (available then, of max) | node CPU % | `authenticator` mid-step | statuses | client errors |
|---|---|---|---|---|---|---|---|---|
| 64 | 436 | 141 / 365 | 1 | 0 (1 of 70) | -1 | idle:10 | 200:17521 | none |
| 128 | 860 | 143 / 339 | 1 | 0 (1 of 70) | 2.2 | idle:10 | 200:34810 | none |
| 256 | 1699 | 144 / 355 | 1 | 1 (10 of 70) | 5 | active:1 idle:11 | 200:68773 | 1 |
| 512 | 3158 | 150 / 457 | 0.996 | 1 (10 of 70) | 11.5 | active:1 idle:31 | 200:127297 | 456 |
| 1024 | 2243 | 164 / 2162 | 0.837 | 0 (66 of 70) | 11.5 | idle:67 | 200:75566 403:6804 | 16,018 |
| 1536 | 539 | 801 / 4460 | 0.375 | 0 (66 of 70) | 0.1 | idle:67 | 403:8856 | 14,729 |

Reading: on 16 vCPU the same request scaled linearly to 3,158 req/s at 512
with nothing waiting and node CPU at 11.5 %. The pattern DC04b met on Small
did not appear up to that rate. Above 512 the run stopped measuring
PostgREST: the client logged "Network is unreachable (os error 51)" on
thousands of requests, and from 1024 the answers that came back included
HTTP 403 (6,804 at 1024, every answer at 1536), with node CPU falling to
0.1 %. The 403 body was not recorded, so which layer sent it is not
established. These two rows describe this client and the edge in front of
the project, not PostgREST.

2026-10-23, after DC05: "nothing waiting" above means a waiting max of 1
(median 1, 10 of 70 available) at 256 and 512, read from snapshots (DC05).
Node CPU read 11.5 % at both 512 and 1024, which fits one stale refresh
window spanning the two steps.

### DC04d - db_pool arms on 4XL (not usable)

`db_pool` 20 (PATCH 200), 150 (PATCH 200) and 250 (PATCH 500), each
followed by the 1024 step. The first two returned 531 and 548 req/s, 403
only, with one `authenticator` backend; the 250 arm returned 2,749 req/s
(98,340 x 200, 4,347 x 403). The pool max read in each arm was the value
from the arm before (70, then 20, then 150), so the reading lagged a PATCH.
The arms ran behind the same client and edge limit as DC04c's top rows and
compare nothing about pool size; the 500 on `db_pool` 250 was not
investigated.

### Not run

- Load above about 3,000 req/s from a vantage that is not one Mac (several
  clients, or clients in-region).
- Any request other than one indexed point read: RPCs, inserts, wide
  responses, `Prefer: count=exact`, a high `max_rows`.
- A per-process CPU split between PostgREST and Postgres.
- The `db_pool` comparison, which needs the above before it means anything.
- XL and 2XL/8XL, between the two sizes measured.

### Cost

Project time about 18 minutes (07:13:34 to 07:31:20 UTC, the artifact's
start and finish stamps), Small until DC04c and 4XL after, deleted by DC99
(DELETE 200).

## 2026-10-22/23 - four runs (run 4 is the reference)

Harness: `make run` (DC01, DC02, DC03, DC99, `--destructive`), lab commit
3a2f9bd plus the uncommitted tree that adds this experiment. All figures
below are run 4 unless a run is named. Published (redacted):

- run 1 `out/2026-10-22/run-2026-10-22T23-02-55-371Z.json` (13 results)
- run 2 `out/2026-10-22/run-2026-10-22T23-43-28-093Z.json` (10 results)
- run 4 `out/2026-10-23/run-2026-10-23T00-37-06-485Z.json` (14 results)

each with a `.facts.md`. Run 3 died in DC02 on an unhandled `ECONNRESET`
from `api.supabase.com` (a `PATCH /postgrest` inside the ping sampler) and
wrote no artifact; its project was deleted with `make clean DELETE=1` at
about 00:36 UTC (console time, not in an artifact). Its console output is
not cited for any figure.

What changed between runs, and why the earlier rows are not used where run 4
differs:

- Run 1 sent PostgREST config PATCHes without waiting for the restart each
  one causes and did not record PATCH times. Its DC02d row (the restart
  count; run 4 moved it to DC02e) lists six "Starting PostgREST" lines from
  23:09:56 to 23:35:05 UTC. Where DC02 began and ended in run 1 is not fixed
  by the artifact: the module durations (DC01 419046 ms, DC02 650760 ms,
  DC03 332782 ms, DC99 1398 ms) add up to about 1404 s, against 2295 s
  between the run's start and finish stamps. Three of run 1's rows look like
  restart overlaps: DC02b at timeout 4 s (0 holders sleeping at probe time),
  DC02c (`db_pool` 1000 burst: 218 of 220 requests ended on the client with
  "The socket connection was closed unexpectedly") and the DC03a anon row
  (client errors at 18.1 s, no error text recorded). DC02 now waits for the
  restart log line after every PATCH and records the delay (`waitRestart`),
  and run 4's DC02d measures a restart's effect on purpose.
- Run 2: DC01c settled 41 s after the resize PATCH; the next row is a
  module-level DC01 failure, "threw: The operation timed out." (DC01d did not
  report), then DC02 could not measure the pool, and DC03's first calls
  failed at once on the client (status 0, 0.0 s, no error text recorded)
  until one hung for 78.6 s. DC01c now watches the Data API for 300 s after
  settling, and DC03 waits for 10 consecutive good pings before it starts.
- From run 4 every Data API request is sent with `keepalive: false` (a fresh
  connection per request), and PATCH and logs calls catch client-side
  network errors. The client-side failures before that: run 1, "The socket
  connection was closed unexpectedly" on 218 of 220 DC02c requests; run 2,
  status 0 with no text recorded; run 3, an `ECONNRESET` from
  `api.supabase.com` (console only). The first and third match a client
  reusing a pooled socket the server had closed; that is a reading of the
  client side; no separating probe was run. Run 4 still has status-0 rows (listed
  where they occur) whose error text was not recorded.
- Module durations do not add up to the wall clock in runs 2 and 4 either:
  561029 ms against 800 s, and 2323221 ms against 2419 s. The cause is not
  separated.

### DC01 - default pool and the default wait for PGRST003

Docs (Management API spec, `V1UpdatePostgrestConfigBody` and the GET
response): `db_pool` "If `null`, the value is automatically configured based
on compute size"; `db_pool_acquisition_timeout` "If `null`, ... configured to
10". PostgREST docs: a request waits for a pooled connection until
db-pool-acquisition-timeout, then answers 504 PGRST003.

| row | measured |
|---|---|
| DC01a Small, `GET /postgrest` | `db_pool` null, `db_pool_acquisition_timeout` 10 (a number, not null); `max_connections` 90 |
| DC01a Small, pool | 30 `authenticator` backends in `PgSleep` mid-burst, both bursts of 100 (runs 1, 2 and 4: 30 / 30 each) |
| DC01a Small, burst outcomes | 100 + 100 of 200 answered 200, 0 PGRST003 (12 s sleeps, so the queue drained in waves of 30 within the wait described in DC01b) |
| DC01b Small, pool held, two single requests (service_role key) | 504 PGRST003 after 61364 ms and 61972 ms; each request's User-Agent appears on 6 PostgREST access-log lines, all 504 (run 1: 61343 / 61493 ms, run 2: 61972 / 61795 ms, 6 lines each) |
| DC01c resize Small to Large | `PATCH /billing/addons` 200; `max_connections` 160, ACTIVE_HEALTHY and 5 good pings 66 s after the PATCH (run 1: 66 s, run 2: 41 s); the next 300 s of 1 s pings: 0 of 300 failed |
| DC01d Large, pool | 50 / 50 mid-burst, bursts of 140 (run 1: 50 / 50); `db_pool` still null, timeout 10, `max_connections` 160 |

Reading (no separate probe): 6 access-log lines for one client request
means PostgREST received that request 6 times in total, so something between
the client and PostgREST sends the request again after a PGRST003, and a
request that never gets a connection waits about 6 x the acquisition timeout
before the client sees the 504. DC02b shows the same factor at 2 s and 4 s.
The component and its policy are not identified.

### DC02 - changing the pool settings

| row | measured |
|---|---|
| DC02a `db_pool` 70 (default 50 + 20) | PATCH 200, PostgREST restart logged 0.7 s after, readback 70; 0 of 357 pings (250 ms apart) failed in 90 s; mid-burst pool 70 with 110 requests |
| DC02a `db_pool` 90 | PATCH 200, restart 0.7 s after, readback 90; 0 of 358 pings failed; mid-burst pool 90 with 130 requests (129 answered 200, 1 status 0 on the client) |
| DC02b acquisition timeout 2 s, pool held (90 of 90 sleeping), two single requests (service_role key) | 504 PGRST003 after 13767 and 13752 ms, 6 PostgREST lines each (504:6) |
| DC02b acquisition timeout 4 s, pool held (90 of 90 sleeping), two single requests | request 1: 504 PGRST003 after 25007 ms, 6 lines (504:6). Request 2: status 0 at the client's 105001 ms timeout and 0 PostgREST lines; not explained. The 4 s figure is n = 1 |
| DC02c bounds sent | `db_pool` 1001: 400 `db_pool: Too big: expected number to be <=1000`; `db_pool` -1: 400 `db_pool: Too small: expected number to be >=0`; acquisition timeout 61: 400 `db_pool_acquisition_timeout: Too big: expected number to be <=60`. A 0 for either was not sent |
| DC02c control: `db_pool` PATCHed back to 50 (and timeout 10) just before, then 220 concurrent 15 s sleeps | 150 answered 200, 70 answered 504 PGRST003 between 10923 and 20903 ms (median 20855); mid-burst pool 50 |
| DC02c `db_pool` 1000 on Large (`max_connections` 160), same burst | PATCH 200, readback 1000, restart 0.7 s after; 154 answered 200, 66 answered 503 with PostgREST's own message `{"code":"PGRST002",...,"message":"Could not query the database for the schema cache. Retrying."}`; the mid-burst read through the Management API query endpoint gave no row (its status and error were not recorded); after the burst, 5 consecutive good pings took 6 s (the check's floor is about 4 s, so no outage after the burst was measured) |
| DC02c restore (`db_pool` 50, timeout 10) | PATCH 200, restart 0.5 s after, 5 good pings in 4 s |
| DC02d no-change `db_pool` PATCH with 20 requests sleeping 60 s in flight (sent 5 s before the PATCH), twice | restart logged 55.3 s after the PATCH both times; all 20 in-flight requests answered 200 both times; 5 of 267 and 5 of 265 pings failed (status 0, no text, 10 s client timeout), first at 1.3 s and 0.8 s, in one run of about 50 s that ended before the logged 55.3 s restart |
| DC02e | 9 "Starting PostgREST" lines for 9 accepted PATCHes |

Readings (no separate probes):

- Every accepted PostgREST config PATCH restarted PostgREST, including one
  that changed nothing (DC02d, as data-api-reenable found). Across the seven
  PATCHes in DC02a to DC02c the restart came 0.5 to 0.9 s after the PATCH;
  ping failures were recorded for three of them (the two DC02a PATCHes and
  `db_pool` 1000), and none failed. With 60 s requests in flight (DC02d) it
  came 55.3 s after, about when they finished (they were sent 5 s before the
  PATCH), all of them completed, and new requests got no answer in the
  meantime. That fits a restart that drains in-flight requests before
  stopping, with new requests held behind it.
- Under load the wait for PGRST003 was shorter than for a lone request: in
  the 220-request control the 70 PGRST003 answers came after 10923 to 20903
  ms (median 20855), one or two acquisition timeouts. This is inferred from
  latency only; `burst()` does not count access-log lines, so attempts per
  request were not counted there. The policy (a budget, a cap on concurrent
  resends, or something else) is not separated.
- `db_pool` above what Postgres can give changed the failure in this one
  burst per arm: 504 PGRST003 at `db_pool` 50 became 503 PGRST002 at 1000,
  and the Management API read in the same burst gave no row. No connection
  count near 160 was observed (the mid-burst read is the one that failed).

### DC03 - statement timeouts through the Data API

Docs (Supabase timeouts guide): anon 3 s, authenticated 8 s, set per role.

| row | measured |
|---|---|
| DC03a `rolconfig` | anon `{statement_timeout=3s}`; authenticated `{statement_timeout=8s}`; service_role null; authenticator `{"session_preload_libraries=supautils, safeupdate",statement_timeout=8s,lock_timeout=8s}` |
| DC03a `dc_sleep` (no function setting) | anon key, 5 s sleep: 500 57014 after 3062 / 3057 ms. Anon key plus a user token (authenticated), 10 s: 8065 / 8048 ms. service_role key, 10 s: 500 57014 after 8056 / 8048 ms. Body: `{"code":"57014","details":null,"hint":null,"message":"canceling statement due to statement timeout"}` |
| DC03b `dc_sleep_long` (`set statement_timeout = '30s'` on the function), 12 s sleep | 200 for all three keys, twice each, 12067 to 12105 ms |
| DC03c `alter role authenticated set statement_timeout = '15s'`, user token, 10 s sleep | right after the ALTER: 500 57014 at 8078 / 8064 ms; after `notify pgrst, 'reload config'`: 200 at 10076 / 10103 ms; after `'reload schema'` as well: 200 at 10098 / 10080 ms; back to 8 s plus a config reload: 500 57014 at 8074 ms |
| DC03d anon key plus a user token (authenticated), `dc_tick_sleep(10)` (nextval, then a sleep past 8 s) | 500 57014 at 8058 and 8296 ms; the sequence counted 1 execution per request and PostgREST logged 1 line per request (500:1) (run 2: the same) |

Readings: service_role carries no timeout of its own, so a Data API request
under it runs with the 8 s that `authenticator` logs in with. A function's
own `set statement_timeout` applied to the call for every key, anon's 3 s
included, so the competing hypothesis in the module header (the timer starts
before the function's setting applies) did not hold here. An `alter role`
reaches the Data API only at the next config reload. A 500 under the
authenticated role (DC03d) was not sent again, while the PGRST003 probes
(DC01b, DC02b, service_role key) were.

### Not run

- Compute sizes other than Small and Large; another region; a Team or
  Enterprise org.
- `db_pool` 0; `db_pool_acquisition_timeout` 0.
- Requests through Supavisor or direct Postgres (only the Data API path).
- A separating probe for which component sends PGRST003 requests again, or
  for its policy under load; attempt counts inside a burst.
- Client-side error text for the status-0 rows in run 4 (not recorded).

### Cost

Project time from the artifacts' start and finish stamps: run 1 about 38
minutes (23:02:55 to 23:41:10 UTC), run 2 about 13 minutes (23:43:28 to
23:56:48), run 4 about 40 minutes (00:37:06 to 01:17:25). Run 3's project
was created at 23:58:02 (the epoch in its generated name) and deleted with
`make clean DELETE=1` at about 00:36 (console time), about 38 minutes. Each
project was Small until DC01c and Large after. One development project
(Small, never resized, created 22:37:39 by the same reading of its name) was
deleted with `make clean DELETE=1` just before run 1, about 25 minutes. All
times 2026-10-22/23 UTC.
