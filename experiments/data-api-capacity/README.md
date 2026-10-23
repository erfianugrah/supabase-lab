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
