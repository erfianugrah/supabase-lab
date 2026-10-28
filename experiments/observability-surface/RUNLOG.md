# RUNLOG - observability-surface

All runs 2026-10-10 except OB03d (2026-10-23) and OB06 (2026-10-28), each in its own section. Vantage: one macOS machine in Singapore (Bun 1.3.14; Node v26.11.1
for the esbuild bundles; `supabase` CLI 2.120.0), projects in
ap-southeast-1 on a Pro-plan organization, Management API from the same
machine. Raw run artifacts are `evidence/run1/` to `evidence/run3/`
(gitignored: they carry project refs); the figures below are quoted from them
and the redacted copies are listed under "Published artifacts" below. The side
files `ob01-clients.json`, `ob02-polls.json` and `ob03-canary.json` are not
run artifacts and stay in `evidence/`.
Every project this experiment created was deleted by the module that made it
(checked with `GET /v1/projects` after the last run: none named `ob-surface-`
remained).

Published artifacts (redacted, a `.facts.md` beside each, `out/2026-10-10/`; OB03d in `out/2026-10-23/`; OB06 in `out/2026-10-28/`):

| run | module | artifact |
|---|---|---|
| run1 | OB01 | `run-2026-10-10T00-36-30-860Z.json` |
| run1 | OB02 | `run-2026-10-10T00-35-30-688Z.json` |
| run1 | OB03 | `run-2026-10-10T00-48-25-371Z.json` |
| run1 | OB04 | `run-2026-10-10T00-39-42-004Z.json` |
| run1 | OB05 | `run-2026-10-10T00-40-48-205Z.json` |
| run2 | OB01 | `run-2026-10-10T00-45-35-196Z.json` |
| run2 | OB02 | `run-2026-10-10T00-59-06-273Z.json` |
| run2 | OB05 | `run-2026-10-10T00-59-15-215Z.json` |
| run3 | OB01 | `run-2026-10-10T01-10-20-267Z.json` |
| run3 | OB02 | `run-2026-10-10T01-23-47-158Z.json` |
| ob03d-run1 | OB03d | `run-2026-10-23T10-34-27-519Z.json` |
| ob03d-run2 | OB03d | `run-2026-10-23T10-45-54-614Z.json` |
| ob06-run2 | OB06 | `run-2026-10-28T08-30-38-352Z.json` |
| ob06-run3 | OB06 | `run-2026-10-28T08-38-28-289Z.json` |

Reading guide. "Docs say" lines come from public pages read on 2026-10-10 and
are not measurements. "Measured" lines name the module row, `n`, and the run.
"Not measured" lines say what the run did not do.

## OB01 - client trace propagation

Docs say (https://supabase.com/docs/guides/observability/client-side-tracing,
https://supabase.com/blog/connect-client-traces-to-your-logs): with
`tracePropagation` on, supabase-js attaches `traceparent`, `tracestate` and
`baggage` to requests for Supabase domains only; the trace id then appears in
API Gateway and Edge Function logs; from 2.112.0 the OpenTelemetry integration
is the opt-in `@supabase/supabase-js/tracing` import, without it one warning
and no headers; 2.106.0-2.111.x load `@opentelemetry/api` dynamically and
silently send nothing when it is missing; before 2.112.3 an unsampled span
sends no headers, from 2.112.3 it sends `traceparent` only.

Design: one client (`@opentelemetry/sdk-trace-node`, default W3C propagator)
rendered per variant from `apps/client.template.ts` against one project with a
table and an Edge Function that logs the `traceparent` it received. Releases
from npm aliases: 2.111.0 (the only stable 2.111.x on the registry; 2.111.1-canary.0 and 2.111.1-canary.1 also exist and were not run), 2.112.0, 2.117.3
(latest on 2026-10-10). Headers are read at the client's own `fetch` boundary
(a recording custom `fetch`), so "sent" means the SDK attached them, not that
a server kept them.

Measured, OB01a (n = 1 client run per cell; the same matrix came out in all
three runs, `run1`, `run2`, `run3`). Cell = `traceparent` attached to a REST
call and to an Edge Function invoke made inside an active span (both calls
gave the same answer in every cell); `tracestate` and `baggage` were not
attached in any cell (the default provider sets neither).

| release | unbundled (Bun) | Bun bundle, run next to `node_modules` | Bun bundle, run with no `node_modules` | esbuild bundle (Node), next to `node_modules` | esbuild bundle (Node), no `node_modules` |
|---|---|---|---|---|---|
| 2.111.0 | sent | sent | none, no warning | sent | none, no warning |
| 2.112.0 | sent | sent | sent | sent | sent |
| 2.117.3 | sent | sent | sent | sent | sent |

The Bun runs of bundles used `bun --no-install`: an earlier run of this same
module without that flag showed 2.111.0 sending from the no-`node_modules`
directory. The explanation that Bun fetched `@opentelemetry/api` from the
registry at run time is an inference (the flag changed the outcome; the fetch
itself was not observed). Reading: the loss in the 2.111 release needs a bundle in which the SDK's
runtime `import("@opentelemetry/api")` cannot resolve; 2.112.0 and later carry
the import statically through the `/tracing` subpath and did not lose it.

Controls (OB01a, n = 1 each):

- 2.112.0 without the `/tracing` import: no headers, one `console.warn`
  beginning "tracePropagation is enabled but the tracing runtime is not
  loaded" (as documented).
- 2.112.0, unsampled span: no headers (documented for releases before
  2.112.3). Latest release, unsampled span: `traceparent` sent (documented for
  2.112.3 and later). `tracestate`/`baggage` were not asked about in this row.
- Latest release with `tracePropagation` off: none. A REST call with no active
  span: none, in every variant.
- Non-Supabase hosts: the client's wrapped `fetch` (`client.fetch`, with a fake
  transport underneath so nothing left the machine) given `third-party.example.test`,
  `xsupabase.co` and `supabase.co.example.test`: no headers, all three
  releases. The same wrapped `fetch` given a host under `.supabase.co` that is
  not the client's project: `traceparent` attached. A client created with a
  non-Supabase base URL (the self-hosted shape): `traceparent` attached to its
  own host, because the SDK adds the base URL's hostname to the default targets
  (read in the installed latest release's `dist/index.mjs`,
  `getDefaultPropagationTargets`; the docs page lists `*.supabase.co`, `*.supabase.in` and `localhost` as the
  default targets and does not mention this exception). Not measured: a custom domain, redirects, and a custom
  `fetch` that rewrites the URL after the SDK's host check (the check reads the
  URL before the custom `fetch` runs, from the source, not from a run).

