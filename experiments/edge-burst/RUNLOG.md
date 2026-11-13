# edge-burst - RUNLOG

The Edge Functions error-codes page (read 2026-11-04) gives one cause for
`RATE_LIMIT_EXCEEDED`: "The platform detected recursive or nested function
call behavior". Does a sustained, non-recursive burst against ONE function
draw it, and at what request rate? Org and project identifiers are not
recorded; the org plan is (Team, EB01a `org_plan`; why not Pro is in the
2026-11-04 section). Each process provisions its own throwaway
Micro through `POST /v1/projects` in ap-northeast-1 and EB99 deletes it.

Why a new experiment and not edge-function-limits EF15: that experiment
runs against one OpenTofu-managed project whose region is fixed in its
`experiment.tfvars`; this question needs a project in ap-northeast-1 created
and deleted inside the run, the self-provisioning shape of cron-behaviour
and pooler-checkout.

## Modules

| id   | mode        | question |
| ---- | ----------- | -------- |
| EB01 | destructive | Setup and control: Micro in ap-northeast-1, `eb-noop` and `eb-rpc` deployed through `POST /functions/deploy` (verify_jwt false), 20 sequential invocations each with `x-region: ap-northeast-1`; `x-sb-edge-region`, cf-ray colo, header names. |
| EB02 | destructive | `eb-noop` (no I/O, small JSON): open loop at 25, 50, 100, 200, 400, 800 req/s for 120 s each, 20 s apart, then one burst of 1,000 requests through at most 450 sockets (`PVLAB_EB_BURST_LANES`; 150 in run 2). |
| EB03 | destructive | `eb-rpc` (one supabase-js 2.118.0 `rpc("eb_ping")` per request, a `select 1` SQL function): the same steps. |
| EB99 | destructive | Delete the project, confirm it left `GET /projects`. |

## Method

- Vantage: this lab's Mac in Singapore, IPv4 only, Bun 1.3.14 `fetch`,
  keep-alive HTTP/1.1 (Bun's fetch got `http=http/1.1` from
  `https://www.cloudflare.com/cdn-cgi/trace`, 2026-11-04; the project host
  was not checked). Every request: `GET
  /functions/v1/<slug>` with `x-region: ap-northeast-1`, the legacy anon key
  as `apikey` and bearer. Neither function calls another function.
- Open loop (`lib/load.ts`): request i leaves at i / rate seconds whether
  or not earlier ones answered (5 ms ticks). A request due while 450 are in
  flight is counted `skipped_at_cap`, not queued. A step is flagged
  `client_limited` when any request was skipped, the achieved send rate was
  under 95 % of the plan, the p99 send lag passed 250 ms, the host paused,
  or (since run 2, below) any request got no HTTP answer; the flag marks a
  step as not a clean platform measurement and does not say which side
  caused it. Bun's fetch queues above 256 requests in flight by default (bun
  docs, "Simultaneous connection limit"); the Makefile sets
  `BUN_CONFIG_MAX_HTTP_REQUESTS=512` so the generator's cap binds first.
- Classes: the body's `code` with the status (`429_RATE_LIMIT_EXCEEDED`,
  `503_BOOT_ERROR`, `546_WORKER_RESOURCE_LIMIT`), `html_<status>` for a
  Cloudflare page, `<status>_empty` / `<status>_other`, and `client_*` for no
  HTTP answer (`client_unreachable` = `os error 51`). `eb-rpc` answers 200
  whatever the rpc returned and reports the rpc status in its body
  (`rpc_histogram`), so a non-200 HTTP status is the platform's.
- Stop rule: a step with more than 20 % non-200 ends the ramp; the burst
  still runs. No open-loop step of either run reached it; the rule does not
  apply to the bursts (run 1: 48.3 % and 51.4 % non-200).

## 2026-11-04 - EB01-EB03 (run 1) and EB01, EB02 at higher rates (run 2)

Harness: lab commit 9c57eea plus the uncommitted experiment. Org: the lab's
Team-plan org, passed through `PVLAB_ORG_PRO` (EB01a `org_plan` team), as
data-api-capacity DC22 did on 2026-11-03/04. The Pro org was not usable: a
smoke run on it earlier the same day (per function: one 10 s step at 5
req/s, after which the stop rule ended the ramp, then a 50-request burst;
not published, its project deleted by EB99) got HTTP 402 on every
invocation with a body naming a usage-quota restriction on that org, so
nothing about Edge Functions was measured there. One Micro per run in
ap-northeast-1, PostgreSQL 17.11, ready 20 s after the create call in both
runs (EB01a; the figure includes the SQL function and both deploys read
back), each deleted by its own EB99 (DELETE 200). `make sweep`
(lib/sweep.ts, output not published) listed 0 projects with the
`ef-burst-` prefix at 09:51:33 UTC.

