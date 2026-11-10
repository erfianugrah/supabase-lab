# RUNLOG - logs-volume

LV01 and LV02 ran 2026-10-15 on a Pro-plan organization; LV03 ran 2026-11-09
and LV04 and LV05 2026-11-10 on a Team-plan organization, each project created
with no `desired_instance_size` (compute size not read back). Vantage: one
macOS machine in Singapore (Bun 1.3.14), projects in ap-southeast-1, created
by each module and deleted in its `finally` (checked with `GET /v1/projects`
after the last run of each day: no `lv-` project remained; not archived). Figures below are quoted from
the published artifacts unless marked "not archived"; the raw artifacts are in
`evidence/` (gitignored).

Published artifacts (redacted, a `.facts.md` beside each, `out/2026-10-15/`):

| run | module | artifact | note |
|---|---|---|---|
| run1 | LV01 | `run-2026-10-15T00-48-12-600Z.json` | Edge Function rows undercounted, see LV01e |
| run2 | LV01 | `run-2026-10-15T01-20-10-706Z.json` | Edge Function phases last, function_logs by function_id |
| run1 | LV02 | `run-2026-10-15T00-48-17-483Z.json` | pooler SQL path only, no session settings recorded; window included the reset DDL |
| run2 | LV02 | `run-2026-10-15T01-03-02-840Z.json` | pooler session settings recorded; direct path failed (ENOTFOUND) |
| run3 | LV02 | `run-2026-10-15T01-20-48-490Z.json` | pooler and direct paths both measured |

LV03 to LV05, one run each:

| module | artifact | note |
|---|---|---|
| LV03 | `out/2026-11-09/run-2026-11-09T22-42-25-880Z.json` | snapshot job, slowdown named per window |
| LV04 | `out/2026-11-10/run-2026-11-10T00-04-13-049Z.json` | pool lifetime, terminate, full pg_stat_statements, revoke, host query, provenance label; LV04b invalid (see LV04) |
| LV05 | `out/2026-11-10/run-2026-11-10T00-53-56-452Z.json` | idle pool, `reload config` vs `reload schema`, timeout row |

Reading guide. "Docs say" lines come from public pages read on 2026-10-15 and
are not measurements. "Measured" lines name the row, `n` and the run.

Size caveat. "Bytes" is the length of a row's `event_message` plus every key
and value in its `log_attributes` map as the logs endpoint returns it. Metered
ingest bytes are not readable with a PAT, so these are comparable between
actions but are not the GB on an invoice.

## Docs say

