# RUNLOG - data-api-reenable

One Supabase project, no AWS. Question: after the Data API is switched back on,
how long until it serves, what does a client see in between, and what can a
client poll to know it is back? The report that prompted it was "the Data API
stays unavailable for a few minutes after re-enabling, and nothing shows in the
logs".

Prior art: http-tier-lockdown measured restore at 1-2 s through the Management
API (run 1) and ~8 s from a Dashboard click (run 2), and showed the Dashboard
toggle writes the same `db_schema` field. Neither run held the API off for longer
than 120 s, so neither could see a recovery that grows with the length of the
outage.

Both runs below ran from an uncommitted tree on top of lab commit a1b10ea (the
facts files record that commit, which does not contain this experiment). The
module code is the commit that adds this RUNLOG; it includes run 2's DA05
pre-enable check and the DA02L SQL time filter, which neither run executed in
full.

## 2026-09-24 - run 1 (Micro, ap-southeast-1, PostgREST 14.5)

Harness: `make probe-destructive ONLY=DA01,DA02,DA03,DA04,DA05` with
`PVLAB_DA_HOLDS=30,300,900`. Artifact and facts:
`out/2026-09-24/run-2026-09-24T02-58-42-654Z.{json,facts.md}`. Server-side log
extract: `out/2026-09-24/postgrest-lifecycle-da02.txt`. It starts at 03:00Z, so
it covers the end of the 300 s hold and its enable, and the whole 900 s cycle,
not the 30 s one; each message is cut at 110 characters. Its last start,
03:21:15Z, is DA03 widening the schema list.

Every recovery time below is measured from the moment the enable PATCH was sent;
switch-off times from the off PATCH; DA04's reload time from the create-table
call (three Management API query round trips included). Each sample is stamped
when its response arrived, and each HTTP path was re-sampled 250 ms after its
previous response (about 300 ms per sample in practice), the Management API
health endpoint 2 s after its previous response.

### What switching off does (DA02, server log)

After `PATCH /v1/projects/{ref}/postgrest {"db_schema": ""}` the PostgREST log
shows a process start (`Starting PostgREST 14.5...`, 03:04:55Z for the 900 s
cycle) and then:

    Failed to load the schema cache using db-schemas=pg_pgrst_no_exposed_schemas

The platform maps an empty `db_schema` to a schema that does not exist, and
PostgREST retries the load with exponential backoff: 1, 2, 4, 8, 16, then 32 s,
where it stays (27 consecutive retries at 32 s in the 900 s cycle). Clients get
`503 PGRST002 "Could not query the database for the schema cache. Retrying."` on
every path PostgREST serves; `rest_table`, `rest_rpc` and the OpenAPI root
turned 503 between 1191 and 2784 ms after the off PATCH across the three cycles.

### What switching on does (DA02)

Both enable PATCHes in the log extract (300 s and 900 s cycles) produced a fresh
`Starting PostgREST 14.5...`, followed by `Schema cache loaded in` 4.2 ms
(03:04:43Z) and 1.9 ms (03:20:00Z). Re-enabling starts a new process; it does not
wait for the next retry of the failing one, so the 32 s backoff cap does not gate
recovery. A PATCH that changes nothing (the restore in the module's `finally`,
03:20:13Z) restarts the process too.

| Hold | `rest_table` 200 | `rest_rpc` 200 | `/rest-admin/v1/ready` 200 | Management API health `ACTIVE_HEALTHY` |
|---|---|---|---|---|
| 30 s | 2136 ms | 2870 ms | 1940 ms | 2204 ms |
| 300 s | 1320 ms | 1227 ms | 1911 ms | 2842 ms |
| 900 s | 952 ms | 887 ms | 989 ms | 1204 ms |

Recovery does not grow with the length of the outage: the longest hold
recovered fastest. n=1 per hold. In the 900 s cycle every path's first
post-enable response was already 200 (no 503 seen after the PATCH), so that
row is the response time of a first request the gateway held while PostgREST
started.

### Readiness signals (DA01, DA02)

- `GET https://<ref>.supabase.co/rest-admin/v1/ready` with the service_role key
  is reachable through the gateway. It answered 200 on the healthy project
  (DA01), a bare `503` (no PostgREST error code) while off, and 200 again after
  each enable, but not always in step with the data paths. Relative to the
  slower data path in each cycle it turned 200 930 ms before `rest_rpc` (30 s
  cycle), 591 ms after `rest_table` (300 s cycle) and 37 ms after `rest_table`
  (900 s cycle, inside one sampling gap). It is PostgREST's own admin readiness
  route and reports the process's view; treat it as "the process is up", and
  confirm with a data read before sending traffic.
- `GET /v1/projects/{ref}/health?services=rest` turned `UNHEALTHY` while off and
  `ACTIVE_HEALTHY` after. At the 2 s poll interval it ranged from 666 ms ahead
  of the slower data path (30 s cycle, where its first poll already came back
  `ACTIVE_HEALTHY`) to 1522 ms behind it (300 s cycle). It shares the 120/min
  Management API budget.
- A cheap anon read (`select=id&limit=1`) is the direct signal: `503 PGRST002`
  (once, in the 300 s cycle, a bare `503`) until the cache loads, `200` after.