- Run 1: `out/2026-11-04/run-2026-11-04T09-13-32-016Z.json` (18 results),
  09:13:32 to 09:43:59 UTC. Default knobs: 25, 50, 100, 200, 400, 800
  req/s for 120 s each, bursts of 1,000 through 450 lanes. EB02 then EB03.
- Run 2: `out/2026-11-04/run-2026-11-04T09-44-40-271Z.json` (8 results),
  09:44:40 to 09:49:53 UTC. EB01, EB02, EB99 only, with
  `PVLAB_EB_RATES=1200,1600,2400`, `PVLAB_EB_STEP_S=60` and
  `PVLAB_EB_BURST_LANES=150` (a knob added after run 1, below). Changed
  between the runs: the burst lane knob, and `client_limited` now also
  counts requests with no HTTP answer.

Controls (EB01b/c, 20 sequential invocations each): run 1 `eb-noop` 20 of
20 HTTP 200, p50 119 ms, p95 145 ms; `eb-rpc` 20 of 20 with rpc 200:20,
p50 138 ms, p95 1853 ms (with 20 samples, p95 is the slowest call). Run 2:
`eb-noop` p50 130 ms, p95 220 ms; `eb-rpc` p50 144 ms, p95 347 ms. Every
control answer carried `x-sb-edge-region: ap-northeast-1` (`edge_region`
ap-northeast-1:20); the one header-probe request per function had a cf-ray
ending in `SIN` and `server: cloudflare`. The header names on a 200 (EB01b
evidence): alt-svc, cf-cache-status, cf-ray, connection, content-encoding,
content-length, content-type, date, endpoint-load-metrics,
sb-gateway-version, sb-jwt-alg, sb-jwt-iss, sb-project-ref, sb-request-id,
server, set-cookie, strict-transport-security, vary,
x-content-type-options, x-deno-execution-id,
x-envoy-upstream-service-time, x-sb-edge-region, x-served-by. Values other
than the region, colo, server and gateway version were not recorded.

### Does a non-recursive single-function burst draw RATE_LIMIT_EXCEEDED?

