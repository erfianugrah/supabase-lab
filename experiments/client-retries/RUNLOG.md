# client-retries RUNLOG

Question: what does the supabase-js PostgREST retry policy do on the wire, and do
two client policies that the built-in retries do not provide hold up (a deadline
plus one hedged GET; refresh-then-retry on a 401)?

Vantage for every run: one Mac on a residential connection (Singapore), Bun
1.3.14 as the client runtime unless a row says Node (v26.11.1), supabase-js
2.112.3 unless a row names another version (versions read from `bun --version`,
`node --version` and the installed package.json on 2026-10-10). Throwaway
projects: created in a Pro-plan org (the module's choice), ap-southeast-1, with
`desired_instance_size` Micro requested; the plan and the compute size were not read
back, one per run, deleted by the module's `finally` (delete HTTP 200 in CR01-teardown and CR02-teardown). Faults
come from a local proxy (`lib/faultproxy.ts`) between the client and the
project's REST URL, so a synthetic status never reached the platform; the proxy
logs what the client sent (including `X-Retry-Count`), which is where every
attempt count below comes from. Every case is n=1 unless stated.

## What the public docs claim (read 2026-10-10, not a measurement)

Sources: the changelog, https://supabase.com/changelog/45071-automatic-postgrest-retries-for-transient-errors,
and the docs page, https://supabase.com/docs/guides/api/automatic-retries-in-supabase-js.
The two differ, so each claim is attributed.

- Changelog: GET and HEAD that meet HTTP 520, HTTP 503 or a network failure are
  retried up to 3 times with backoff 1 s, 2 s, 4 s, capped at 30 s. The docs page,
  as read, lists GET, HEAD and OPTIONS; OPTIONS was not tested here. The 1, 2, 4 s
  schedule and the 30 s cap are from the changelog; they were not visible in the
  docs-page text.
- POST, PATCH, PUT and DELETE are never retried.
- Each attempt carries `X-Retry-Count`.
- Since supabase-js 2.102.0.
- Opt-out: the changelog names `retryEnabled: false` for JavaScript; the docs page
  names `db: { retry: false }`.
- The docs page shows `.abortSignal(AbortSignal.timeout(10_000))` as the way to
  cap a request. It does not state a default timeout.

## Runs

| stamp | modules | note |
|---|---|---|
| 20261010-122625 | CR01 | first run; 29 pass. The edge_logs probe queried a column that does not exist (`source_name`; the column is `source`) and returned "Backend error!" for 506 s. Superseded |
| 20261010-122937 | CR03, CR04 | first run, 5 versions, CR04 at 330 s. Superseded |
| 20261010-124221 | CR02, CR03 | CR03 with 14 versions; first CR02 run (10 pass). Superseded by the two below |
| 20261010-124245 | CR01 | second CR01 run (31 pass); first with the `AbortSignal` variants (CR01d5a-c, CR01d7) and a working edge_logs query |
| 20261010-125554 | CR01, CR02 | the run quoted below for both. Its CR03 and CR04 results are not measurements: 16 failures, all from the environment (npm registry `ConnectionRefused` for 14 installs; the two CR04 probes printed nothing). They were re-run |
| 20261010-130930 | CR03 | spot check of one version (2.112.3, Bun and Node) before the full re-run; agrees with the 130944 row for that version |
| 20261010-130944 | CR03, CR04 | the run quoted below for both |

Raw run output is under `evidence/`, which is gitignored and not committed.
Redacted copies of 20261010-125554 (CR01, CR02 only) and 20261010-130944 are
published as `out/2026-10-10/run-2026-10-10T04-55-54-303Z.{json,facts.md}` and
`out/2026-10-10/run-2026-10-10T05-09-44-295Z.{json,facts.md}`. The superseded
and spot-check runs in the table above are unpublished.

## 2026-10-10 - CR01: the retry matrix (run 20261010-125554)

Column "attempts" is the number of distinct `X-Retry-Count` values the proxy saw
(no header counts as 0); "wire" is the number of requests that reached the proxy.
Gaps are between arrivals at the proxy, rounded to 100 ms by the module.

### GET

| case | measured | docs claim |
|---|---|---|
| CR01a1: 503 once, then pass | 2 attempts, header sequence `-,1`, gap 1000 ms, 200 after 1081 ms | consistent |
| CR01a2: 503 on every attempt | 4 attempts, `-,1,2,3`, gaps 1000, 2000, 4000 ms, 7008 ms; supabase-js returned `{error}` with status 503 and code PGRST002 | consistent |
| CR01a3: 520 on every attempt | same shape, 7012 ms, status 520 | consistent |
| CR01a4: 525, 502, 504, 500, 429, 408, 521, 522, 524 (each on its own, always) | 1 attempt for each of the nine | the docs list only 520 and 503, so this is consistent; the suspicion that 525 is retried is not borne out |
| CR01a5: TCP reset on every attempt | 4 client attempts, but 5 requests on the wire (`-,-,1,2,3`): the first request was sent twice with no header change, 7016 ms, status 0 | docs: network failures retried; the extra wire request was seen on the shared proxy and is absent in CR03's fresh-server cases (4 wire); cause not isolated |

### Retry-After (the docs do not mention it; the source comment says a 503 "signals retry via Retry-After")

| case | measured |
|---|---|
| CR01a6a: 503 with `Retry-After: 2`, then pass | gap 2000 ms (not 1000 ms), 200 after 2049 ms |
| CR01a6b: `Retry-After: 0` | gap 0 ms, 200 after 64 ms |
| CR01a6c: `Retry-After` as an HTTP date 5 s ahead | gap 0 ms, 200 after 50 ms (the date was ignored) |
| CR01a6d: `Retry-After: 40` | gap 40000 ms, 200 after 40119 ms (above the 30 s backoff cap) |

### Methods other than GET

| case | measured | docs claim |
|---|---|---|
| CR01b1: POST insert answered 503, 520, or reset | 1 attempt each (1 wire request each) | consistent |
| CR01b2: PATCH, DELETE, upsert (a POST) answered 503 | 1 attempt each | consistent |
| CR01b3: `rpc()` default (POST) answered 503 | 1 attempt | consistent |
| CR01b3: `rpc()` with `get: true` answered 503 | 4 attempts, 7011 ms | GET is retried: consistent |
| CR01b3: `select(..., {head: true, count: 'exact'})` answered 503 | 4 attempts, 7012 ms | HEAD is retried: consistent |

### Opt-outs, supabase-js 2.112.3

| case | attempts |
|---|---|
| CR01c1: `.retry(false)` on the query | 1 |
| CR01c2: `createClient(..., { db: { retry: false } })` | 1 |
| CR01c3: `createClient(..., { db: { retryEnabled: false } })`, the name in the changelog | 4 (the option has no effect) |
| CR01c4: `db.retry = false` and `.retry(true)` on the query | 4 (the per-query call wins) |

### Timeouts

| case | measured |
|---|---|
| CR01d1, CR01d2: no timeout configured, response held 3 s and 10 s before forwarding | 1 attempt each, 200 after 3088 ms and 10108 ms |
| CR01d3: `db.timeout = 2000`, response held 3 s | 1 attempt, aborted at 2004 ms, status 0 (an abort is not retried) |
| CR01d4: `db.timeout = 2000`, 503 on every attempt | 4 attempts, 7010 ms: the timeout applies to each attempt, not to the call |
| CR01d6: `db.timeout = 2000`, first attempt 503, the retry hangs | 2 attempts, ended at 3009 ms (1000 ms backoff + 2000 ms timeout), status 0 |
| CR01d5a: `.abortSignal(AbortSignal.timeout(5000))` created inline, 503 on every attempt | 4 attempts, 7011 ms, final status 503: the 5000 ms deadline did not end the call during the 3 s to 7 s backoff |
| CR01d5b: `AbortController` and `setTimeout(abort, 5000)`, same faults | 3 attempts, ended at 5005 ms, status 0 |
| CR01d5c: `AbortSignal.timeout(5000)` with an `abort` listener attached at creation | 3 attempts, ended at 5003 ms, status 0 |
| CR01d7: inline `AbortSignal.timeout(3000)`, first attempt 503, the retry hangs | still pending when the module stopped observing at 9004 ms (2 requests on the wire); the 3000 ms deadline never fired |

CR01d5a, CR01d5b and CR01d5c differ only in how the signal is built. The same
inline-signal result is in CR03 (Bun, every version from 2.102.0 to 2.117.3
tested) and is absent on Node (below). The cause is not isolated here: the
pattern is "an `AbortSignal.timeout` signal with no listener on it while the
client sleeps between attempts never aborts, under Bun 1.3.14". A plain `fetch`
with an inline `AbortSignal.timeout(2000)` against a held request did abort at
2002 ms (scratch check, not a module; Bun and Node, 2026-10-10).

### The real Data-API-off 503 (CR01e)

The module switched the Data API off with `PATCH /v1/projects/{ref}/postgrest`
and `db_schema: ""`, waited until a direct GET returned 503, then ran the client
through the proxy in pass-through mode, then restored the schema list (a direct
GET was 200 again after 1 s, `restore_s` 1).

- CR01e1, GET with the default client: 4 attempts, `-,1,2,3`, gaps 1700, 1800,
  2000 ms, 7252 ms total, final 503 PGRST002. Every one of the four platform
  answers carried `Retry-After: 0`. The proxy measured each answer at 1665,
  1752, 1948 and 1880 ms, so the gaps are the previous answer's duration plus
  about 40 ms: the client waited roughly nothing between attempts, not the 1, 2,
  4 s of the synthetic 503s in CR01a2. Earlier runs, same case: gaps 1400, 1100,
  1400 ms (5376 ms total, run 20261010-122625) and 1700, 1700, 1800 ms (6401 ms,
  run 20261010-124245).
- CR01e2, POST insert: 1 attempt, 503 PGRST002, 951 ms.
- CR01e3, GET with `.retry(false)`: 1 attempt, 964 ms.

### What the gateway logs show (CR01f)

Query: the unified `logs` table, `source = 'edge_logs'`, rows whose
`request.search` contains the real-503 markers, polled for 22 s. 5 rows: 4 for the
default-client GET (response status 503 on all four) and 1 for the `.retry(false)`
GET. No row mentions "retry" anywhere in its attributes. The request-header
attributes present were `accept`, `cf_connecting_ip`, `cf_ray`, `user_agent`,
`x_client_info`. So `X-Retry-Count` is not visible in edge_logs for these five
rows; the number of attempts is visible only as the number of rows. Whether other
headers are kept under some other condition was not tested.

## 2026-10-10 - CR02: client policy (run 20261010-125554)

Policies in `lib/policy.ts`. `hedgedGet`: each attempt has built-in retries off
(`.retry(false)`), one overall deadline from `AbortSignal.timeout` with an abort
listener attached, and at most one extra attempt started when the first fails
with status 0 or 5xx or when it has been outstanding for `hedgeAfterMs` (1500 ms
here). `refreshThenRetry`: on a 401, one `auth.refreshSession()` and one repeat of
the request.

### Deadline and hedged GET

| case | measured |
|---|---|
| CR02a: default client, first request held 10 s | 1 request, 200 after 10054 ms |
| CR02b: policy (deadline 5000 ms), first request held 10 s before forwarding | the second attempt won: 200 after 1575 ms, 2 requests, the first one aborted by the client (proxy saw its connection close) |
| CR02c: policy, 525 once then pass | 200 after 51 ms, 2 requests |
| CR02d: policy, 525 on every attempt | status 525 returned after 1 ms, 2 requests (the built-in policy sends 1: CR01a4) |
| CR02e: policy (deadline 4000 ms), requests never answered | status 0 after 4003 ms, 2 requests, both aborted |
| CR02f1: policy, built-in retries off, 503 on every attempt, deadline 6000 ms | 2 requests, 503 returned after 4 ms |
| CR02f2: same with the built-in retries left on | 6 requests, ended by the deadline at 6001 ms, status 0 |

The policy retries immediately; CR02c, CR02d and CR02f1 show no pause between
the two requests, and the module did not test a pause or jitter.

### Why the hedge is GET-only (CR02g)

The server was made slow, not the network: the proxy forwarded the first write at
once and held its answer 4 s; the policy hedged at 1500 ms.

- CR02g1, a hedged `insert` into a table with no unique key: 2 rows written for the
  one logical write.
- CR02g2, a hedged `upsert` on a primary key: 1 row.

### Refresh then retry (CR02h)

| case | measured |
|---|---|
| CR02h1: one injected 401 PGRST303 on a signed-in user's GET | without the policy: status 401 after 1 request. With it: 2 REST requests, 1 refresh call, the retry carried a different `Authorization` value (fingerprint differs), 200, 136 ms |
| CR02h2: 401 on every REST request | the policy stopped after 1 refresh and 1 retry: final 401, 2 REST requests |
| CR02h3: session revoked with `POST /auth/v1/logout?scope=global` (204), then one injected 401 | the refresh failed (`refresh_token_not_found`, upstream status 400); the original 401 was returned; 1 REST request |
| CR02h4: a real 401: the stored access token had a corrupted signature, the refresh token was valid | without the policy: 401 PGRST301. With it: refresh, 2 REST requests, 200 |
| CR02h5: five parallel requests, each answered 401 once | 5 of 5 recovered; 1 refresh call reached the Auth server; 10 REST requests |

The 401 in h1, h2 and h3 is injected by the proxy; only h4 is a platform 401. The
incident class "fresh JWT rejected" was not reproduced.

## 2026-10-10 - CR03: per version and runtime (run 20261010-130944)

Local mock, one fresh server per case, `lib/version-probe.ts` copied next to each
installed version and run under Bun 1.3.14 and under Node v26.11.1. Every cell is
an attempt count from `X-Retry-Count`, n=1.

| supabase-js | GET 503 | GET 525 | POST 503 | `.retry(false)` | `db.retry=false` | `db.retryEnabled=false` | inline `AbortSignal.timeout(2500)`, 503 on every attempt (Bun / Node) |
|---|---|---|---|---|---|---|---|
| 2.101.1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 / 1 |
| 2.102.0 to 2.111.0 (2.102.0, 2.103.3, 2.104.0, 2.105.0, 2.106.0, 2.107.0, 2.108.0, 2.109.0, 2.110.0, 2.111.0) | 4 | 1 | 1 | 1 | 4 | 4 | 4 / 2 |
| 2.112.0, 2.112.3, 2.117.3 | 4 | 1 | 1 | 1 | 1 | 4 | 4 / 2 |

- Retries begin at 2.102.0, matching the changelog; 2.101.1 sent one request.
- `db.retry` is honoured from 2.112.0; 2.111.0 and earlier ignore it, so on
  2.102.0 to 2.111.0 only `.retry(false)` on the query opts out.
- `db.retryEnabled` had no effect in any of the 14 versions.
- A GET reset gave 4 attempts and 4 wire requests in every version from 2.102.0
  (fresh mock server per case, so no reused connection); a POST reset gave 1.
- Inline `AbortSignal.timeout(2500)`: Bun ran all 4 attempts (about 7 s) in every
  version from 2.102.0; Node ended after 2 attempts at about 2.5 s. An
  `AbortController` with `setTimeout` ended at 2.5 s in both runtimes in every
  version.

## 2026-10-10 - CR04: a request that is never answered (run 20261010-130944)

A mock server accepted the request and never replied. Default supabase-js
2.112.3 client (no `db.timeout`, no signal), one process per runtime.

- Bun 1.3.14: still pending when observation stopped at 330004 ms.
- Node v26.11.1: still pending at 330016 ms.
- The mock accepted 4 requests across the two probes and closed none of the
  sockets during the run; why it is 4 and not 2 was not investigated.

Not measured: the default for runtimes other than these two (browsers, Deno,
React Native), a longer hold than 330 s, and any Node documentation figure for a
headers timeout (recalled, not read this session).

## Reading

What the runs support:

- On supabase-js 2.112.3 the built-in policy matches the changelog's description for
  503, 520, GET, HEAD, `rpc({get: true})`, POST, PATCH, DELETE and the 1, 2, 4 s
  spacing. A 503 with a `Retry-After` header changes the spacing, and the real
  Data-API-off 503 carries `Retry-After: 0`, which made the four real attempts
  back to back.
- 525 and the other 5xx codes tested are answered once; they surface to the caller
  on the first response.
- A default client has no timeout: 10 s completes, and a never-answered request was
  still pending at 330 s on Bun and Node. `db.timeout` applies per attempt.
- The changelog's JavaScript opt-out name (`retryEnabled`) does nothing in any
  tested version. `db.retry` works from 2.112.0, `.retry(false)` from 2.102.0.
- Under Bun 1.3.14 the docs' own pattern, an inline `AbortSignal.timeout`, can fail
  to end a call that is sleeping between retries (CR01d5a, CR01d7, CR03). An
  `AbortController`, or a timeout signal with a listener, ended it.
- Both client policies behaved as intended on the cases above, with the limits in the
  next section.

Not supported or not run:

- A real 525 was never produced; every 525 above is injected.
- The 3 s and 10 s delays are injected before or after forwarding on a loopback
  proxy; they model slow responses, not a slow network path.
- Hedging and retry load on the Data API connection pool (the docs warn that many
  retries can exhaust it) was not measured; the policy tests used one client.
- The hedged policy was run under Bun only; the policy functions use
  `AbortSignal` and `fetch`, and a Node run was not done.
- No pause or jitter before the policy's extra attempt was tested.
- The Bun inline-signal behaviour is a measured pattern on 1.3.14; a Bun fix or
  another Bun version was not checked, and no root cause is claimed.
- The five-parallel 401 case is one trial; one refresh call reached Auth, and the
  run cannot say whether that is deduplication in the client or luck of timing.

Cost: five throwaway projects, one per live run that has a teardown result in the
evidence (CR01 in runs 122625, 124245 and 125554; CR02 in runs 124221 and 125554),
each alive for minutes. Any further ad-hoc project used while debugging the
edge_logs query has no evidence file and is not counted here.
