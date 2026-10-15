# RUNLOG - logs-volume

All runs 2026-10-15. Vantage: one macOS machine in Singapore (Bun 1.3.14),
projects in ap-southeast-1 on a Pro-plan organization, created by each module
and deleted in its `finally` (checked with `GET /v1/projects` after the last
run: no `lv-` project remained; not archived). Figures below are quoted from
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
connection (not measured).

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