Measured, OB01b/OB01d/OB01e (log side, run3, 19 variants, 57 trace ids):

- REST: the client's trace id came back as the `trace_id` attribute of an
  `edge_logs` row in 14 of 14 variants where the header was sent, and in none
  of the 5 where it was not.
- Every `edge_logs` row has a `trace_id` (38 of 38), including requests
  without a client header; the other sources: `postgrest_logs` 0 of 106,
  `function_edge_logs` 0 of 39, `function_logs` 0 of 78, `auth_logs` 0 of 43,
  `storage_logs` 0 of 3, `realtime_logs` 0 of 5, `pgbouncer_logs` 0 of 96,
  `postgres_logs` 0 of 17 (OB01d).
- Edge Function invoke: the function received a `traceparent` carrying the
  client's trace id in all 14 sending variants (the function echoes it). The
  platform's own function log rows did not: a search of every attribute key and
  the message of every source for six client trace ids (the REST id and the
  function id of each of the three unbundled variants) found the three REST ids
  as the `trace_id` attribute of `edge_logs` rows and the three function ids
  only inside the `function_logs` message that the function's own `console.log`
  wrote (OB01e). So, on this project and run, "trace_id appears in Edge Function
  logs" held only for what the function prints itself; `function_edge_logs`
  rows (the invocation record) carried no trace id at all. This is the one row
  where measurement and the docs page differ; n = 1 project, one run, and the
  platform may stamp function rows under a key or source this query did not
  cover.
- A function call made with no active span still reached the function with a
  platform-generated `traceparent` (trace flags `00`) and a `baggage` entry
  `sb-request-id`, in every variant (`fn_no_span_received`).

Not measured: browser bundles, webpack/Vite/Turbopack, Realtime frames, the
Swift/Dart/Python SDKs, Sentry/Datadog propagators, a `tracestate` or `baggage`
value set by the app.

## OB02 - Health Check Advisors

Docs say (https://supabase.com/changelog/50577-health-check-advisors,
2026-09-18): four checks, `log_data_api_error_rate_high`,
`log_auth_error_rate_high`, `log_storage_error_rate_high`,
`log_edge_function_error_rate_high`, "read from log data"; `POST
/v2/projects/{ref}/advisors/run` returns them, "results are cached"; an empty
result means all checks ran and found nothing. The lint text returned by the
platform itself says: 5xx for at least 10% of requests across two consecutive
five minute periods; failures must persist in both.

Design: one project per arm, arms concurrent; each arm waits for the next UTC
five-minute boundary, sends at fixed rates for two buckets (one bucket for the
single-bucket arm), polls the four health lints every 30 s until the lint has
cleared or 8 minutes after traffic ended. 5xx are real service answers:
PostgREST `PT500` raised from a function (data), a `BEFORE INSERT` trigger on
`auth.users` that raises (Auth admin create, 500), a `storage.objects` policy
function that raises (Storage list, 500), an Edge Function returning 500 and
one that throws. Three runs (`run1` 11 arms, `run2` 8 arms, `run3` 5 arms);
every arm is n = 1 unless marked repeat.

Measured, firing (OB02 rows):

