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