- `/graphql/v1` is not a usable signal here: the project created for this run
  did not have `pg_graphql` enabled, so with the Data API on it answered `200`
  with `{"errors": [{"message": "pg_graphql extension is not enabled."}]}`. The
  artifact labels that `200 not-ok`. The `off_graphql_ms` column is therefore
  meaningless (it records the first label that is not `200`, which is that
  envelope) - ignore it.
- `*_sustained_ms = never` on a non-gating path (readiness candidates, health)
  means the run stopped before that path had 10 s of unbroken success, because
  the gating paths had settled.

### Dashboard-equivalent re-enable (DA03)

Studio's switch writes `getDefaultSchemas(config.db_schema)` on enable, which
for an empty `db_schema` is `public` alone
(`apps/studio/components/interfaces/Settings/API/DataApiEnableSwitch.utils.ts`,
read 2026-09-24). DA03 replayed that write through the API on a project exposing
`public,graphql_public,da_api`. 60 s after `rest_table` had held 200 for 10 s
(about 71 s after the enable), `db_schema` read `public`; the table in `public`
answered `200`, while the extra schema and `/graphql/v1` both answered
`406 PGRST106`. Those two stay broken until the schema list is set again, so a
client that reads only the extra schema never sees the API come back. (The module's own detail label says "+60s after
Studio-equivalent enable"; the timing above is what the code does.)

The toggle calls `PATCH /platform/projects/{ref}/config/postgrest`
(`project-postgrest-config-update-mutation.ts`), a route a PAT cannot reach, with
the same body DA02 sends to `/v1/projects/{ref}/postgrest`. The recovery timing
of the Dashboard click was not measured in this run; DA06 is the manual drill
for it and was not run.

### Schema size (DA04)

3002 tables in `public` (3000 bulk tables each with a foreign key to one root
table, plus the root and the fixture table). A plain `notify pgrst, 'reload
schema'` made a new table visible in 1694 ms. After an off/on cycle (30 s off),
`rest_table` answered 200 at 1525 ms and `rest_rpc` at 1738 ms. At this size the
schema added no measurable time: 1525/1738 ms sits inside DA02's 887-2870 ms.
Larger or more function-heavy schemas were not run.

### NOTIFY reload config (DA05)

This run's DA05 rows are superseded by run 2: its third plain trial answered 200
16 ms after t0, so the API was serving at the end of that hold and the module
had not re-checked before enabling. The module now does.

### Harness bugs found on the way

The first three were fixed before run 1; DA02L was fixed after run 1 and has
not been re-run; the last is a limit of the logs endpoint.

- `PATCH /postgrest` refuses `db_pool: null`, which a fresh project reads back:
  `400 "db_pool: Invalid input: expected number, received null"`. The first
  smoke run's PATCHes all 400'd and it measured an API that never went off.
  `setSchemas` now omits a null `db_pool` (Studio does the same) and throws on
  any non-200.
- An empty `stopOn` made the observation window end at once (`every()` over an
  empty list is true), collapsing a 30 s hold to ~7 s.
- Samples stamped at send time recorded "ok at +1 ms": a request sent while
  PostgREST restarts is held and answered 200 by the new process about a second
  later. Samples are now stamped at response time.
- DA02L filtered log rows client-side after `order by timestamp asc limit 1000`
  and got the oldest rows (earlier smoke runs), so it reported 0 lines. The
  published lifecycle extract was pulled by hand with the time filter in SQL;
  the module now filters in SQL too.
- The logs stream endpoint (`/analytics/endpoints/logs`) answers `Table
  "postgrest_logs" does not exist.`; `logs.all` has it.

## 2026-09-24 - run 2 (same project): DA05 only

`make probe-destructive ONLY=DA05`, after adding the pre-enable check. Artifact:
`out/2026-09-24/run-2026-09-24T03-42-43-895Z.{json,facts.md}`. Three alternating
pairs, 60 s off each, `off_before_enable` true in all six.

| Trial | plain: `rest_table` 200 | with `notify pgrst, 'reload config'`: `rest_table` 200 |
|---|---|---|
| 1 | 1347 ms | 1767 ms |
| 2 | 1184 ms | 1342 ms |
| 3 | 1004 ms | 2581 ms |

The NOTIFY (sent through the Management query endpoint right after the enable
PATCH returned, `201` each time) did not shorten recovery; the NOTIFY arm was
slower in all three pairs. Run 1's server log is consistent with that: the
enable already starts a new PostgREST process, which reads its config and loads
the schema cache at start, so a reload has nothing left to do. Why the NOTIFY
arm came out slower is not explained by this run (n=3 pairs).

## What this does NOT answer

- The Dashboard click's own recovery time (DA06, manual, not run).
- A multi-minute window. Nothing measured here produced one: every enable,
  after holds up to 900 s and with 3002 tables, served within 3 s. If a caller
  sees minutes, the candidates left are outside this run's shape - a schema far
  larger or slower to introspect than DA04's, a client that caches the 503 or
  backs off itself, or a request against a schema the toggle dropped (DA03).
- n=1 per condition in DA02 and DA04.

Teardown: `make destroy` (project deleted 2026-09-24; the Management API
answers 404 for the ref).
