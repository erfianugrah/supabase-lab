# Troubleshooting segment: find and fix a slow page and a failing call

About five minutes on `kit-ready`. Two faults are injected before the
session: an activity feed that takes 2-5 s per request, and an approval-rate
widget whose RPC fails on every call. The audience sees each fault in the
dashboard (Logs, Query Performance, Advisors, Reports), then a coding agent
connected through the Supabase MCP server finds and fixes both from the
same signals, and the numbers drop to tens of milliseconds. The segment
closes on how the same telemetry leaves Supabase: the Metrics API and log
drains.

`kit-live` is never touched. The faults are their own objects
(`public.activity_events`, `public.activity_summary()`); the example app,
the in-app agent and K01/K02 do not read them.

## Pieces

| Piece | Where | What it does |
|---|---|---|
| Fault SQL | `sql/40-faults.sql` | One `-- fault:` section per fault; applied only by the script |
| Fault script | `scripts/faults.ts` | inject, traffic, check, timing, clear |
| Make targets | `make fault-inject [FAULT=...]`, `fault-traffic`, `fault-check`, `fault-timing`, `fault-clear`, `fault-workspace` | Ready project only; the live ref is refused |
| Agent workspace | `make fault-workspace` -> `~/kit-ready-obs/.mcp.json` (default `OBS_WORKSPACE`) | MCP server scoped to the ready project, `features=database,debugging,docs` |
| Evidence | `evidence/faults/check-*.json`, `evidence/faults-<ref>.json` (gitignored) | Check output; pre-inject snapshot |

### The faults

`slow-activity` - `public.activity_events`, 100,000 rows (about 25,000 per
seeded user), read by the app as
`GET /rest/v1/activity_events?select=id,kind,created_at,actor_id&order=created_at.desc&limit=50`.
The select policy is a copy of the `agent_audit` policy with the
`(select ...)` wrappers dropped:

```sql
using (actor_id = auth.uid()
       or (private.is_manager() and department_id = private.my_department()))
```

so `auth.uid()` and the two `SECURITY DEFINER` helpers run once per row,
and there is no index on `created_at` or on either foreign key, so every
read is a sequential scan of all 100,000 rows and a sort. Managers pay
more than employees: for them `is_manager()` is true, so
`my_department()` runs on every row as well.

`summary-error` - `public.activity_summary()`, an RPC that divides
approvals by decisions in the last seven days. The seed has no decisions,
so every call fails with `22012 division by zero` (PostgREST answers 400).
It reads `activity_events`, so injecting it brings `slow-activity` with it.

The row count is tuned to the 8 s `statement_timeout` of the
`authenticated` role. At 400,000 rows the feed failed instead of being slow:
`500` after 8039-8083 ms for both users (measured 2026-10-07). At 100,000 it
answers `200` in 2.4-5.6 s.

## Setup (T-15 min)

```bash
cd experiments/governed-starter-kit
export TOK_CMD='sx SUPABASE_ACCESS_TOKEN --'

eval "$TOK_CMD make fault-check"      # pre-flight: must print "clean: ..."
eval "$TOK_CMD make fault-inject"     # snapshot, then both faults (about 3 s)
eval "$TOK_CMD make fault-check"      # traffic as alice and bob, then advisors,
                                      # pg_stat_statements and logs; waits for
                                      # log ingestion
rm -rf ~/kit-ready-obs && make fault-workspace
```

`fault-check` runs 5 rounds of the two app calls per user, so Query
Performance and the logs have 20 requests to show. Run it again (or
`make fault-traffic ROUNDS=10`) about 5 minutes before going on, so the
Logs view has recent lines inside its default window.

Then in `~/kit-ready-obs`: start the agent, authenticate the MCP server
(`claude /mcp`, pick `supabase`, Authenticate - same flow as
docs/LIVE-SEGMENT.md), check it lists `get_advisors`, `query_logs` and
`execute_sql`, and quit. Start a fresh session for the run. Use the same
clean Claude Code profile as the live segment.

Browser tabs, ready project, signed in:

1. Logs: https://supabase.com/dashboard/project/_/logs
2. Explorer (Run SQL, query source **Logs**): https://supabase.com/dashboard/project/_/explorer
3. Query Performance: https://supabase.com/dashboard/project/_/observability/query-performance
4. Performance advisor: https://supabase.com/dashboard/project/_/advisors/performance
5. Reports, Database: https://supabase.com/dashboard/project/_/observability/database
6. Edge Functions, `agent` function, Logs tab (no fault there - it is where a
   function's errors would land)

Paste this into the Explorer tab now. It is ClickHouse SQL over the unified
`logs` table; the same query ran through MCP `query_logs` on 2026-10-07 and
put the two fault paths at the top. The docs say Explorer takes the same
dialect (https://supabase.com/docs/guides/observability/advanced-log-filtering);
run it once in rehearsal.

```sql
select log_attributes['request.path'] as path,
       log_attributes['response.status_code'] as status,
       count() as n,
       round(avg(toFloat64OrZero(log_attributes['response.origin_time']))) as avg_origin_ms
from logs
where source = 'edge_logs' and log_attributes['request.path'] like '/rest/v1/%'
group by path, status
order by avg_origin_ms desc
limit 10
```

## Run of show

| Time | Step | Show |
|---|---|---|
| 0:00 | Symptom | `eval "$TOK_CMD make fault-traffic ROUNDS=2"` in a terminal: the feed takes seconds, the summary returns `400 division by zero` |
| 0:30 | Logs | Explorer query above: `/rest/v1/activity_events 200` and `/rest/v1/rpc/activity_summary 400` at the top, the app's other paths in tens of ms. In Logs, Postgres, filter on ERROR: `division by zero` |
| 1:15 | Query Performance | Sort by total time: the PostgREST statement on `activity_events`, mean around 3.4 s. The failing RPC is not listed: pg_stat_statements records only statements that complete, so an error shows up in the logs and nowhere here |
| 1:45 | Advisors | Performance: `auth_rls_initplan` (WARN) on the activity policy, `unindexed_foreign_keys` (INFO) twice. Click through to the remediation link |
| 2:00 | Reports | Database report during a traffic burst. Optional; skip if behind |
| 2:15 | Agent | Paste the prompt below in `~/kit-ready-obs` |
| 4:15 | Verify | `make fault-traffic ROUNDS=2` again: feed and summary in tens of ms, summary `200`. Re-run the advisors: only `unused_index` on the new indexes, expected until they are used |
| 4:45 | Beyond the dashboard | One slide or terminal: metrics scrape, log drains (last section) |

## The prompt

Paste as-is:

```text
Users say the Activity page is slow - it takes several seconds to load the
50 newest events - and the approval-rate widget next to it shows an error.
The page reads public.activity_events newest-first through the Data API, and
the widget calls the RPC public.activity_summary().

Find out why using this project's logs, advisors and query statistics, show
me the evidence for each cause before changing anything, then fix both as
migrations. Keep the access rules exactly as they are: users see their own
events, managers see their department's. Prove the fix by timing the same
query as alice@example.com (employee) and bob@example.com (manager) before
and after, in a transaction you roll back.
```

What the agent should reach for: `get_advisors` (performance) for the
initplan and foreign-key findings; `query_logs` for the slow path and the
400s, or `get_logs` for `postgres`; `execute_sql` for `pg_stat_statements`
and an `EXPLAIN ANALYZE` as each user (`set local role authenticated` plus
the `request.jwt.claims` setting); `apply_migration` for the fix. Tool
names as in the server source
(https://github.com/supabase/mcp, `packages/mcp-server-supabase/src/tools/debugging-tools.ts`).

## What a good fix looks like

```sql
create index on public.activity_events (created_at desc);
create index on public.activity_events (actor_id);
create index on public.activity_events (department_id);

drop policy "activity: own or manager of department" on public.activity_events;
create policy "activity: own or manager of department" on public.activity_events
  for select to authenticated
  using (actor_id = (select auth.uid())
         or ((select private.is_manager()) and department_id = (select private.my_department())));

-- in activity_summary(): divide by nullif(<decisions>, 0), so no decisions
-- gives a null rate instead of an error
```

The policy must mean the same thing afterwards; a fix that drops the
manager arm or makes the table readable through a `security definer`
function to get speed is wrong. Catching the division error in the app is
wrong too.

Measured 2026-10-07 (micro, ap-southeast-1), `EXPLAIN ANALYZE` of the feed
query as each user, every variant applied and rolled back in one
transaction. The first two rows are `make fault-timing` (two runs of three
samples); the rest are one run of three samples each:

| Variant | alice (employee) | bob (manager) |
|---|---|---|
| As injected | 1081-1466 ms | 1904-2159 ms |
| Full fix (above) | 0.25-0.35 ms | 0.33-0.59 ms |
| `(select ...)` wrappers only | 14.7-16.6 ms | 22.9-24.7 ms |
| `created_at` index only | 2.2 ms | 2.1-2.7 ms |
| Foreign-key indexes only | 375-425 ms | 700-837 ms |
| Wrappers + foreign-key indexes | 14.6-20.3 ms | 28.5-82.9 ms |

The wrappers do most of the work for any query on the table; the
`created_at` index is what makes newest-first reads cheap. The foreign-key
indexes alone, which is all the INFO finding asks for, leave the page at
hundreds of milliseconds. If the agent stops after the advisor's
suggestions, ask it for the `EXPLAIN`.

Through the Data API, client wall clock from the operator's machine, 3-8
calls per user:

| Call | Before | After the fix (one MCP migration) |
|---|---|---|
| Feed, alice | 200 in 2408-5557 ms | 200 in 33-83 ms |
| Feed, bob | 200 in 3775-5310 ms | 200 in 37-63 ms |
| Summary, alice | 400 in 922-2926 ms | 200 in 49-73 ms |
| Summary, bob | 400 in 1400-1593 ms | 200 in 55-70 ms |

## What each surface showed (measured 2026-10-07)

`make fault-check` with both faults in, after 25 calls of each path:

- Advisors (Management API `GET /v1/projects/{ref}/advisors/performance`,
  and the MCP `get_advisors` tool, same findings): `WARN auth_rls_initplan`
  on `activity: own or manager of department`; `INFO
  unindexed_foreign_keys` for `activity_events_actor_id_fkey` and
  `activity_events_department_id_fkey`. Present on the first check after
  the inject.
- pg_stat_statements: one statement on the fault objects, the PostgREST
  `WITH pgrst_source AS ( SELECT "public"."activity_events"...` at
  `calls=26 mean=3401.8ms max=5349.0ms`. No entry for the failing RPC.
- Logs (`GET /v1/projects/{ref}/analytics/endpoints/logs`, ClickHouse SQL;
  MCP `query_logs` gave the same picture): `edge_logs`
  `GET /rest/v1/activity_events 200` n=25, `response.origin_time` p50
  3741 ms, max 5537 ms; `POST /rest/v1/rpc/activity_summary 400` n=25, p50
  1335 ms, max 2907 ms; `postgres_logs` `ERROR 22012 "division by zero"`
  n=24, each with a `parsed.query_id`. All present on the first query of
  the check, which started after the traffic finished.
- Metrics API: one scrape of `/customer/v1/privileged/metrics` with HTTP
  Basic `service_role` and the project's secret key (fetched through the
  Management API, never printed) returned 200, `text/plain`, 306 metric
  families, 872 samples, in 784 ms; without credentials, 401. It carries
  database-wide counters (`pg_stat_statements_total_time_seconds`,
  `pg_stat_database_xact_rollback_total`, `pgrst_*`, `node_cpu_*`), not
  per-query detail.

After the fix (MCP `apply_migration`, as the agent would) and
`make fault-clear`: inventory identical to the pre-inject snapshot (64
objects), 0 rows in `supabase_migrations.schema_migrations` (the snapshot
had 0), no advisor findings on fault objects. The clean check 90 s later
found no fault objects, no statements and no log lines since the clear.

## Rehearsal with a coding agent (2026-10-07)

One headless run of the prompt above, verbatim, after `make fault-inject`
and `make fault-check`. Claude Code 2.1.285 in an empty directory outside
the repo, `claude -p` with `--mcp-config .mcp.json --strict-mcp-config
--setting-sources project,local --allowedTools "mcp__supabase__*" Read Write
Edit --permission-mode dontAsk --output-format json`. The model was
`claude-sonnet-5-5` (from `modelUsage`). The `.mcp.json` is the one
`make fault-workspace` writes plus
`"headers": {"Authorization": "Bearer ${SUPABASE_ACCESS_TOKEN}"}`: the MCP
docs give a PAT header for non-interactive clients, and Claude Code expands
`${VAR}` in `headers`, so the token is never in the file and no `/mcp`
login is needed. The server listed `apply_migration`, `execute_sql`,
`get_advisors`, `list_extensions`, `list_migrations`, `list_tables`,
`query_logs` and `search_docs`; no `get_logs`.

Asked to list the instruction files it loaded, the same command answered
"None. No CLAUDE.md files were loaded", with a user-scope `CLAUDE.md` in
place. That is the model's own account, not a trace.

What it did, 46.5 s and 15 turns:

- `get_advisors` (performance and security), `list_tables`, one
  `query_logs` on `postgres_logs` (found `division by zero`; it did not
  query `edge_logs`, so the slow path's timings came from elsewhere),
  `pg_stat_statements` (feed statement, 10 calls, mean 3128 ms).
- Read the policy, indexes and `private` helpers; the first try failed with
  `42725 operator is not unique: text || "char"` and the retry worked.
- `EXPLAIN (ANALYZE, BUFFERS)` as alice and bob with `set local role
  authenticated` and `request.jwt.claims`, rolled back: sequential scan
  plus top-N sort, 1621 ms / 151k buffers and 2405 ms / 301k buffers, the
  helpers in the per-row filter. Called `activity_summary()` as alice:
  `22012`.
- Two `apply_migration` calls in the same turn. The summary fix applied.
  The indexes-and-policy migration came back `{"status":"cancelled"}`.

It did not stop to show the evidence before changing anything, as the
prompt asks; in `-p` mode there is no one to stop for, and the evidence came
in the final message next to the change.

The cancel is the MCP server's confirmation step: `apply_migration` and
`execute_sql` with DROP, DELETE, TRUNCATE or UPDATE without WHERE ask the
client to confirm through an elicitation form
(`packages/mcp-server-supabase/src/tools/database-operation-tools.ts`), and
the headless client did not confirm. The agent reported the migration as
not applied and asked before retrying. One follow-up in the same session
(`--resume`), saying the cancel was the confirmation and asking for the same
change without a DROP, finished it in 15.9 s and 6 turns: `alter policy ...
using (...)` instead of drop and create, which the server does not treat as
destructive. On stage the interactive client should show the confirmation
instead; that path was not rehearsed here, so expect a prompt to accept at
the `drop policy` step. K07 (RUNLOG 2026-10-10) measured the confirmation
from clients with and without elicitation support: a client that does not
declare form elicitation in its 2026-07-28 request metadata ran `drop`,
`truncate` and `update` without `where` with no prompt, and a `skip_elicitations`
list on the server URL removes the prompt for the named tools. The stage
client's declared capabilities decide which of the two the audience sees.

Totals: 19 tool calls (11 `execute_sql`, 3 `apply_migration`, 2
`get_advisors`, 1 each `list_tables`, `query_logs`, tool search), about
65 s of agent time, no files written to the workspace.

What it applied:

```sql
create index activity_events_created_at_idx on public.activity_events (created_at desc);
create index activity_events_actor_id_created_at_idx on public.activity_events (actor_id, created_at desc);
create index activity_events_department_id_created_at_idx on public.activity_events (department_id, created_at desc);
alter policy "activity: own or manager of department" on public.activity_events
  using (actor_id = (select auth.uid())
         or ((select private.is_manager()) and department_id = (select private.my_department())));
analyze public.activity_events;

-- activity_summary(): the divisor wrapped in nullif(..., 0); nothing else changed
```

Against "What a good fix looks like": both causes found from advisors, logs
and query statistics; the policy means the same thing (it checked, rolled
back: alice sees 25,000 rows, none of them someone else's; bob 50,000, all
in his department); the division is fixed in the function, not the app.
The foreign-key indexes are composite with `created_at desc`, which still
covers both foreign keys. It also flagged, without changing it, that the
rate's numerator counts approvals over all time while the denominator is
the last seven days.

Timings (its own `EXPLAIN` before and after, then `make fault-check` and
`make fault-traffic ROUNDS=3` for the Data API):

| Measure | Before | After |
|---|---|---|
| `EXPLAIN ANALYZE` feed, alice (agent) | 1621 ms | 1.1 ms |
| `EXPLAIN ANALYZE` feed, bob (agent) | 2405 ms | 1.6 ms |
| `make fault-timing`, alice / bob | 1023-1140 ms / 1948-1982 ms | not re-run |
| Data API feed, alice | 200 in 2366-2543 ms | 200 in 38-88 ms |
| Data API feed, bob | 200 in 3647-4343 ms | 200 in 39-72 ms |
| Data API summary, alice | 400 in 938-1186 ms | 200 in 53-80 ms |
| Data API summary, bob | 400 in 1410-2907 ms | 200 in 61-72 ms |

Advisors after the fix: one `unused_index` (INFO) on
`activity_events_actor_id_created_at_idx`, nothing else on the fault
objects. `make fault-clear` then removed the two migration rows the agent
added and reported the inventory identical to the pre-inject snapshot (64
objects); the clean check after it found no fault objects, statements or
log lines.

## Fallback

- Agent stalls or the MCP auth fails: apply the fix above by hand in the
  dashboard SQL editor, then `make fault-traffic`.
- Logs not showing recent lines: widen the time range. Ingestion lag
  exceeded 4 minutes once on another project in this lab, so generate the
  traffic well before going on.
- Query Performance empty: someone reset pg_stat_statements; run
  `make fault-traffic ROUNDS=10` and refresh.
- Anything else: `make fault-clear && make fault-inject && make fault-check`
  takes about two minutes.

## Reset

```bash
eval "$TOK_CMD make fault-clear"   # drop, reset statements, compare with snapshot
eval "$TOK_CMD make fault-check"   # with no faults recorded: clean check, no traffic
```

`fault-clear` drops `activity_summary()` and `activity_events` with
`cascade` (taking any index, policy or view the agent added on them),
deletes migration-history rows that name them and were not in the
snapshot, resets their pg_stat_statements entries, then re-takes the
inventory (relations, columns, grants, indexes, policies, functions,
triggers, constraints, types and migration rows in `public` and `private`,
plus triggers on `auth` tables) and exits non-zero if anything differs from
the snapshot. If the agent changed something outside the fault objects, it
shows up as a diff to resolve by hand. Advisor findings unrelated to the
fault objects (`unused_index`) came and went between snapshots with index
statistics; they are printed, not counted. Log lines already ingested
cannot be removed; they age out with retention.

Do not run `fault-timing` during the segment: its pg_stat_statements
entries are reset afterwards, but its statements still land in the Postgres
logs.

## Beyond the dashboard: exporting telemetry

Checked against the docs on 2026-10-07. The `telemetry/*` doc paths
redirect (308) to `observability/*`.

**Metrics API (Prometheus format).** Every hosted project exposes
`https://<project-ref>.supabase.co/customer/v1/privileged/metrics`, about
200 Postgres and host series, HTTP Basic auth with username `service_role`
and a secret API key (`sb_secret_...`) as the password; scrape once a
minute. The feature is in beta and not available on self-hosted Supabase.
The page states no plan restriction ("Every Supabase project exposes...");
measured working on this Team-org micro project.
https://supabase.com/docs/guides/observability/metrics

- Grafana Cloud: one-click integration from the dashboard
  (https://supabase.com/dashboard/project/_/integrations/grafana-cloud/overview),
  or manual setup. The "Free or Pro tier" on that page is Grafana Cloud's
  tier, not Supabase's.
  https://supabase.com/docs/guides/observability/metrics/grafana-cloud
- Self-hosted Prometheus + Grafana: a scrape job with
  `metrics_path: /customer/v1/privileged/metrics`, `scheme: https`,
  `basic_auth`, `scrape_interval: 60s`, then import the dashboard JSON.
  The example YAML on that page shows `username: username`; the metrics
  page and the repo use `service_role`.
  https://supabase.com/docs/guides/observability/metrics/grafana-self-hosted
- `supabase-grafana`: Docker Compose Prometheus + Grafana with the
  dashboard and example alert rules; `.env` takes the project ref and
  secret key, or an access token for several projects. Its README says it
  is an example and not intended for production.
  https://github.com/supabase/supabase-grafana
- Datadog, Elastic and other Prometheus-compatible collectors scrape the
  same endpoint (links on the metrics page).

For these faults the metrics feed carries only database-wide signals, such
as `pg_stat_database_xact_rollback_total` for failed transactions and
`pg_stat_statements_total_time_seconds` for time spent in queries (not
measured against these faults). It can tell an alert that something is
wrong; finding the query still takes Query Performance and the logs.

**Log drains.** Send the logs of every service to one or more
destinations: custom HTTP endpoint, OpenTelemetry (OTLP over HTTP,
protobuf, `/v1/logs`), Datadog, Loki, Amazon S3, Sentry, Axiom, Last9,
Syslog. Pro, Team and Enterprise plans only, configured under Project
Settings > Log Drains.
https://supabase.com/docs/guides/observability/log-drains
Pricing: $0.0822 per drain-hour ($60 per month per drain), $0.2 per
million events, plus egress.
https://supabase.com/docs/guides/platform/manage-your-usage/log-drains

**Programmatic queries without a drain.** The Management API logs
endpoint takes the same ClickHouse SQL as Explorer and MCP `query_logs`,
GET only, with `iso_timestamp_start` and `iso_timestamp_end` (at most 24
hours). Query errors come back as HTTP 200 with an `error` field.
https://supabase.com/docs/guides/observability/advanced-log-filtering
https://supabase.com/docs/reference/api/v1-get-project-logs

**Plan differences in the dashboard.** Reports: Free up to 24 hours, Pro 7
days, Team and Enterprise 28 days; the advanced Database report charts are
Team and Enterprise only. Log retention depends on the plan.
https://supabase.com/docs/guides/observability/reports
https://supabase.com/docs/guides/observability/logs
https://supabase.com/docs/guides/observability/advisors