| arm | requests per five-minute bucket | failing per bucket | share | fired |
|---|---|---|---|---|
| data 100% | 100 | 100 | 100% | yes |
| data 50% | 100 | 50 | 50% | yes |
| data 12% | 100 | 12 | 12% | yes |
| data 8% | 100 | 8 | 8% | yes |
| data 5% (run2, repeat in run3) | 100 | 5 | 5% | yes, yes |
| data 4% | 100 | 4 | 4% | no |
| data 3% (run2, repeat in run3) | 100 | 3 | 3% | no, no |
| data 2% | 250 | 5 | 2% | yes |
| data 1% | about 600 (598 sent) | 6 | 1% | yes |
| data 1% | 100 | 1 | 1% | no |
| data 100%, one request a minute | 5 | 5 | 100% | yes |
| data 20%, one request a minute | 5 | 1 | 20% | no |
| data 100%, one request per bucket | 1 | 1 | 100% | no |
| data, 404 on every request | 100 | 0 (all 404) | 0% 5xx | no |
| data, 100% failing in bucket 1 only, healthy bucket 2 | 100 | 100 then 0 | | no |
| data, healthy bucket 1, 100% failing in bucket 2 | 100 | 0 then 100 | | no |
| data, 100% failing for one bucket, no second bucket | 100 | 100 | | no |
| Auth admin create, 100% 500 | 100 | 100 | 100% | yes |
| Storage list, 100% 500 | 100 | 100 | 100% | yes |
| Edge Function returning 500 | 100 | 100 | 100% | yes |
| Edge Function that throws | 100 | 100 | 100% | yes |

Reading, stated as inference from these rows: the lint fired in every arm that
had at least 5 failing requests in each of two consecutive five-minute buckets
and in no arm with 4 or fewer, whatever the share (1% to 100%), so the
operative rule on this project looks like a failing-request count of about 5 per
period, not the 10% share in the lint's own text. Separating probes not run:
exactly 4 versus 5 at other volumes, a count of 5 at a very high volume
(thousands per bucket), whether the share rule applies on top of the count at
volumes that large, and the buckets being clock-aligned (the arms started at a
boundary on purpose; a start mid-bucket was not run).

Measured, timing (fired arms, 13 firings across three runs):

- First lint 35-36 s after the end of the second bucket in `run1` (9 arms) and
  65-66 s in `run2`/`run3` (4 arms); the poll interval was 30 s, so each figure
  is an upper bound within 30 s. The lint was not present at any poll before the
  second bucket had closed.
- Cache: `observed_at` of the returned lint advanced in steps of 86-91 s with
  30 s polling (median, per arm). An earlier exploratory run polling every 10 s
  on one project (not archived) showed steps of 62-64 s (four refreshes), so the
  refresh is about 60 s and the 90 s steps are the next 30 s poll after expiry.
  An immediate second call at baseline returned the same empty list in all 24
  arms (`baseline_lints`).
- Clearing: the lint was gone 306-337 s after the last failing request in 12
  arms and 367 s in the 8% arm; that is the first poll after the next bucket
  boundary plus the cache.
- Detail text at firing: `Failing: <service> (<share>% of <n> requests
  failing)`, where `<n>` is the request count of the most recent bucket (100,
  250, 600 in the arms above); for Edge Functions the service field is the
  function path. `level` was `ERROR`, `categories` `HEALTH`.
- Counts: arms sending 100 requests per bucket reported 100; the arm with 5
  requests per bucket reported 5. In the very first exploratory run (60 then 500
  failing requests, not archived) the lint reported 538 requests against 560
  sent, so a small fraction of requests may not be counted; in the archived
  arms the lint count matched the sent count for the 100-per-bucket arms and
  the 5-per-bucket arm, and was +2 (600 reported, 598 sent per bucket) in the
  600-per-bucket arm.
- No other lint appeared in any arm (`other_lints_seen` none); no
  `advisor_check_unavailable` was seen.

Not measured: the other lints in the v2 enum, Realtime, projects with real user
traffic, other regions, other plans, the Studio Health tab.

## OB03 - log canary, sources, usage visibility

Docs say: the public pages make no claim about ingestion lag. Earlier lab runs recorded one ingestion lag above 4 minutes
(`AGENTS.md`, medium-serverless MS05).

Design: one project, one marked REST request (lands in `edge_logs`) and one
marked Edge Function invoke (lands in `function_edge_logs` by URL and in
`function_logs` by the console line) every minute for 36 minutes (n = 36
markers per source, one window, 00:48-01:24 UTC), a poller asking the logs
endpoint for every marker every 15 s, and the time of the first poll that
returned each marker as the "first seen" time.

Measured, OB03a (run1):

| source | markers returned | lag p50 | p90 | p99 | max | over 240 s |
|---|---|---|---|---|---|---|
| `edge_logs` | 36 of 36 | 15 s | 15.1 s | 30 s | 30 s | 0 |
| `function_edge_logs` | 36 of 36 | 15 s | 15.1 s | 15.1 s | 15.1 s | 0 |
| `function_logs` | 36 of 36 | 15 s | 15.1 s | 15.1 s | 15.1 s | 0 |

The 15 s poll is the resolution: a marker was returned by the first poll after
it was sent in nearly every case, so these figures are ceilings within one poll,
not a distribution below 15 s. The row's own `timestamp` minus the send time was
0 to 1 s. 142 polls, none returned an error. The ingestion lag above 4 minutes
seen once in earlier lab runs was not reproduced in this window. No logs-blind
alert was built; the probe (marker every minute, first-seen time) is the input
such an alert would read, and no threshold is derived from one 36-minute window.