- Logs Ingest is charged per byte ingested across all services; $0.50 per GB
  after 20 GB included on paid plans, 1 GB on Free
  (https://supabase.com/docs/guides/platform/manage-your-usage/logs-ingest).
- The same page's optimisation section covers Postgres settings
  (`log_statement`, `log_min_duration_statement`, pgAudit, `log_connections`,
  `RAISE NOTICE` / `RAISE LOG` in functions) and says "Log volume scales with
  your application's traffic and behavior."
- `log_statement`, `log_min_duration_statement` and `pgaudit.*` are settable at
  role level by the `postgres` role through supautils; `log_connections` and
  `log_disconnections` are listed as CLI only
  (https://supabase.com/docs/guides/database/custom-postgres-config).
- `getClaims()` verifies locally against a cached JWKS when the project uses
  asymmetric signing keys and calls the Auth server otherwise
  (https://supabase.com/docs/guides/auth/server-side/creating-a-client).

## LV01 - rows and size per client action

n = 100 actions per row, sequential, one project per run. Keys: legacy anon
key for REST GETs, Edge Functions and Realtime; legacy service_role key for
REST inserts and Storage setup; no key for the public Storage reads; a
password-signed-in user (ES256 access token) for the Auth rows. Per-action
figures for LV01b-d and LV01h-l subtract the idle rate measured in LV01a.
LV01e-g are `function_logs` counted by function_id plus windowed
`function_edge_logs` (`ef_total_*`), not idle-subtracted.

Measured, run2 (run1 in brackets where it measured the same thing):

| row | action | rows per action | bytes per action | where |
|---|---|---|---|---|
| LV01a | idle (180 s, one window) | - | 4.2 MiB/day if extrapolated (4.4) | 520 `pgbouncer_logs`, 40 `postgres_logs` and 60 `function_logs` rows/h; the 3 `function_logs` rows in the window are probably Shutdown rows from the setup warm-up invocations (not determined) |
| LV01b | REST GET, anon key | 0.91 (0.85) | 1659 (1520) | `edge_logs`, 1807 bytes per row |
| LV01c | REST insert, service_role key, one row per request | 0.92 (0.88) | 1610 (1525) | `edge_logs` |
| LV01d | REST insert, service_role key, 100 rows in one request (n = 1) | 1 `edge_logs` row (1) | 1771 (1771) | all-source totals 2.13 rows / 2047 bytes (run2) and 0.13 / 1554 (run1) differ only by `pgbouncer_logs` idle-subtraction noise (+1.13, -0.87) in a 6 s window |
| LV01h | `auth.getUser()`, signed-in user | 1.98 (1.89) | 2604 (2343) | `edge_logs` + one `auth_logs` row (608 bytes) |
| LV01i | `auth.getClaims()`, same user, ES256 token | 0.03 (0.03) | 27 (27) | 1 `auth_logs` and 1 `edge_logs` row for the 100 calls (path not recorded; a JWKS fetch per the docs) |
| LV01j | Storage public object, no key, same object, no query string | 0.97 (1.12) | 1014 (1144) | `edge_logs`; responses 1 MISS, 99 HIT (both runs) |
| LV01k | Realtime broadcast over an open websocket | 0 | 2 | 100 of 100 messages received; no `realtime_logs` or `edge_logs` rows |
| LV01l | Realtime, two clients subscribed and idle (180 s, read over a 186 s padded window) | below idle baseline | below idle baseline | no rows attributable to the subscription |
| LV01e | Edge Function, anon key, no console output | 2.81 | 3019 | `function_edge_logs` 0.91 rows, `function_logs` Boot:95 Shutdown:95 |
| LV01f | Edge Function, one ~100-character console.log | 3.88 | 3622 | Boot:97 Log:100 Shutdown:97 |
| LV01g | Edge Function, ten console.log lines | 12.77 | 8221 | Boot:93 Log:1000 Shutdown:93 |

- Each console line added about 520-540 bytes (LV01f minus LV01e: 1482 - 940
  bytes of `function_logs` per invocation by function_id; LV01g:
  (6150 - 940) / 10).
- A silent invocation still wrote a Boot and a Shutdown row in `function_logs`
  and a `function_edge_logs` row. Shutdown rows landed up to about 3.5 minutes
  after the requests (exploratory probe, 20 invocations, 20 Boot and 20
  Shutdown; not archived). Run1 counted by time window: it attributed 0.98
  `function_logs` rows per invocation, and `function_logs` rows (event type
  not recorded in run1, probably Shutdown) appeared in the later LV01h (5),
  LV01j (6), LV01k (67) and LV01l (70) windows. Run2 runs the Edge Function
  phases last and counts `function_logs` by function_id.
- `edge_logs` rows found for the 100 marked REST GETs: 84 (run1), 92 (run2),
  unchanged after the 300 s tail (run2). Other counts per 100 actions were
  also below 100: `function_edge_logs` 94, 87, 86 (run1, window count) and
  91, 94, 91 (run2); Boot rows 95, 97, 93 (run2, by function_id); `edge_logs`
  for LV01c 86 / 91, LV01h 83 / 97 (run1 / run2). Whether that is sampling,
  loss or arrival later than the run waited is not determined.
- 100 public Storage GETs (99 `cf-cache-status: HIT`, 1 MISS) produced 99
  (run1) and 90 (run2) `edge_logs` rows: cache hits are logged.

Not measured: metered bytes, other regions, load above sequential single
requests, Realtime Postgres Changes, Storage authenticated reads, the
Dashboard Logs Explorer.

## LV02 - Postgres logging knobs

n = 50 anon REST requests (GETs; RPC POSTs for LV02h/i) and 50 SQL statements
per path per condition (pooler all runs, direct run3 only). Settings applied
with `alter role ... set` from a `postgres` session through the shared
pooler. REST traffic waits 45 s first, longer than PostgREST's documented 30 s
`db-pool-max-idletime` default, so that PostgREST should open a fresh pool
connection (not measured). LV05b (2026-11-10) later saw idle pool connections
kept past 330 s; how LV02's settings reached Data API traffic after 45 s is
open, see LV05.

Measured, run3. Run1 and run2 gave the same REST rows per request except run1
LV02e (0.02); bytes within 16 of run3.

| row | setting | `postgres_logs` per REST request | per SQL statement, direct | per SQL statement, pooler |
|---|---|---|---|---|
| LV02a | defaults (`log_statement=ddl`, `log_min_duration_statement=-1`) | 0 | 0 | 0 |
| LV02b | `postgres` `log_statement=all` | 0 | 1.02 rows, 621 bytes | 0 (session reported `log_statement=ddl`, backend_age_s=75) |
| LV02c | `authenticator` `log_statement=all` | 4.02 rows, 4405 bytes | 0 | 0 |
| LV02d | `anon` `log_statement=all` | 0 | 0 | 0 |
| LV02e | `postgres` `log_min_duration_statement=0` | 0 | 1.02 rows, 661 bytes | 0 (session reported `log_min_duration_statement=-1`, backend_age_s=302) |
| LV02f | `authenticator` `log_min_duration_statement=0` | 8.1 rows, 9026 bytes | 0 | 0 |
| LV02g | `postgres` `pgaudit.log=all` | 0 | 1.02 rows, 681 bytes | 0 (session reported `pgaudit.log=none`, backend_age_s=453) |
| LV02h | defaults, RPC with `RAISE NOTICE` | 0 | - | - |
| LV02i | defaults, RPC with `RAISE LOG` | 1 row, 1336 bytes | - | - |

- Of `postgres`, `authenticator` and `anon`, only settings on `authenticator`,
  the role PostgREST logs in as, logged Data API traffic. `log_statement=all`
  on `anon`, the role it switches to, logged nothing (LV02d, three runs).
  `authenticated`, `service_role` and database-level settings were not tested.
- Settings on `postgres` reached new direct sessions in run3 (LV02b/e/g, each
  session reported the new value). Through the shared pooler in session mode
  (run2 and run3) the "new" session reported the pre-change value of the
  setting under test (`log_statement=ddl`, `log_min_duration_statement=-1`,
  `pgaudit.log=none`) and a backend age of 75 to 453 s, growing about 75 s
  per condition, consistent with one reused server connection, and logged
  nothing. Expected but not observed: the setting applies once the pooler
  opens a new server connection.
- At defaults `RAISE NOTICE` writes nothing to `postgres_logs`
  (`log_min_messages=warning`); `RAISE LOG` writes one row per call.
- LV02j: `alter role authenticator reset all` returned OK and left
  `log_statement=all` in place (three runs; also once on a separate dev
  project, not archived); `alter role authenticator reset log_statement`
  removed it.
- Platform roles carry `log_statement=none` at role level
  (`supabase_auth_admin`, `supabase_storage_admin`, `supabase_admin`; read from
  `pg_db_role_setting` on a dev project; not archived).

Not measured: `log_connections` / `log_disconnections` (listed as CLI only on
https://supabase.com/docs/guides/database/custom-postgres-config), auto_explain,
transaction-mode pooler (6543), when Supavisor opens a new server connection.

## LV03 - pg_cron snapshots name the query behind a slowdown

One run, 2026-11-09. Postgres 17.11, pg_cron 1.6.4, pg_stat_statements 1.11
(`pg_stat_statements.max` 5000, `track` top). A pg_cron job runs
`select rca.take()` every 30 seconds: it copies the current database's
`pg_stat_statements` rows and the non-idle client backends of
`pg_stat_activity` into tables in an `rca` schema and deletes rows older than
3 hours (the SQL is `SETUP` in `tests/lv03-snapshot-rca.ts`). The difference
between two snapshots is the work done between them. Workload over the Data
API with the legacy service_role key: 150 s of point reads (`rpc/lv3_light`,
about 5 per second), then 120 s of the same plus 3 concurrent loops of
`rpc/lv3_heavy` (a `like '%abc%'` count over 1,000,000 rows), then 90 s of
point reads. Window boundaries are read from the database clock.

Measured:

- LV03a: 695 `pg_stat_statements` rows readable by `postgres` at setup, 0
  shown as `<insufficient privilege>`.
- LV03b (pass): between the snapshots bracketing the incident window
  (22:46:15 to 22:48:15 UTC) the top statement by execution time was the
  `lv3_heavy` call, 333978.6 ms over 485 calls. Between the snapshots
  bracketing the baseline window it was not in the top 5; the top there was
  the `lv3_light` call, 141.1 ms over 723 calls. Client side: 1788 point
  reads and 506 heavy calls, all HTTP 200; heavy calls p50 702 ms, max
  1077 ms. The snapshots used were 4 to 5 s before each window boundary.
- LV03c: 12 `rca.act_snap` rows caught `lv3_heavy` in flight in the incident
  window (4 snapshots had active rows), 0 in the baseline window; the oldest
  was 617 ms into its query; `usename` was `authenticator` (Data API traffic
  shows under the role PostgREST logs in as, so the query text identifies
  the call).
- LV03d: 15 job runs, 0 failed, 22.6 ms average and 42.8 ms maximum per run;
  705.9 statement rows per snapshot; after 15 snapshots `rca.stmt_snap` was
  1073152 bytes, `rca.stmt_text` 294912, `rca.act_snap` 32768;
  `pg_stat_statements` held 709 rows at the end.

Derived, not measured: 1073152 / 15 is about 71.5 KB per snapshot, so 3 hours
at 30 s (360 snapshots) is about 26 MB of `rca.stmt_snap` at this statement
count. LV04f measures it with `pg_stat_statements` full.

Not settled: a stats reset or restart inside a window (the window query would
take differences across it), snapshot cost on a database under heavy load,
larger compute sizes.

## LV04 - PostgREST pool lifetime, terminate, full pg_stat_statements, revoke, host query

One run, 2026-11-10, Postgres 17.11, PostgREST 14.18 (the `application_name`
in its log rows). The Management API query endpoint ran as `postgres`
(`current_user`), and `postgres` is a member of `pg_signal_backend`. Role
settings on `authenticator` at creation: `statement_timeout=8s`,
`lock_timeout=8s` plus `session_preload_libraries`. "Pool connections" are
`authenticator` client backends in `pg_stat_activity` other than the
`LISTEN` connection (1 seen).

- LV04b is invalid by design: the anon-key call to `rpc/lv4_slow` went out
  right after setup, before PostgREST's schema cache had the function, and
  got 404 `PGRST202`. LV05a repeats it after waiting for a 200.
- LV04c: 8 concurrent `rpc/lv4_slow` calls (1500 ms each, service_role key,
  8 x 200) left 8 pool connections, seen at every sample from 0 to 149 s.
  The module then ran LV04g, whose DDL ends with
  `notify pgrst, 'reload schema'`; by the start of LV04d the 8 were gone
  (LV04d's first pool connections started 00:07:10 and 00:07:20 UTC). LV05b
  and LV05d separate the two causes.
- LV04g (pass): after `alter default privileges for role postgres in schema
  public revoke select, insert, update, delete on tables from anon,
  authenticated` (service_role left out; DD01c also revoked it), a new table
  owned by `postgres` answered an anon-key GET with 401
  `{"code":"42501",...,"hint":"Grant the required privileges to the current
  role with: GRANT SELECT ON public.lv4_after TO anon;"...}` and a
  service_role-key GET with 200 `[{"id":1}]`; `has_table_privilege` false for
  anon and authenticated, true for service_role. A table created before the
  revoke still answered anon with 200.
- LV04d: steady traffic (`rpc/lv4_light` about 2 per second plus
  `rpc/lv4_slow` 300 ms every 10 s, service_role key), then
  `alter role authenticator set log_min_duration_statement = '200ms'` at T0.
  The first `postgres_logs` duration row for `lv4_slow` came 1750 s after T0
  (`duration: 300.947 ms  execute 5: WITH pgrst_source AS ...`). The two pool
  connections present at T0 (started 00:07:10 and 00:07:20) were last seen
  at 1732 s and 1747 s with ages up to 1792 s and 1797 s, and were replaced
  by connections started 00:37:10 and 00:37:20. 117 samples over 1812 s;
  3733 point reads and 188 slow calls, all 200.
- LV04e: `alter role authenticator reset log_min_duration_statement`, then
  60 s: 6 `lv4_slow` duration rows still logged (the replaced connections
  from 00:37 kept the setting). Then, as `postgres`,
  `select ... pg_terminate_backend(pid) from pg_stat_activity where usename =
  'authenticator' and backend_type = 'client backend' and query not ilike
  'listen%'`: 2 targeted, 2 terminated. In the next 150 s, 299 point reads and
  15 slow calls, all 200, and 0 `lv4_slow` duration rows from 10 s after the
  terminate; new pool connections started 00:39:24 and 00:40:10.
- LV04f: 6000 distinct statements (`select c<i> + c<j> from public.lv4_wide
  limit 0`) sent top-level through the Management API query endpoint in
  batches of 500, 0 batch errors, left 4904 `pg_stat_statements` rows (4466
  of them the fill; `dealloc` 7). The snapshot job from LV03 then ran every
  30 s, alongside LV04d's traffic: 10 runs, 0 failed, 82.0 ms average and
  103.5 ms maximum per run, 4911.8 statement rows per snapshot;
  `rca.stmt_snap` 4530176 bytes after 10 snapshots (453018 per snapshot),
  `rca.stmt_text` 729088 bytes (4905 rows), `pg_stat_statements` 4913 rows
  at the end.
- LV04h (pass): the query in `HOST_SQL` (REST requests in `edge_logs`
  grouped by `log_attributes['request.host']` and
  `log_attributes['load_balancer_redirect_identifier']`) answered HTTP 200
  with one row, `<ref>.supabase.co`, empty identifier, 4372 requests. The
  project has no read replica, so the identifier column was not exercised
  here (RR01o records it on a project with one).
- LV04i: `select 1/0` through the Management API query endpoint (400,
  22012) appears in `postgres_logs` followed by `-- source: POST
  /v1/projects/:ref/database/query`, `-- user: scoped_pat:<id>` and a date.
  The `<id>` is the token owner's user uuid (redacted in `out/`); it matched
  the `user_id` the organisation members endpoint returns for that user
  (compared 2026-11-10, not archived). The same statement to the Dashboard's
  route, `POST https://api.supabase.com/platform/pg-meta/<ref>/query`, with
  the PAT got 401 `{"message":"Unsupported access token"}`, so the
  Dashboard's own label was not observed here.

Derived, not measured: 453018 bytes x 360 snapshots is about 163 MB of
`rca.stmt_snap` per 3 hours at 30 s with `pg_stat_statements` full.

## LV05 - idle pool, reload config vs reload schema, timeout row

One run, 2026-11-10, same setup as LV04. Calls start only after
`rpc/lv5_slow` answers 200 (schema cache loaded).

- LV05a (pass): an anon-key call to `rpc/lv5_slow` sleeping 5000 ms got
  HTTP 500 `{"code":"57014",...,"message":"canceling statement due to
  statement timeout"}` after 3040 ms. `postgres_logs` holds one row,
  `canceling statement due to statement timeout`, `parsed.user_name`
  `authenticator`, `parsed.sql_state_code` 57014, and the statement in
  `parsed.query` (`WITH pgrst_source AS ... "public"."lv5_slow"("ms" :=
  pgrst_body."ms") ...`, values as `$1` placeholders); `parsed.detail`
  empty.
- LV05b: 8 concurrent `rpc/lv5_slow` calls (1500 ms, service_role key), then
  no Data API traffic, DDL or NOTIFY: 8 pool connections at all 33 samples
  from 0 to 327 s.
- LV05c: steady traffic (`rpc/lv5_light` every 500 ms, `rpc/lv5_slow` 300 ms
  every 5 s), 45 s, then the 200 ms threshold on `authenticator`: 0
  `lv5_slow` duration rows in the next 90 s. Then
  `notify pgrst, 'reload config'`: the same 8 pool connections (started
  00:59:57 to 01:00:00, the LV05b burst) before and 90 s after, 0 duration
  rows; 179 point reads and 19 slow calls, all 200.
- LV05d: then `notify pgrst, 'reload schema'`: 90 s later 0 of the 8 remained
  and 2 pool connections had started (01:03:43, 01:04:22); 18 `lv5_slow`
  duration rows from 3 s after the NOTIFY, with `parsed.detail`
  `Parameters: $1 = '{"ms":300}', $2 = '1000', $3 = '0'`; 179 point reads
  and 18 slow calls, all 200.

Reading LV04 and LV05 together (one run each):

- On this PostgREST (14.18) idle pool connections were not closed within
  330 s (LV05b). PostgREST documents 30 s for `db-pool-max-idletime` and
  1800 s for `db-pool-max-lifetime`
  (https://docs.postgrest.org/en/stable/references/configuration.html); the
  deployed values are not readable from a project. Connections were replaced
  at 1792 s and 1797 s of age (LV04d).
- A role setting on `authenticator` therefore reached Data API calls 1750 s
  after the `alter role` under steady traffic (LV04d).
  `notify pgrst, 'reload schema'` replaced the pool and the setting applied
  within the next 90 s (LV05d); `notify pgrst, 'reload config'` replaced
  nothing (LV05c); `pg_terminate_backend` as `postgres` also applied it, with
  no failed request at these rates (LV04e).
- LV04c's 8 connections disappearing after LV04g's `reload schema` fits
  LV05d.
- Open: LV02 (2026-10-15) found `authenticator` settings applied to Data API
  requests after a 45 s wait with no traffic, sequential requests and no
  NOTIFY between conditions (LV02c 4.02 and LV02f 8.1 rows per request,
  three runs), while LV05b kept idle connections past 330 s. Not explained;
  LV02 recorded neither PostgREST's version nor the pool's backends.

Not measured: pool behaviour at production concurrency, `reload schema` cost
on a large schema, the transaction-mode pooler and direct connections for the
`postgres`-role settings, the Dashboard's own provenance label.
