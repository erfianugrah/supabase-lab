# RUNLOG - observability-surface

All runs 2026-10-10. Vantage: one macOS machine in Singapore (Bun 1.3.14; Node v26.11.1
for the esbuild bundles; `supabase` CLI 2.120.0), projects in
ap-southeast-1 on a Pro-plan organization, Management API from the same
machine. Run artifacts are `evidence/run1/` to `evidence/run3/` (gitignored:
they carry project refs); they were not published to `out/`, so the figures
below are quoted from those artifacts and are not yet citable by artifact.
Every project this experiment created was deleted by the module that made it
(checked with `GET /v1/projects` after the last run: none named `ob-surface-`
remained).

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
  access token` to the PAT. Only the Pro-org 403s were kept, in a run artifact
  that is not in the repo (gitignored `evidence/`). No drain was created, so OB04d (batch size, flush
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