Measured, OB03b (sources the logs endpoint returned on this project after one
request of each kind, run1): `auth_audit_logs`, `auth_logs`, `edge_logs`,
`function_edge_logs`, `function_logs`, `pgbouncer_logs`, `postgres_logs`,
`postgrest_logs`, `realtime_logs`, `storage_logs`, `supavisor_logs` (11 sources;
counts in the artifact). The pooler and Realtime are both carried
(the run issued one connection through the shared pooler on 6543 and on 5432
and one websocket join; the artifact holds one source-count query taken at the
end of the run, so which source appeared when, and whether `pgbouncer_logs`
rows exist before any connection, was not measured). Where this run's own
markers landed (message search): the failing pooler statement's literal in
`postgres_logs` (2 rows, one per port); the storage bucket and object name in
`storage_logs` (2 rows) and `edge_logs` (1); the Auth user email in `auth_logs`
and `auth_audit_logs` (1 each); the Realtime topic name in no source.

Measured, OB03c (run1): 300 marked REST requests sent in a burst, all answered
200; 300 rows returned by the logs endpoint for them. 36 of 36 canary REST
markers returned. `usage.api-requests-count` returned a count of 341 and the
logs endpoint counted 341 `edge_logs` rows for the project: the REST canary 36,
the burst 300, and 5 further rows (not itemised); the 37 function invocations are in
`function_edge_logs`, not in either figure. `usage.api-counts` returned
per-minute `total_rest_requests` / `total_auth_requests` /
`total_storage_requests` / `total_realtime_requests` buckets (HTTP 200; body in
the artifact). The v1 OpenAPI document has no organization usage path, and
`GET /platform/organizations/{org}/usage` with the PAT answered 401
`Unsupported access token` (an unsupported-token response like the audit route in
bu-attribution BA06, which answered 401 `JWT could not be decoded`; the message
differs). So the organization-level logs figures (GB ingested, GB queried) behind
the logs usage-based pricing page were not reachable and no known log volume was
compared with them.

Not measured: logs per GB, query-quota billing, the Dashboard Logs Explorer,
load above one request a minute (other than the 300-request burst), other
regions. Rate limit: no throttling was met at 4 logs queries a minute alone;
OB02 ran alongside without a 429 seen by this module.

## OB03d - logs endpoint and MCP `query_logs` edge cases (2026-10-23)

Docs say (all read 2026-10-23):

