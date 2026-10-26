# data-api-capacity

How the Data API (PostgREST) behaves when more requests arrive than it has
database connections, and which statement timeout a request runs under. The
platform question: what is the pool when `db_pool` is unset, what does a
client see when the pool is full (status, code, how long it waits), what does
changing `db_pool` and `db_pool_acquisition_timeout` through the Management
API cost and do, and which of the role, function and `ALTER ROLE` timeout
settings a Data API request honours.

Self-provisioning: DC01-DC03 share one Pro-org project (ap-southeast-1)
created Small on first use; DC01c resizes it to Large; DC99 deletes it. No
OpenTofu state. Sibling context: `data-api-reenable` (what a PostgREST config
PATCH restarts), `platform-downtime` (resize windows), `client-retries`
(supabase-js retries on 5xx).

## Modules

| id | claim measured |
|---|---|
| DC01 | `GET /postgrest` defaults; the pool with `db_pool` unset on Small and on Large, counted as `authenticator` backends in `PgSleep` mid-burst (two bursts per size); with the default config and the pool held, a single request's status, code and time to answer, and how many PostgREST access-log lines it caused; the Small to Large resize time |
| DC02 | after every PATCH, the delay to the "Starting PostgREST" log line; two `db_pool` PATCHes: Data API failures sampled every 250 ms, readback, and the pool Postgres then sees; `db_pool_acquisition_timeout` 2 and 4 against the client's time to PGRST003 and attempts per request; out-of-range values sent (`db_pool` 1001 and -1, acquisition timeout 61); 220 concurrent requests after an explicit PATCH back to the default figure (`db_pool` 50, the control) and at `db_pool` 1000 on Large (max_connections 160); 20 in-flight 60 s requests across a no-change PATCH; restart lines vs PATCHes |
| DC03 | `rolconfig` of anon, authenticated, service_role, authenticator; the timeout a Data API call meets per key/role; a function declared `set statement_timeout = '30s'`; `alter role authenticated set statement_timeout` before and after `notify pgrst, 'reload config'` and `'reload schema'`; a request failing 500 after a side effect: executions and PostgREST attempts |
| DC04 | request RATE rather than duration: closed-loop GET point reads at rising concurrency on the starting size and after a resize (default `ci_4xlarge`), with `pgrst_db_pool_*` from the metrics endpoint every 3 s, node CPU and `authenticator` states; then `db_pool` arms. Opt-in, not in the default `ONLY`: `make run ONLY=DC04,DC99`, `PVLAB_DC_REGION` / `PVLAB_DC_SIZE` pick the project, `PVLAB_DC04_*` the steps; needs `oha` |
| DC05 | what `pgrst_db_pool_{waiting,available,max}` count against `pg_stat_activity`: 1 s scrapes while held requests step 0, 5, 15, 25, 0 (how often the series change, lag from a step), 10 and 40 held on a pool of 30 side by side with the `authenticator` backends, and the time from a `db_pool` PATCH (20, then 30) to the restart line and to the metric. Opt-in like DC04 |
| DC06 | a lock on `dc_items` (`access exclusive`, 2 s control then 12 s) under 20 looping anon GETs, so waiting requests pass anon's 3 s statement timeout: statuses and codes before, during and after, `authenticator` states every 5 s, and whether any pooled connection stays `idle in transaction (aborted)` and answers 25P02 afterwards. Opt-in |
| DC07 | `db_pool` 15, 30 and 60 on Small, each followed by the DC04 step (closed-loop `oha`, 40 s) at 128, 256 and 512 concurrent: does a bigger pool raise throughput under closed-loop load that may queue requests for a connection. Opt-in; `PVLAB_DC07_POOLS` / `PVLAB_DC07_C`; needs `oha` |
| DC08 | in-region clients and an application-like mix on 4XL (default `ci_4xlarge`): Edge Function invocations pinned with `x-region` to the project's region (`gen/dc08-gen/index.ts`, one closed-loop client of `PVLAB_DC08_K` workers per invocation, rounds of `PVLAB_DC08_ROUND_S` s chained into a step) send point reads 50, 50-row range reads 15, an RPC lookup 15, inserts 10 and `Prefer: count=exact` reads 10 (weights); per step the throughput, latency per op, statuses and one body per non-2xx status, pool snapshots, `authenticator` states about every 4 s (8 s at the top steps), Postgres executor ms per second (`pg_stat_statements`), generator lag, failed invocations and Cloudflare colo; ramp until throughput gains under 10 %, then `db_pool` 150, 250, 70 at that concurrency. Opt-in: `make run ONLY=DC08,DC99` with `PVLAB_DC_REGION`; `PVLAB_DC08_*` pick size, steps, pools, workers and rounds |
| DC09 | which function-level `set statement_timeout` a Data API call honours (authenticated user, 12 s sleeps): control, outer/inner nesting both ways, a nested shorter value, `language sql stable` by GET and POST /rpc, SECURITY DEFINER, a 70 s sleep under `set 120s` (executions, commit, log rows), `alter function ... set` before and after a schema reload; then the same functions from pg_cron and from a session-pooler `set role authenticated` session with an 8 s caller timeout. Opt-in: `make run ONLY=DC09,DC99` |
| DC12 | PGRST003 resends: with the pool held, single GET, HEAD, PATCH and POST /rpc per acquisition timeout (1, 5, 20, 60 s) and a burst of 3 x pool at 5 s; per request the client's time and status, PostgREST access-log lines and `edge_logs` rows by User-Agent, response headers, and `pgrst_db_pool_timeouts_total` before and after. Opt-in: `make run ONLY=DC12,DC99` |
| DC13 | the Data API pool and Realtime's connections with nothing configured, per size: Small, then each of `PVLAB_DC13_SIZES` (default `ci_xlarge,ci_2xlarge`) after a resize; GET `/postgrest`, `pgrst_db_pool_max` over 90 s, two bursts of `PVLAB_DC13_K` (150) 12 s sleeps with the mid-burst PgSleep count, `max_connections`, GET `/config/realtime` and a 100-join Postgres Changes burst (realtime-surface `lib/burst.ts`) with Realtime's connections by name. Opt-in: `make run ONLY=DC13,DC99` |
| DC14 | statements of `PVLAB_DC14_S` (3) s through the Data API on the current size, `pg_sleep` vs a calibrated CPU loop, at `db_pool` as found then each of `PVLAB_DC14_POOLS` (140,200): bursts of 1.5 and 3 x the pool and an open loop (`PVLAB_DC14_RATE_SLEEP` 40/s, `PVLAB_DC14_RATE_CPU` 4/s, `PVLAB_DC14_OPEN_S` 120 s); outcomes by status and code, p50/p95, client backends by role, `authenticator` on CPU, node CPU. Opt-in, after DC13 |
| DC15 | a set `db_pool` across a resize: `PVLAB_DC15_ARM=custom` PATCHes 45 on Small, resizes to Large, PATCHes 120, resizes to Small, reading the pool four ways at each step; `control` does the same resizes with `db_pool` never set. One project per process: `make run ONLY=DC15,DC99` |
| DC16 | Realtime's authorisation pool on a project created at `PVLAB_DC_SIZE` (`desired_instance_size`, e.g. `2xlarge`, with a `small` control in a second process): GET `/config/realtime` before any Realtime client, `max_connections` and node CPUs, the Data API pool with `db_pool` unset (one burst of `PVLAB_DC16_K`, 150), then DC13's Realtime row (config, a 100-join Postgres Changes burst, Realtime's connections by name). One project per process: `make run ONLY=DC16,DC99` |
| DC17 | which layer ends a long Data API request near 125 s: `dc17_sleep(s, tag)` (`set statement_timeout = '600s'`, inserts its tag, sleeps, stamps the finish) at each of `PVLAB_DC17_S` (100 to 180 s) concurrently per round (`PVLAB_DC17_ROUNDS`, 2), POST /rpc with the service_role key, plus the anon key and GET /rpc at 150 s in round 1; per request status, time, body, response headers, PostgREST and `edge_logs` lines by User-Agent, when its backend was first and last seen in `pg_stat_activity` (application_name `dc17-<tag>`, ~3 s poll) and whether its row committed; the same 180 s call over a direct Postgres connection and a session-pooler connection; `postgres_logs` cancel/terminate/client lines. Opt-in: `make run ONLY=DC17,DC99` (Small by default) |
| DC99 | teardown |

## Run

```bash
export PVLAB_ORG_PRO=<pro-org-slug>
sx SUPABASE_ACCESS_TOKEN -- make run       # DC01-DC03 then DC99, about 45 minutes, artifacts in evidence/<ts>/
sx SUPABASE_ACCESS_TOKEN -- make clean     # list leftover pvlab-dc-* projects; DELETE=1 deletes
make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
```

`PVLAB_DC_REF=<ref>` reuses an existing project (development only: DC99
leaves it, and a project whose PostgREST config was already patched no
longer measures the default). Results and their limits are in RUNLOG.md.