Not in these runs: 0 `429 RATE_LIMIT_EXCEEDED` in every row below, and no
429 of any kind. Classes: `client_other` is a client-side error with no
HTTP answer that matched no other pattern; the artifact keeps the first
error text per class and row, and in every row with `client_other` that
text was Bun's `Unable to connect. Is the computer able to access the
url?`. `503_empty` is a 503 with an empty body.

Run 1, `eb-noop` (EB02) and `eb-rpc` (EB03), 120 s per step:

| row | asked req/s | sent | achieved send req/s | max in flight | `client_limited` | 429 RLE | classes | p50 / p95 / p99 ms |
|---|---|---|---|---|---|---|---|---|
| EB02-r025 | 25 | 3000 | 25 | 22 of 450 | no | 0 | ok:3000 | 108 / 138 / 484 |
| EB02-r050 | 50 | 6000 | 50 | 17 of 450 | no | 0 | ok:6000 | 109 / 132 / 207 |
| EB02-r100 | 100 | 12000 | 100 | 43 of 450 | no | 0 | ok:12000 | 110 / 136 / 278 |
| EB02-r200 | 200 | 24000 | 200 | 52 of 450 | no | 0 | ok:24000 | 109 / 130 / 200 |
| EB02-r400 | 400 | 48000 | 400 | 123 of 450 | no | 0 | ok:48000 | 111 / 138 / 236 |
| EB02-r800 | 800 | 96000 | 800 | 200 of 450 | no | 0 | ok:96000 | 115 / 137 / 190 |
| EB02-burst | burst | 1000 | 2079.1 | 450 of 450 | recorded no; 483 got no HTTP answer | 0 | ok:517, client_other:456, client_socket:22, client_timeout:5 | 368 / 550 / 558 (517 answered) |
| EB03-r025 | 25 | 3000 | 25 | 35 of 450 | no | 0 | ok:3000 | 129 / 179 / 711 |
| EB03-r050 | 50 | 6000 | 50 | 21 of 450 | no | 0 | ok:6000 | 133 / 176 / 274 |
| EB03-r100 | 100 | 12000 | 100 | 40 of 450 | no | 0 | ok:12000 | 133 / 180 / 270 |
| EB03-r200 | 200 | 24000 | 200 | 77 of 450 | no | 0 | ok:23996, 503_empty:4 | 132 / 170 / 273 |
| EB03-r400 | 400 | 47972 | 399.8 | 450 of 450 | yes (28 skipped at the in-flight cap) | 0 | ok:47971, 503_empty:1 | 135 / 191 / 594 |
| EB03-r800 | 800 | 95282 | 794 | 450 of 450 | yes (718 skipped at the in-flight cap) | 0 | ok:95258, client_other:24 | 139 / 195 / 372 |
| EB03-burst | burst | 1000 | 1581.7 | 450 of 450 | recorded no; 514 got no HTTP answer | 0 | client_other:514, ok:486 | 622 / 822 / 858 (486 answered) |

Run 2, `eb-noop` (EB02), 60 s per step:

| row | asked req/s | sent | achieved send req/s | max in flight | `client_limited` | 429 RLE | classes | p50 / p95 / p99 ms |
|---|---|---|---|---|---|---|---|---|
| EB02-r1200 | 1200 | 72000 | 1199.9 | 318 of 450 | no | 0 | ok:71982, 503_empty:18 | 120 / 146 / 230 |
| EB02-r1600 | 1600 | 96000 | 1599.9 | 434 of 450 | yes (24 without an HTTP answer) | 0 | ok:95976, client_other:24 | 120 / 144 / 206 |
| EB02-r2400 | 2400 | 143672 | 2394.4 | 450 of 450 | yes (328 skipped at the in-flight cap; 188 without an HTTP answer) | 0 | ok:143484, client_other:188 | 123 / 148 / 206 |
| EB02-burst | burst | 1000 | 1237.6 | 150 of 150 | no | 0 | ok:1000 | 120 / 205 / 220 |

- The highest step the client delivered without a flag was 1,200 req/s
  for 60 s against one function (run 2 EB02-r1200): 71,982 of 72,000
  answered 200. At 1,600 and 2,400 req/s the client called fetch() at
  1599.9 and 2394.4 req/s; of 96,000 and 143,672 sent, 95,976 and 143,484
  got HTTP 200 and the other 24 and 188 got no HTTP answer, so none was a
  429. Both steps are flagged `client_limited`. In run 1 the client kept
  every `eb-noop` step up to 800 req/s without a flag.
- The `eb-rpc` function reported rpc 200 on every HTTP 200 it returned
  (`rpc_histogram`, for example 200:95258 at EB03-r800).
- The run-1 bursts are dominated by connection failures: with 450 lanes
  opened at once, 483 (EB02) and 514 (EB03) of 1,000 requests got no HTTP
  answer (EB02: `client_other` 456, first text `Unable to connect`,
  `client_socket` 22, `client_timeout` 5; EB03: `client_other` 514,
  `Unable to connect`), all sent in the first 10 s bucket (each burst's
  sends spanned 0.5 s and 0.6 s); the 517 and 486 answers were all 200.
  Whether this Mac or the far end failed those connections was not
  separated; no request in either run got `os error 51`
  (`client_unreachable` 0), the error the same Mac hit with `oha` at 512
  concurrent requests in data-api-capacity DC07. The `client_limited`
  flag did not count unanswered requests then and reads `no` on both
  rows; it does since run 2. Run 2's burst through 150 lanes: 1,000 of
  1,000 HTTP 200, sent at 1237.6 req/s, p99 220 ms.
- `503_empty`: 4 (EB03-r200), 1 (EB03-r400), 18 (EB02-r1200), each row's
  in one 10 s bucket of send time (30 s, 20 s, 40 s into the step), none
  with an `x-sb-edge-region` header. Which component answered them was not
  determined. No `BOOT_ERROR`, `WORKER_RESOURCE_LIMIT` or Cloudflare HTML
  page in either run.
- The unanswered requests in run 2's 1,600 and 2,400 rows all fell in the
  first 10 s bucket (`not_ok_per_10s` 0:24 and 0:188), when the client
  is still opening sockets (timing only, cause not separated); EB03-r800's
  24 fell at 60 s.
- No `host_suspended_s` in either artifact.

Not settled by these runs:

- Rates from about 1,600 req/s up, or bursts denser than 1,000 through 150
  lanes: there the generator skipped at its 450 cap (2,400 req/s) and
  requests got `Unable to connect` when many sockets opened at once; whether
  this Mac or the far end caused the failures was not separated. The second
  vantage (a Cloudflare Worker generator) was not run.
- A limit keyed on something this setup held fixed: one client IPv4
  address, one Cloudflare colo (SIN), one function per arm, GET with no
  body, `verify_jwt` false, steps of 60 or 120 s.
- Other regions, and requests without `x-region` (not run). The Pro plan
  (the runs used the Team org). Whether the plan matters was not tested.
- These are two runs on one day; they say what the platform did on
  2026-11-04, not on other dates.
- The recursive case the docs describe is edge-function-limits EF10/EF14,
  not re-run here.