- v1 OpenAPI document (https://api.supabase.com/api/v1-json), operation
  `v1-get-project-logs`, `GET /v1/projects/{ref}/analytics/endpoints/logs`:
  "Either the `iso_timestamp_start` and `iso_timestamp_end` parameters must be
  provided. If both are not provided, only the last 1 minute of logs will be
  queried. The timestamp range must be no more than 24 hours and is rounded to
  the nearest minute. If the range is more than 24 hours, a validation error
  will be thrown." The documented 200 response schema has both `result` and
  `error`. `logs.all` is marked deprecated: "This endpoint has been removed
  and always responds with `410 Gone`."
- https://supabase.com/docs/guides/observability/advanced-log-filtering :
  "The logs query surface rejects `select *` and `count(*)`; list columns and
  use `count()`." "Without `sql`, this endpoint queries API Gateway events
  only." "Inspect both the HTTP status and the response for query errors
  before interpreting the results."
- The hosted MCP server's `query_logs` input schema (captured in
  `docs/research/raw/2026-10-23-operate-with-confidence/mcp-tools-list-read-only.json`;
  this run's server reported 0.14.0):
  `iso_timestamp_start` "Defaults to 24 hours before the end of the window.
  The API caps the requested range at 24 hours."; `iso_timestamp_end`
  "Defaults to the current time."
- Row cap: no public page found states one for the endpoint or the tool (docs
  mirror searched for row limits; the only figure is the Logs UI download, "a
  result limit of 100, 500, or 1,000 rows", in
  https://supabase.com/docs/guides/observability/logs ).

Design: one Micro project per run (compute read back as `micro`), Pro-plan
org, ap-southeast-1. 1200 REST GETs carrying a run marker in the URL (so in
`edge_logs.event_message`), then every cell asked once per repetition, the
repetitions interleaved (all cells, then all again), one logs query about
every 5 s. Each reading records the HTTP status, the body's `error` field, the
row count or `n`, and its age: seconds between the end of the 1200-request
burst and the query (`rN_s_after_burst`). Windows end "now" unless stated.
Back-off on throttling: 20 s, recorded per reading (`throttle_retries`; 9 retries
over 3 readings in ob03d-run1, 15 over 5 in ob03d-run2; the module does not record whether each was a
429 or a throttler error body).

Runs: ob03d-run1 10:34-10:44 UTC (2 repetitions), ob03d-run2 10:45-11:02 UTC
(3 repetitions). Run1 ran an earlier revision of the module: no 24 h + 2 min
and + 10 min cells, no body-key or row-source columns, the fresh-marker probe
had only the no-window and 1 h queries, and its MCP parser cut at the
preamble's mention of the boundary tag, so its MCP rows show `rows` 0 with the
payload in the `error` column (the count cells read `{"result":[{"n":1200}]}`
there; the LIMIT 2000 row count is lost). Both runs: 1200 of 1200 requests
answered 200 (burst 4.9 s and 5.5 s) and the 1 h count returned 1200 marker
rows 33 s after the burst. Each run's project was deleted by the module
(DELETE answered 200; `GET /v1/projects/{ref}` answered 404 for both refs
after run2).

Measured, windows (`count()` of the 1200 marker rows; age in seconds -> n):

| window | ob03d-run1 | ob03d-run2 | HTTP / error |
|---|---|---|---|
| 1 h | 33 -> 1200, 281 -> 1200 | 33, 302, 633 -> 1200 | 200, none |
| 24 h | 38, 287 -> 1200 | 40, 307, 638 -> 1200 | 200, none |
| 24 h + 1 min | 44 -> 0, 292 -> 1200 | 45 -> 0, 312 -> 1200, 644 -> 1200 | 200, none |
| 24 h + 2 min | not in run1 | 49 -> 0, 318 -> 1200, 648 -> 1200 | 200, none |
| 24 h + 10 min | not in run1 | 56 -> 0, 323 -> 0, 655 -> 1200 | 200, none |
| 25 h | 49, 297 -> 0 | 61, 328, 661 -> 0 | 200, none |
| 48 h | 54, 302 -> 0 | 66, 333, 666 -> 0 | 200, none |
| 48 h from 1 h ago (end 47 h ahead) | 59, 307 -> 1200 | 70, 398, 731 -> 1200 | 200, none |
| 23.5 h from 30 min ago (end 23 h ahead) | 64, 312 -> 1200 | 75, 403, 737 -> 1200 | 200, none |
| start 1 h ago, no end | 70, 319 -> 0 | 81, 409, 742 -> 0 | 200, none |
| end now, no start | 76, 325 -> 0 | 86, 414, 748 -> 0 | 200, none |
| neither | 82, 390 -> no result | 91, 419, 753 -> no result | 200, `Backend error! Retry your query. Please contact support if this continues.` |

No over-long window produced an error, and in run2 every such body had the
single key `result`: no warning or truncation field. The 24 h + 1/2/10 min
rows each flip from 0 to 1200 once the markers are older than the overshoot,
and 25 h and 48 h ending now (overshoot 1 h and 24 h, markers at most 666 s
old) never returned them. Every reading fits a window kept as [start, start +
24 h]: an over-long range ending now silently drops its most recent part,
while the same 48 h range starting 1 h ago returned every marker. A cap that
keeps the last 24 h would have returned 1200 in every over-long row. Whether
the cap applies before or after the documented rounding to the nearest minute
was not separated (no overshoot under 1 min was asked).

Measured, fresh markers (5 marked REST GETs, query 20 s later, once per
repetition):

| query | ob03d-run1 | ob03d-run2 |
|---|---|---|
| neither bound | backend error, backend error | backend error x3 |
| end now, no start | not in run1 | 5, 5, 0 |
| start 30 s before the send, no end | not in run1 | 5, 0, 3 |
| 1 h window (control) | 5, 5 | 5, 5, 3 |

The third run2 repetition's control saw 3 of 5, so that column's zero and
three are partly ingestion lag. The no-window query never returned the
documented "last 1 minute" (10 of 10 readings across both tables are the
backend error, HTTP 200). End only saw 20 s old markers (2 of 3) and never 70
s or older ones (0 of 5), which fits a short window ending at `end`; start
only saw fresh markers in 2 of 3 readings and the old markers in 0 of 5. The
length of either one-bound window was not pinned (inference from two marker
ages).

Measured, SQL (1 h window; 5 readings each, 2 in run1 and 3 in run2):

| query | result | HTTP / error |
|---|---|---|
| `count()` | n 1200 | 200, none |
| `count(*)` | n 1200 | 200, none |
| `select * ... limit 1` | no `result` key | 200, `restricted wildcard (*) in a result column` |
| `from edge_logs` (per-source table) | no `result` key | 200, `Table "edge_logs" does not exist.` |
| rows, LIMIT 100 | 100 rows | 200, none |
| rows, LIMIT 1000 | 1000 rows | 200, none |
| rows, LIMIT 1001 / 2000 / none | 1000 rows each | 200, none |
| 1200 marker rows x 10 by `arrayJoin(range(10))`, LIMIT 5000 / 20000 / none | 1000 rows each | 200, none |
| no `sql` parameter | 100 rows | 200, none |
| `logs.all`, same window | - | 410, `The logs.all endpoint has been removed. Use GET /v1/projects/{ref}/analytics/endpoints/logs instead. See https://supabase.com/changelog/48235-migration-of-supabase-management-api-logs-all-analytics-endpoint-to-logs-endpoint` |

`count(*)` was accepted in all 5 readings, against the docs line. Errors
arrive as HTTP 200 with the body's only key `error` (run2), which the
documented response schema allows. The result is cut at 1000 rows whatever
the LIMIT, with no field saying so. Without `sql` the 100 rows came from
several sources, not only API Gateway: run2 readings `auth_logs, edge_logs,
pgbouncer_logs, realtime_logs`; `auth_logs, pgbouncer_logs, postgrest_logs`;
`edge_logs, pgbouncer_logs` (columns `event_message, id, log_attributes,
project, severity_text, source, timestamp`; run1 did not record sources).

Measured, hosted MCP server (`https://mcp.supabase.com/mcp?project_ref=<ref>&read_only=true`,
the PAT as Bearer, `serverInfo` version 0.14.0, protocol 2025-06-18, no client
capabilities; same SQL; HTTP 200 on every call):

| `query_logs` call | ob03d-run1 | ob03d-run2 | endpoint, same cell |
|---|---|---|---|
| `count()`, explicit 1 h | 1200, 1200 | 1200 x3 | 1200 |
| `count()`, no window | 1200, 1200 | 1200 x3 | backend error |
| `count()`, 48 h ending now | refused x2 | refused x3 | n 0, no error |
| `count(*)`, 1 h | 1200, 1200 | 1200 x3 | 1200 |
| `select *`, 1 h | error text x2 | error text x3 | same error text |
| rows, LIMIT 2000, 1 h | count lost (parser) | 1000 x3 | 1000 |

"Refused" is a tool result with `isError: true` and
`{"name":"Error","message":"The log window can be at most 24 hours."}`, not
wrapped. Every other result came back with `isError: false` inside the
`untrusted-data-<uuid>` boundary, including the `select *` error: an MCP
client receives that query failure as a successful tool result. So on the same
SQL the tool and the endpoint agree on counts, row cap, `count(*)` and the
`select *` error, and differ on the two window edges: the tool answers a no-window
call (all 1200 markers; its schema says 24 h) where the endpoint errors, and refuses a 48 h range where the endpoint
answers a silent 0.

Reading for a caller of the endpoint: pass both bounds; keep the range at or
under 24 h, because a longer one ending now drops its newest part without an
error; check `error` in every 200 body; treat 1000 rows as a cap and page by
time when a result has exactly 1000; read sources from the `source` column
rather than trusting the no-`sql` default.

Not measured: a project with rows older than 24 h (the over-long windows here
had an empty first part), rounding below one minute of overshoot, the
one-bound window lengths, other regions and plans, the Explorer UI, the MCP
server's stateless protocol shape (2026-07-28), `query_logs` with only one
bound, and whether the 1000-row cap is per query or per response size (the
rows were small: two columns).

## OB06 - track_planning for Data API traffic, lock waits on the metrics endpoint, restore to a new project (2026-10-28)

Question: an app reads its database through the Data API and wants planning
time in `pg_stat_statements`; its operators scrape the metrics endpoint and
want to see sessions stuck behind locks; and they want to know whether a
restore to a new project can be scripted.

Docs say (read 2026-10-28):

- https://www.postgresql.org/docs/17/sql-alterrole.html : a role setting
  becomes the session default "Whenever the role subsequently starts a new
  session ... This only happens at login time; executing `SET ROLE` or `SET
  SESSION AUTHORIZATION` does not cause new configuration values to be set."
- https://docs.postgrest.org/en/stable/references/transactions.html ,
  "Impersonated Role Settings": PostgREST applies the impersonated role's
  settings as transaction-scoped settings, but "Settings that have a context
  which requires privileges won't be applied by default", unless `GRANT SET ON
  PARAMETER <setting> TO <authenticator>` (Postgres 15 and later).
- v1 OpenAPI document (https://api.supabase.com/api/v1-json),
  `UpdatePostgresConfigBody`: `additionalProperties: false`, and
  `pg_stat_statements.track_planning` is not among its properties
  (`pg_stat_statements.max` is).
- https://supabase.com/docs/guides/observability/metrics and its self-hosted
  Prometheus page: Basic auth `service_role` plus a secret API key; "Keep the
  scrape interval at 60 seconds to match Supabase's refresh cadence."

Design: one Micro project per run, Pro-plan org, ap-southeast-1, Postgres
17.11. SQL as `postgres` over a session-mode pooler connection (the Management
API SQL endpoint also ran as `postgres`). OB06a tries each `ALTER` and resets
it. OB06c runs one arm per setting, alone: apply it, `NOTIFY pgrst, 'reload
config'`, terminate the `authenticator` backends, wait for the Data API to
answer, then as `anon`, `authenticated` (a password-grant user token) and
`service_role` call an RPC that returns `current_setting(...)` inside the
request and send 3 GETs to a table unique to that arm and role, then read that
table's statements from `pg_stat_statements`. OB06f holds a row lock (`select
... for update`, a second session's `update` waits) and then an `ACCESS
EXCLUSIVE` table lock (a second session's `select` waits), 130 s each, with a
30 s baseline, gap and tail, and scrapes the metrics endpoint and reads the
waiter's `pg_stat_activity` row every 10 s. Vantage: one macOS machine in
Singapore, Bun 1.3.14, `supabase` CLI 2.122.0.

Runs: ob06-run2 08:30-08:38 UTC, ob06-run3 08:38-08:45 UTC. Run2 ran an
earlier revision: no `GRANT SET ON PARAMETER` probe, and its snapshot count
fingerprinted `pg_` and `node_` series together. A run before them (not
published) used a postgres session through the pooler as the positive control
without first dropping the pooler's other backends, read `off`, and was
replaced by the control below. Each run's project was deleted by the module
(OB06z, HTTP 200) and `GET /v1/projects` listed no `ob-surface-` project at
08:45 UTC.

Measured, `pg_stat_statements.track_planning` (both runs agree on every
row):

- OB06a: as `postgres`, `alter role ... set pg_stat_statements.track_planning
  = on` was accepted for `authenticator`, `authenticated`, `anon`, `postgres`
  and `service_role`; `alter database postgres set ...` was refused with
  `permission denied to set parameter "pg_stat_statements.track_planning"`.
  The parameter's context is `superuser`, default `off`, no
  `pg_parameter_acl` entry. ob06-run3: `grant set on parameter
  pg_stat_statements.track_planning to authenticator` was refused with
  `permission denied for parameter pg_stat_statements.track_planning`.
- OB06b: with the role setting in place, a postgres session that ran `set
  role` to `authenticator`, `authenticated`, `anon` or `service_role` still
  showed `off`. Positive control: after `alter role postgres set ...`, the
  other postgres backends terminated (1) and a new login (backend 0.01 s
  old) showed `on`, source `user`.
- OB06c: only the `authenticator` arm put planning into the statistics. With
  it, the value inside the request was `on` for all three roles, and each
  PostgREST statement (`WITH pgrst_source AS ( SELECT ... )`) showed
  `calls=3 plans=3`; `total_plan_time` per 3 calls was 0.43, 0.32 and 0.31 ms
  (anon, authenticated, service_role) in ob06-run2, 0.49, 0.33 and 0.36 ms in
  ob06-run3. The baseline and the `authenticated`, `anon`, `service_role` and
  `postgres` arms read `off` inside every request and `plans` 0. Every RPC and
  GET answered 200 in every arm, so a role setting PostgREST skips does not
  break requests. The database arm did not run (its `ALTER` was refused).
  Two `authenticator` backends were terminated per arm. The per-table `calls`
  column (5) also counts the module's own `create table` and `insert`.
- OB06d: `PUT /v1/projects/{ref}/config/database/postgres` with the key
  answered HTTP 400 `Unrecognized key: "pg_stat_statements.track_planning"`;
  `supabase postgres-config update --config
  pg_stat_statements.track_planning=on --no-restart --experimental` exited 1,
  `unknown Postgres config parameter: pg_stat_statements.track_planning`. The
  config read back without the key both times, and `show` stayed `off`.

Inference: a Data API request runs on an `authenticator` login, so the
login-time setting on `authenticator` is the one that reaches it; the
per-role settings are skipped by PostgREST because the parameter needs
superuser and `authenticator` cannot be granted it. Setting it on
`authenticator` turns planning statistics on for every Data API role at once.

Measured, metrics endpoint:

- OB06e: Basic auth with the secret key and with the legacy `service_role`
  JWT both answered 200. One scrape held 307 families and 766 series, 49
  families named `pg_*`. 22 families match lock|wait|activity|conflict|
  blocked|deadlock: `pg_stat_activity_xact_runtime`,
  `pg_stat_database_conflicts_confl_{bufferpin,deadlock,lock,snapshot,tablespace}_total`,
  `pg_stat_database_conflicts_total`, `pg_stat_database_deadlocks_total` (each
  one series, labels `supabase_identifier`, `service_type=postgresql`,
  `server`), `pgbouncer_pools_client_{maxwait_seconds,waiting_cancel_connections,waiting_connections}`
  and `pgbouncer_stats_client_wait_seconds_total` (labels `database`, `user`),
  `pgrst_db_pool_waiting`, `db_sql_connection_wait_total` and
  `db_sql_connection_wait_duration_milliseconds_total` (Auth, `otelsql`),
  `node_procs_blocked`, `node_pressure_{cpu,io,memory}_waiting_seconds_total`,
  `node_memory_Mlocked_bytes` and two `node_time_clocksource_*_info` families.
  No series carries a `state` or wait-event label (0 and 0); 20 carry a `mode`
  label. There is no `pg_locks` family and no per-state
  `pg_stat_activity` count.
- OB06f: the waiter showed `Lock:transactionid:active` (row) and
  `Lock:relation:active` (table) in 24 of 36 scrapes. The only matching
  `pg_` series that moved with the waits was `pg_stat_activity_xact_runtime`,
  the age of the oldest open transaction: in ob06-run3 it read 30.083627 at
  60 s and 100.132932 at 130 s during the row wait, and 80.0403 at 270 s
  during the table wait, then 0 once both had ended. The pgbouncer, PostgREST
  pool and Auth wait gauges stayed 0 throughout; the conflict and deadlock
  counters did not change. The `node_pressure_*` counters rose at every
  snapshot, waits or not. ob06-run3: `pg_` values changed 5 times, 60 to 70 s
  apart (`node_` values the same); ob06-run2, with one fingerprint for both,
  saw 8 changes 10 to 70 s apart.

Answer: no. The endpoint exposes neither wait events nor lock waits; a
blocked session shows up only as an old transaction in
`pg_stat_activity_xact_runtime` (the holder's age; inference: a long
idle-in-transaction session would give the same reading), refreshed about
once a minute.

Measured, restore to a new project (OB06g, both runs): the v1 document has
115 paths and the v2 document 36; none mentions clone, and the create-project
body has no source, backup or restore field (`db_pass`, `name`,
`organization_id`, `organization_slug`, `plan`, `region`,
`region_selection`, `kps_enabled`, `desired_instance_size`, `template_url`,
`release_channel`, `postgres_engine`, `high_availability`). The restore paths
are in-place (`/v1/projects/{ref}/restore`, `database/backups/restore`,
`restore-pitr`, `restore-point`, `undo`) plus `POST
/v2/projects/{ref}/backups/download` (its body takes a backup id and the type
`project_backup_file_url`). Branch creation takes `with_data`. `GET
/v1/projects/{ref}/clone` answered 404 and the Dashboard's clone route
answered a PAT with 401 `Unsupported access token`, as RP01d found on
2026-10-10. No clone was created.

Not measured: the database-level arm (refused); a pooled (Supavisor) or
custom-schema Data API path; PostgREST's version (not recorded); whether
`branches` `with_data` or the backup-download route give a usable copy; the
metrics endpoint on other compute sizes or with many waiters; Realtime or
Storage connections waiting on locks.

## OB05 - notebooks pull/push

Docs say (CLI `--help`, 2.120.0, and the v2 OpenAPI document): `pull` writes
project notebooks to `supabase/notebooks`, keeping existing files unless an id
is given; `push` writes local files and asks about project notebooks the
directory lacks; an update replaces the body, a cell echoing its `id` keeps its
identity, a cell without one is added.

Measured (run2, n = 1 project, one pass): a notebook created through
`POST /v2/projects/{ref}/notebooks` with markdown, database and log cells came
back with server-assigned ids on all 3 cells (OB05a). `pull` wrote one file,
`ob05-alpha.json` (file name = notebook name), with top-level keys
`description`, `favorite`, `content` (no `id`, no `name`), cells equal to the
API's (OB05b). After editing one `sql` and appending a cell without an id,
`push` reported "0 created, 1 updated"; the API then held 4 cells, the edited
sql, the 3 original ids and an id on the new cell, and `updated_by` set (OB05c).
A second `pull` on the unchanged tree wrote nothing ("Kept 1 existing local
notebook(s) unchanged"); `pull <id>` over a locally modified file restored the
project's version (OB05d). A new local file was created on the project by `push`
("1 created, 1 updated") (OB05e). With the local file for a project notebook
removed, `push --yes` with a closed stdin updated the remaining notebook,
reported "1 project notebook(s) are not in <dir>: ob05-alpha - Left alone -
rerun interactively to resolve", and the notebook stayed on the project
(OB05f). The CLI exit code was 0 in every call.

Not measured: the interactive prompt of OB05f (the choices it offers), notebooks
with a read-replica `database_identifier`, running a notebook (no run endpoint
is in the v2 OpenAPI document), concurrent edits from the Dashboard.

## OB04 - generic HTTP log drain to a Worker

Docs say (https://supabase.com/blog/log-drains-now-available-on-pro,
https://supabase.com/docs/guides/observability/log-drains): drains are on Pro,
Team and Enterprise; an HTTP drain posts a JSON array, batches of at most 250
events or one second, optional gzip, HTTP/1 or HTTP/2.

Measured (run1, n = 1 Pro-plan project, one pass):

- OB04a: `GET /v1/organizations/{slug}/entitlements` on the Pro org: `log_drains`
  `hasAccess` true; `audit_log_drains` false.
- OB04b: the sink (a Worker with a SQLite-backed Durable Object, deployed over
  the Cloudflare REST API, deleted afterwards) stored a plain POST and a gzip
  POST with the lab key (stored `Content-Encoding` `gzip`, body decoded by the
  Worker to `[{"probe":"gzip"}]`, the Worker saw `HTTP/1.1`) and answered 401 to
  a POST without the key.
- OB04c: `POST /v2/projects/{ref}/analytics/log-drains` (webhook type) and
  `GET` on the same path answered 403 `forbidden`, "Your organization does not
  have access to this API", on the Pro org's project, with the entitlement above
  true. The same 403 came from a separate exploratory check against a project
  on a Team-plan organization (POST and GET, not archived; that project was
  deleted at once). In that same exploratory check (also not archived) the v2
  notebooks path answered 200 on both projects, which would put the PAT and v2
  prefix outside the cause, and the Dashboard's internal route
  (`/platform/projects/{ref}/analytics/log-drains`) answered 401 `Unsupported
  access token` to the PAT. Only the Pro-org 403s were kept, in the run1 OB04
  artifact (`out/2026-10-10/run-2026-10-10T00-39-42-004Z.json`). No drain was created, so OB04d (batch size, flush
  spacing, content-encoding as sent by the platform, HTTP version, event fields,
  arrival lag, sources that arrive) was not run: its code has never executed
  against a live drain.

Reading: on the Pro org the v2 log-drain route refused despite the plan
entitlement reading true (the Team org's entitlement was not read). On a
Pro-plan org's project, `GET` and `POST
/v2/projects/{ref}/analytics/log-drains` answered 403 `forbidden` ("Your
organization does not have access to this API") while the org's `log_drains`
entitlement read `hasAccess: true`; the same 403 came from the unarchived
exploratory check on a Team-plan org. The v1 API publishes no log-drains route
(the public v1 OpenAPI at https://api.supabase.com/api/v1-json lists none; v2
lists `/v2/projects/{ref}/analytics/log-drains` and `/{id}`). What grants access
was not determined. Missing prerequisite for OB04d: an org the v2 route
accepts, or a drain created in the Dashboard pointed at the sink.

Not measured: everything under OB04d; drain cost per drain-hour (none was
incurred: no drain existed); Audit Log Drains (entitlement only).
