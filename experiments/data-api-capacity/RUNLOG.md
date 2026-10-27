# RUNLOG - data-api-capacity

Chronological record of what was run. Org and project identifiers are not
recorded; the org class is (Pro). Each run provisions one throwaway project
through `POST /v1/projects` (ap-southeast-1, `desired_instance_size: small`),
resizes it to Large in DC01c and deletes it in DC99. Postgres 17.11 and
PostgREST 14.18 (the `application_name` of its connections) were read from
the runs' console output, not from the published artifacts; DC01a records
both from the next run on. Vantage: this lab's Mac in Singapore over the
public internet, so every client time below includes the round trip. "Docs"
means the source named in the module header; "measured" means the artifact.
DC08 is the exception to that vantage: its clients run in the project's
region (section below).

## 2026-10-27 - DC18 recovery after a write stall under a fixed rate, DC19 bursts against the gateway's 503 overflow (two runs)

Harness: lab commit af374bd plus the uncommitted DC18 and DC19 modules and
`lib/oha.ts` (run 2 also has DC18's drain column, added between the runs).
Two Pro-org projects in ap-southeast-1, one per run, run one after the
other from this lab's Mac in Singapore (10 cores) with `caffeinate -is` (no
host sleep inside either run); each deleted by its own DC99 (DELETE 200).
oha 1.16.0 (read locally, not in the artifact).

- Run 1: created `small` (pool 30),
  `out/2026-10-27/run-2026-10-27T03-32-49-289Z.json` (12 results), 03:32:49
  to 03:59:24 UTC; PostgreSQL 17.11 (DC18a).
- Run 2: created `4xlarge` (`PVLAB_DC_SIZE=4xlarge`, pool 70 in DC18's
  `pool_max`), DC18 arms control and lock only at `PVLAB_DC18_RATE=1500`,
  DC19 steps 3000, 6000, 10000, 20000,
  `out/2026-10-27/run-2026-10-27T04-00-57-062Z.json` (8 results), 04:00:57
  to 04:21:07 UTC; Postgres version not recorded (run 2 has no DC18a).

### DC18 - does Data API latency come back after a write stall at a fixed rate?

Question: under a steady request rate, when a short write stall (a lock, a
batch UPDATE, both sent through the Management API's SQL endpoint, outside
the Data API) ends, does Data API latency come back once the stall is over,
or does the queue it built outlive it? The second reading is what the
pool-wait CPU cost in PostgREST issue #5336
(https://github.com/PostgREST/postgrest/issues/5336) would predict: its
repro lost throughput from 4 PostgREST cores up with 80 requests waiting on
`db-pool` 20.

Method: `oha -q RATE -c 1024 -t 30s -z 270s` GET point reads on `dc_items`
(anon key): 60 s before the stall, then the stall (30 s for control and
lock, the UPDATE's own length for batch, 54.6 s), then the rest of the 270
s. Every answered request is recorded (`lib/oha.ts`; client-side errors are
counted, not timed); 5 s buckets of 2xx per second by end time, and p50/p95
of the requests sent in each bucket. Arms: control (sleep), lock (`access
exclusive` on `dc_items` held 30 s), batch (one UPDATE incrementing a
bigint column on every row of `dc18_users`, 2,000,000 rows, 204 MB, a table
no request reads; run 1 only). Recovery: the start of the first 5 s bucket
after the stall end with 2xx per second at least 0.9 x RATE and p50 at most
max(2 x pre p50, pre p50 + 50 ms), so 5 s resolution. oha's rate limiter
sends the requests it owes once a slot frees, so after a stall the client
runs at its 1024-in-flight cap until it has caught up; the backlog over
(drain rate - RATE) is the derived figure the recovery time is checked
against.

| run, size, rate | arm | stall | pre p50 | worst bucket (p50 of requests sent then; 2xx/s ended then) | 2xx/s after the stall, before recovery | recovery bucket after stall end | statuses (pre / stall / post) |
|---|---|---|---|---|---|---|---|
| 1, Small, 500 | control | none, 30 s | 29 ms | p50 35 ms; 500.6 | - | first bucket (5 s) | 200:30001 / 200:15001 / 200:89999 |
| 1, Small, 500 | lock | 30.1 s | 27 ms | p50 22093 ms of the 60 sent 5 to 10 s into the lock; 0 | 718 to 868.8 over 9 buckets (no drain column in run 1; 815.2 median over the code's 7-bucket drain window, from `evidence`) | 44.9 s | 200:29889 500:45 / 200:1003 500:225 / 200:103527 |
| 1, Small, 500 | batch | 54.6 s (the UPDATE) | 28 ms | p50 43 ms; 529 | - | first bucket (0.4 s) | 200:29946 / 200:27318 / 200:77682 |
| 2, 4XL, 1500 | control | none, 30 s | 23 ms | p50 37 ms; 1500.8 | - | first bucket (5 s) | 200:90003 / 200:45002 / 200:269995 |
| 2, 4XL, 1500 | lock | 30.2 s | 24 ms | p50 21816 ms of the 140 sent 5 to 10 s into the lock; 0 | 3367.2 to 4018.6 over 4 buckets; 3996 the median of the code's 2-bucket drain window | 19.8 s | 200:89733 500:152 / 200:1055 500:486 / 200:313138 |

- No queue collapse on either size (drain below the arrival rate): after
  the lock, Small served 718 to 868.8 2xx per second against 500 arriving,
  at p50 1174 to 1293 ms, and 4XL 3367.2 to 4018.6 against 1500, at p50 245
  to 261 ms. Small's overlaps the low end of DC04b's closed-loop range (825
  to 1020 req/s, a different project in ap-northeast-2), below its c=1024
  figure of 1020. 4XL's is what it drained with the client at its 1024 cap
  and at most 2 of 71 `authenticator` backends `active` in any drain
  sample; whether a
  higher cap drains faster, and where the 250 ms was spent, was not
  measured.
- The recovery times fit the client's backlog. Small: about 30 s x 500 owed
  over about 830 - 500 a second is about 45 s, measured 44.9 s (recovery
  bucket p50 32 ms, 613.4 2xx per second; 27 ms one bucket later); 4XL:
  about 30 s x 1500 over about 4000 - 1500 is about 18 s, measured 19.8 s
  (p50 23 ms). Derived, not separated from other causes.
- During the first 25 s of the lock: 0 2xx per second; in its last bucket
  21.8 (Small) and 9.4 (4XL). 500s at 6 to 12 per second on Small and 14 to
  28 on 4XL, the rate anon's 3 s statement timeout over pool 30 or 70
  predicts (DC03a; bodies not recorded). `pgrst_db_pool_waiting` read 962
  (Small, available 14 of 30 in the same snapshot) and 1024 (4XL, available
  0 of 70) after the stall started; `authenticator` samples during the lock
  read 30 active of 31 (Small) and 68 to 70 active of 71 (4XL); one 4XL
  sample, 12.2 s into the lock, also read 1 `idle in transaction
  (aborted)` (DC06 saw none; whether a later request met it as 25P02 was
  not checked, and the post-lock statuses hold no non-200). The drain-phase
  pool series is not published, and no Small sample after the lock had an
  `active` backend (idle 14 to 29 and idle in transaction 2 to 17, of 31),
  so it is not shown that requests waited for a connection during the
  drain.
- The batch arm slowed reads on another table a little and did not cut
  throughput: p50 34 to 43 ms during the 54.6 s UPDATE of 2,000,000 rows
  against 28 ms before, 2xx per second at the rate, pool waiting at most 4.
- Client-side: 297 timeouts and 15 `Network is unreachable (os error 51)`
  in run 1's lock arm, 55 os error 51 in its batch arm, 436 timeouts in run
  2's lock arm; client load1 at most 5.6 (run 1 control arm; 4.2 to 4.8 in
  the other arms) on 10 cores.

Reading: on Small and on 4XL, PostgREST drained the backlog after a 30 s
lock faster than the arrival rate (718 to 868.8 against 500; 3367.2 to
4018.6 against 1500), so the stall cost a backlog that cleared on its own.
Issue #5336's collapse was not reproduced here. Its repro had 80 requests
waiting on `db-pool` 20 (4 per connection) and lost throughput from 4
PostgREST cores up; DC18's lock had up to 1024 waiting on 70 (4XL) and 962
on 30 (Small). PostgREST's own core count on these instances was not read.
8XL and above, a client cap above 1024, an open loop without a cap, and
client retries were not run.

### DC19 - when does the gateway answer 503 "reset reason: overflow"?

Question: how many requests can be in flight to one project before the API
gateway answers 503 `upstream connect error or disconnect/reset before
headers. reset reason: overflow`, Envoy's answer when an upstream circuit
breaker is full? Envoy's cluster breakers default to 1024 each for
max_connections, max_pending_requests and max_requests
(https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/cluster/v3/circuit_breaker.proto,
read 2026-10-27); the gateway's own values are not readable.

Method: `db_pool_acquisition_timeout` PATCHed to 60 (200; restart line 1.3
s (run 1) and 0.7 s (run 2) after the PATCH), so requests queued for the
pool wait 60 s inside PostgREST before PGRST003; one oha run per step of K
`POST /rpc/dc_sleep_xl {"s": 1}` sent at once (anon key) over HTTP/2,
ceil(K / 100) connections with K spread over them (100 streams each from
K=500; 3 x 84 at 250), client timeout 20 s; three HTTP/1.1 probes 3 s in.
K is what was sent at once; how many were in flight at the gateway was not
measured (Cloudflare terminates the HTTP/2 connections).

| run, size | K | answered (all 200) | within 2 s | 503 | unanswered at 20 s | authenticator 5 s in |
|---|---|---|---|---|---|---|
| 1, Small | 250 | 250 | 30 | 0 | 0 | 13 active of 31 |
| 1, Small | 500 | 500 | 30 | 0 | 0 | 30 active of 31 |
| 1, Small | 1000 | 569 | 30 | 0 | 431 | 30 active of 31 |
| 1, Small | 1500 | 568 | 30 | 0 | 932 | 30 active of 31 |
| 1, Small | 2000 | 569 | 30 | 0 | 1431 | 30 active of 31 |
| 1, Small | 3000 | 569 | 0 | 0 | 2431 | 30 active of 31 |
| 2, 4XL | 3000 | 1329 | 70 | 0 | 1671 | 69 active of 71 |
| 2, 4XL | 6000 | 1287 | 31 | 0 | 4713 | 68 active of 71 |
| 2, 4XL | 10000 | 1132 | 41 | 0 | 8868 | 68 active of 71 |
| 2, 4XL | 20000 | 966 | 0 | 0 | 19034 | 68 active of 71 |

- No 503 at any step, up to K = 20,000 requests sent at once from one
  client. Every answer was a 200: 569 in the 20 s at every Small step from
  1000 (about 30 one-second sleeps a second), and on 4XL 1329 at 3000
  falling to 966 at 20000; the rest were unanswered when the client gave up.
- Where the unanswered requests waited (Cloudflare, the gateway, PostgREST's
  queue) is not visible from the client. The fall on 4XL from 1329 to 966
  fits both the time oha took to open up to 200 connections and a slower
  PostgREST under more waiters; not separated.
- Reading: with the pool busy (30 active of 31, 68 to 69 active of 71) and
  every answer a 200, the gateway did not refuse; whether the unanswered
  requests were queued in PostgREST is not visible. A PostgREST that
  answers slowly while most pool connections sit idle is a different shape:
  a breaker that counts upstream connections or pending connection requests
  could fill there and not here (reasoned from Envoy's breaker definitions,
  not measured). Not run: a slow PostgREST with free pool slots, other
  regions, other clients.

### Not run

- DC18 on 8XL or above, with a client cap above 1024, without a cap, with
  retries, or with a stall on a table the reads use only partly; DC18's
  batch arm on 4XL.
- DC19 against a slow PostgREST with free pool connections, and from more
  than one client vantage.

### Cost

Two Pro-org projects: Small for about 27 minutes, 4XL for about 20 minutes.

## 2026-10-26 - DC16 Realtime pool on a project created at 2XL, DC17 the gateway's long-request timeout (one run each)

Harness: lab commit adc597c plus the uncommitted DC16 and DC17 modules (and
DC13's Realtime row moved to `lib/rt-read.ts`, unchanged). Three Pro-org
projects in ap-southeast-1, one per process, the three processes started
within 22 s of each other from this lab's Mac in Singapore (other agents
also ran live work from the same Mac); each deleted by its own DC99 (DELETE
200), and `lib/cleanup.ts` listed 0 projects under each run's name prefix
afterwards. Postgres 17.11 on all three; PostgREST 14.18 (DC17a, the
`application_name` of `authenticator`).

- DC17: created `small`, `out/2026-10-26/run-2026-10-26T05-48-07-761Z.json`
  (31 results), 05:48:07 to 05:58:26 UTC.
- DC16 at 2XL: created with `desired_instance_size: 2xlarge`,
  `out/2026-10-26/run-2026-10-26T05-48-18-228Z.json` (4 results), 05:48:18
  to 05:52:04 UTC.
- DC16 control: created `small`,
  `out/2026-10-26/run-2026-10-26T05-48-29-561Z.json` (4 results), 05:48:29
  to 05:50:27 UTC.

### DC16 - Realtime's authorisation pool on a project created at 2XL

Question: DC13 (2026-10-26, below) read `connection_pool` 5 and held 5
`realtime_connect` connections on a project created Small and resized to XL
and 2XL, where the Realtime concepts page's table of default pool sizes
(https://supabase.com/docs/guides/realtime/concepts, "Authorization Pool
Size": Nano and Micro 2, Small to Large 5, XL to 4XL 10, 8XL and above 15,
"If not specified, the default values shown in the table will be used")
gives 10. H1: the value is set once from the size the project is created
at and not re-derived on a resize, so a project created at 2XL reads 10. H2:
the table does not describe these projects, so it reads 5 or another value.

`POST /v1/projects` accepts `desired_instance_size` (enum in the Management
API's OpenAPI document, https://api.supabase.com/api/v1-json, `2xlarge`
among them); the 2XL project answered `max_connections` 380 and 8 node CPUs
114 s after the POST. Each project: GET `/config/realtime` as soon as the
project answered and before any Realtime client connected (DC16a), the Data
API pool with `db_pool` unset (one burst of 150 12 s sleeps, DC16b), then
DC13's Realtime row (DC16c: config again, a 100-join Postgres Changes burst,
Realtime's connections by name).

| row | created 2XL | created Small (control) |
| --- | --- | --- |
| DC16a `connection_pool`, before any Realtime client | 10 | 5 |
| DC16a `postgres_changes_pool` / `max_concurrent_users` / `max_joins_per_second` / `max_channels_per_client` / `max_events_per_second` | null / 10000 / 2500 / 100 / 2500 | null / 10000 / 2500 / 100 / 2500 |
| DC16a `max_connections`, node CPUs | 380, 8 | 90, 2 |
| DC16b `db_pool` read, `pgrst_db_pool_max`, mid-burst PgSleep (burst of 150) | null, 70, 70 | null, 30, 30 |
| DC16b burst outcomes | 150 x 200 | 130 x 200 + 20 x 504 `PGRST003` |
| DC16c `realtime_connect` before / max during settle / after 30 s | 10 / 10 / 10 | 5 / 5 / 5 |
| DC16c `realtime_subscription_manager_pub` max during settle | 7 | 4 |
| DC16c joins ready, join to ready p50 / p95 | 100 of 100, 2085 / 2954 ms | 100 of 100, 2006 / 2884 ms |

Readings:

- **H1 held: the authorisation pool follows the size the project was
  created at.** Created at 2XL, `connection_pool` read 10 before any
  Realtime client and `realtime_connect` held 10; created Small in the same
  minute, 5 and 5. With DC13 (created Small, then XL and 2XL: 5 throughout)
  the value is set at creation and a resize does not change it. One project
  per arm; XL, 4XL and 8XL at creation were not run.
- The 2026-10-22 RT05 project in realtime-surface read `connection_pool` 2
  after a resize to Small; its create body sent no `desired_instance_size`
  (the OpenAPI description: "Omit this field to always default to the
  smallest possible size"), so the 2 fits a Micro creation (the table's
  Micro value) carried across the resize. The creation size of that project
  was not read back.
- The subscription-manager connections followed the current size on
  DC13's resized project (4 / 7 / 7); DC16's 7 at 2XL and 4 at Small agree
  and cannot separate it, each arm being read at its creation size. Both
  match the table's "Subscription management" 4 and 7, with
  `postgres_changes_pool` null in every case. So of the two pools only the
  authorisation pool is shown pinned at creation.
- The Data API pool with `db_pool` unset was the same on a project created at
  2XL as on one resized there (70, DC13), and 30 on Small as in DC01 and
  DC13.
- A project resized up keeps the smaller authorisation pool until
  `connection_pool` is set through the Realtime config (the "Database
  connection pool size" parameter of the Realtime configuration, per the
  concepts page); setting it after a resize
  was not run here.

### DC17 - the gateway's long-request timeout, and the statement after it

Question: DC12d and DC14 got 504 `text/plain` `upstream request timeout`
with no PostgREST code at about 125 s. Which component sends it, at what
value, and does the statement keep running after the 504? H1: a fixed
whole-request timeout in the API gateway's Envoy near 125 s; the statement
runs to its end and commits, because nothing cancels it. H2: Cloudflare's or
PostgREST's limit (a different status or body, for example a 524). H3: the
statement is cancelled when the gateway gives up.

Method: `dc17_sleep(s, tag)`, SECURITY DEFINER with `set statement_timeout =
'600s'` (which PostgREST hoists, DC09), sets its transaction's
`application_name` to `dc17-<tag>`, inserts its tag and start time, sleeps
`s`, and stamps a finish time, so a committed row with a finish time means
the statement ran to its end and its transaction committed. Per round, 11
POST /rpc requests at 100, 115, 120, 123, 124, 125, 126, 127, 130, 150 and
180 s went out concurrently with the legacy service_role key, one
User-Agent each; round 1 added the anon key at 150 s and GET /rpc of a
read-only twin (`dc17_nap`, no row) at 150 s. Two rounds. The pool
(`db_pool` unset; 30 on Small in DC01 and DC16b, not read in DC17) was far
above the 13 concurrent requests of round 1 (11 in round 2). A poller read `pg_stat_activity` for
`dc17-%` every 3 s (127 reads, 0 failed, largest gap 3002 ms). Client clock
against the database clock: offset 37 ms (bound 49 ms). Alongside each
round, the same 180 s call as `postgres` with `statement_timeout = 0` over
the session pooler (port 5432) and over a direct connection to the db host.

| requested s | round 1: status, client ms | round 2: status, client ms | `x-envoy-upstream-service-time` (r1 / r2) | row finished, s after send (r1 / r2) |
| --- | --- | --- | --- | --- |
| 100 | 200, 100309 | 200, 100475 | 100129 / 100195 | 100.3 / 100.4 |
| 115 | 200, 115246 | 200, 115535 | 115160 / 115234 | 115.2 / 115.5 |
| 120 | 200, 120296 | 200, 120514 | 120211 / 120208 | 120.2 / 120.4 |
| 123 | 200, 123242 | 200, 123501 | 123174 / 123209 | 123.2 / 123.5 |
| 124 | 200, 124226 | 200, 124499 | 124162 / 124214 | 124.2 / 124.4 |
| 125 | 504, 125065 | 504, 125279 | absent | 125.2 / 125.5 |
| 126 | 504, 125089 | 504, 125283 | absent | 126.2 / 126.5 |
| 127 | 504, 125065 | 504, 125283 | absent | 127.2 / 127.5 |
| 130 | 504, 125090 | 504, 125310 | absent | 130.2 / 130.5 |
| 150 | 504, 125102 | 504, 125292 | absent | 150.2 / 150.4 |
| 180 | 504, 125063 | 504, 125305 | absent | 180.1 / 180.5 |
| 150, anon key (r1) | 504, 125072 | - | absent | 150.2 |
| 150, GET /rpc (r1) | 504, 125062 | - | absent | no row by design; backend last seen 150 s, gone by 153 s |

| path, 180 s as `postgres` | round 1 | round 2 |
| --- | --- | --- |
| session pooler | returned after 180098 ms, row finished | returned after 180099 ms, row finished |
| direct (db host) | `getaddrinfo ENOTFOUND` after 32 ms, not run | `getaddrinfo ENOTFOUND` after 24 ms, not run |

Every 504 had body `upstream request timeout` (content-length 24),
`content-type: text/plain`, `server: cloudflare`, `cf-cache-status:
DYNAMIC`, `sb-gateway-version: 1`, `x-envoy-attempt-count: 1`, no
`x-envoy-upstream-service-time`, no `content-profile`, no `proxy-status`,
Cloudflare colo SIN. The 200s carried the same gateway headers plus
`x-envoy-upstream-service-time` and `content-profile: public`. No `via`
header on either. Each request had 1 `edge_logs` row with the client's
status (24 rows); 0 PostgREST access-log lines in total.

Readings:

- **The timeout is the API gateway's Envoy, at 125 s: the same at every
  requested duration from 125 s up with the legacy service_role key (POST
  /rpc, two rounds), and for the legacy anon key and GET /rpc at 150 s
  (round 1, one request each).**
  Sleeps of up to 124 s answered 200 (upstream service time up to 124214 ms);
  every sleep of 125 s or more was answered 504 at 125062 to 125310 ms at the
  client, while its statement was still running. The body is Envoy's local
  reply text, `x-envoy-attempt-count: 1` says one upstream attempt, and the
  absent `x-envoy-upstream-service-time` says no upstream response came
  back. Cloudflare passed the 504 through (`cf-cache-status: DYNAMIC`, no
  524), so its own limit is above 125 s on this path. This run used a Small
  project; DC12d (Small, pool held) and DC14 (2XL, CPU-bound) saw the same
  body at the same time, so the size and the pool state did not change it.
  Whether the limit counts from the request or from the last byte cannot be
  told apart here (PostgREST sends nothing before the statement ends);
  the gateway configuration itself is not readable from a project.
- **The statement keeps running after the 504 and commits.** Every 504'd
  POST request's row (12 of 12) was committed with a finish time at its full
  requested duration (125.2 to 180.5 s after send), up to 55.2 s after the
  client had its 504 (the 180 s requests); the 504'd GET /rpc, which writes
  no row, had its backend last seen at 150 s and gone by 153 s. The poller saw each backend until its sleep
  ended, and `postgres_logs` held 26 `duration: ... plan:` lines (24 for
  Data API statements, 2 for the pooler calls, matching the 24 requests and
  2 calls in count; for example 180101.096 ms for an RPC) and no
  cancellation, termination or lost-client line in the window (the read
  matched cancel, terminat, client, timeout, EOF, dc17, broken pipe and
  could not send). So H3 is out: nothing cancelled the statement, and
  PostgREST committed a transaction whose client had already been told 504.
  A write behind a request that times out at the gateway is applied.
- **Postgres outside the Data API ran the same 180 s call to the end** over
  the session pooler (twice, 180098 and 180099 ms, rows finished), so the 125
  s cut belongs to the HTTP path. The direct connection did not resolve from
  this Mac (`getaddrinfo ENOTFOUND` for the db host, both rounds, under 40
  ms; the reason was not investigated), so the direct path was not measured.
- The 0 PostgREST access-log lines fit DC09's reading that this PostgREST
  logs error responses only: from PostgREST's side every one of these
  requests succeeded.

### Not run

- DC16 at XL, 4XL or 8XL at creation; `connection_pool` set by hand after a
  resize; whether a later platform change re-derives it.
- DC17 on another size, region or vantage; a direct Postgres connection
  (did not resolve); a response that streams bytes before 125 s; repeats
  beyond two rounds.

### Cost

DC16 at 2XL about 4 minutes (05:48:18 to 05:52:04 UTC, the artifact's
stamps), the control about 2 minutes at Small, DC17 about 10 minutes at
Small.

## 2026-10-26 - DC09 function-level statement timeouts, DC12 PGRST003 resends (one run)

Harness: `make run ONLY=DC09,DC12,DC99`, lab commit 848b9f3 plus the
uncommitted DC09 and DC12 modules. One Pro-org project, ap-southeast-1,
Small throughout (`db_pool` unset at creation), deleted by DC99 (DELETE 200,
absent from the listing at once; `make clean` listed 0 `pvlab-dc-` projects
afterwards, console). Client: this lab's Mac in Singapore. Postgres and
PostgREST versions are not recorded in this artifact. Published:
`out/2026-10-26/run-2026-10-26T00-23-46-863Z.json` (16 results) and its
`.facts.md` (one test user's id in a response header was replaced with
`<user-uuid>` by hand; the module no longer keeps that header).

### DC09 - which function-level `statement_timeout` a request honours

Question: DC03b's 12 s sleep under a function declared `set
statement_timeout = '30s'` answered 200. Either PostgREST applies the called
function's setting before the statement starts (PostgREST docs, "hoisted
function settings", `db-hoisted-tx-settings`, whose default includes
`statement_timeout`; doc-cited, not re-read here) and Postgres keeps the timer
it armed when the statement started (H1), or Postgres honours a function's
SET mid-statement (H2). Every Data API call below: anon key plus a signed-in
user's token (role `authenticated`, `rolconfig` `{statement_timeout=8s}`),
POST /rpc unless named, 12 s sleep, n = 3 sequential calls. Bodies are the
`current_setting('statement_timeout')` each function returned.

| row | measured |
|---|---|
| DC09a control, no function setting | 500 57014 after 8053 / 8047 / 8054 ms |
| DC09b outer `set 30s` calls inner (no setting) | 200 after 12288 / 12053 / 12055 ms, body `outer=30s inner=30s` |
| DC09c outer (no setting) calls inner `set 30s` | 500 57014 after 8066 / 8060 / 8063 ms |
| DC09d outer `set 30s` calls inner `set 2s` | 200 after 12127 / 12055 / 12070 ms, body `outer=30s inner=2s` |
| DC09e `language sql stable`, `set 30s` | GET /rpc: 200 after 12062 / 12056 / 12055 ms; POST /rpc: 200 after 12057 / 12060 / 12070 ms; body `30s` |
| DC09f SECURITY DEFINER, `set search_path = ''`, `set 30s` | 200 after 12057 / 12057 / 12056 ms, body `30s` |
| DC09g `set 120s`, 70 s sleep, 3 concurrent requests | 200 after 70144 / 70144 / 70119 ms, body `2min`; 3 executions started and 3 finished (non-transactional sequences), 3 rows committed; 3 `edge_logs` rows (200), 0 PostgREST access-log lines; no backend still active at the first read after the answers |
| DC09h `alter function ... set statement_timeout = '30s'` on a function without one | before the ALTER: 500 57014 after 8264 / 8081 / 8094 ms. Right after it (first call sent about 0.2 s after the ALTER was sent, derived below): 500 57014 after 8061 ms, then 200 after 12089 and 12058 ms. After `notify pgrst, 'reload schema'`: 200 after 12086 / 12064 / 12066 ms. PostgREST logged `Received a schema cache reload message on the "pgrst" channel` 0.1 s and `Schema cache loaded` 0.3 s after the ALTER was sent (log timestamps against the orchestrator's clock, skew not measured), with no NOTIFY from the module; the `pg_event_trigger` read returned `none` |
| DC09i pg_cron 1.6.4 (`cron.use_background_workers` off), jobs `set statement_timeout = '8s'; select f(12)` every 20 s, 3 runs each | control `dc_sleep`: failed after 8004 / 8004 / 8006 ms; top-level `dc_sleep_long` (`set 30s`): failed after 8004 / 8003 / 8004 ms; arm 2's outer: failed after 8005 / 8006 / 8002 ms; every message `canceling statement due to statement timeout` |
| DC09j session-mode pooler as `postgres`, `set statement_timeout = '8s'`, `set role authenticated`, one psql process per call | baseline `select current_user, current_setting(...)` read `authenticated|8s` in 282 ms; control, top-level `set 30s` and arm 2's outer all 57014 after 8110 to 8154 ms (9 calls, connection set-up included) |

The DC09h "sent" column in this run's artifact reads 24.3 s: the module
computed it after all three calls as (now - ALTER sent - call 1 ms), which
also counts calls 2 and 3; 24.3 - 12.089 - 12.058 gives about 0.2 s. The
module records each call's own send time from the next run on.

Readings:

- H1 held in every arm and H2 in none. A function's own `set
  statement_timeout` lifted the caller's 8 s only when it was the function the
  Data API called (DC09b, d, e, f): a nested function's longer value did not
  (DC09c), a nested function's shorter value did not cut the call (DC09d, the
  inner function read `2s` and still slept 12 s), and outside PostgREST
  (pg_cron, a pooler session) even the top-level function's 30 s did not lift
  the session's 8 s (DC09i, DC09j). That matches PostgREST applying the
  called function's setting before the statement and Postgres arming the
  statement timer once, at statement start (Postgres docs on
  `statement_timeout`; doc-cited, not re-read here).
- This corrects the reading under DC03 (2026-10-22/23 section): the function
  setting applies to Data API calls because PostgREST hoists it, not because
  Postgres applies a function's SET to a running statement.
- DC09h fits the same mechanism: the ALTER takes effect for Data API calls
  once PostgREST's schema cache has the new setting. A reload arrived without
  a NOTIFY from the module, within about 0.3 s; the sender is not identified
  (`pg_event_trigger` read `none`, and a failed read would record the same
  word), and the first call raced it and lost.
- DC09g: 70 s requests answered 200 through the Data API, against the
  Supabase timeouts guide's "Dashboard and Client queries have a
  max-configurable timeout of 60 seconds"
  (https://supabase.com/docs/guides/database/postgres/timeouts). The cap the
  gateway applied in DC12 was about 125 s (below). A successful request left
  no PostgREST access-log line here, while every 5xx in DC01b, DC02b, DC03d
  and DC12 did: PostgREST at this log level writes error responses only (a
  reading; its log level was not read).

### DC12 - which layer resends after a PGRST003

Question: DC01b and DC02b found 6 PostgREST access-log lines per request
answered 504 PGRST003, and a client wait of about 6 x the acquisition
timeout. Per arm the module PATCHed `db_pool` (a different size per arm, so
a metrics snapshot names its PostgREST process by `pgrst_db_pool_max`) and
`db_pool_acquisition_timeout`, waited for the restart line (0.9 to 1.3 s
after the PATCH), held every pooled connection with service_role `dc12_hold`
sleeps (`pg_stat_activity`: 10 of 10, 11 of 11, 12 of 12, 13 of 13, 14 of 14
sleeping at probe time and still after the last answer), sent single GET,
HEAD, PATCH and POST /rpc requests concurrently with the service_role key
and one User-Agent each, cancelled the holders with `pg_cancel_backend`, and
read the metrics endpoint until its snapshot had refreshed twice.

| row | measured |
|---|---|
| DC12a timeout 1 s, pool 10, two rounds of 4 methods (8 requests) | all 504, PGRST003 body except HEAD (no body), after 6669 to 7886 ms; each request: 6 PostgREST lines (504:6), 1 `edge_logs` row (504), gaps between its PostgREST lines 1.0 to 1.9 s, one remote address. `pgrst_db_pool_timeouts_total` 0 before, 48 after |
| DC12b timeout 5 s, pool 11, two rounds (8) | all 504 after 30405 to 32115 ms; each 6 PostgREST lines, 1 edge row; gaps 5.0 to 6.0 s. Timeouts 0 to 48 |
| DC12c timeout 20 s, pool 12, one round (4) | all 504 PGRST003 (HEAD no body) after 120881 to 121746 ms; each 6 PostgREST lines, gaps 20.0 to 20.9 s; edge rows 1 for GET, HEAD and POST /rpc, 0 for the PATCH. Timeouts 0 to 24 |
| DC12d timeout 60 s, pool 13, one round (4) | all 504 `text/plain` `upstream request timeout`, no PGRST003, after 125055 to 125066 ms. GET, HEAD, PATCH: 2 PostgREST lines each (504:2), 60.0 to 60.1 s apart; POST /rpc: 0 PostgREST lines. 1 edge row each (504). Timeouts 0 to 6 |
| DC12e burst: timeout 5 s, pool 14 held, 42 concurrent POST /rpc | 41 x 504 PGRST003 (minimum 30768 ms; median of all 42 requests 31458 ms; the 41's maximum not recorded), each 6 PostgREST lines; 1 x 504 `upstream request timeout` after 125097 ms with 0 PostgREST lines; 1 edge row per request (42). Timeouts 0 to 246 |
| headers, one sampled PGRST003 answer per arm (DC12a-c; the module keeps one) | `server: cloudflare`, `cf-cache-status: DYNAMIC`, `sb-gateway-version: 1`, `proxy-status: PostgREST; error=PGRST003`, `x-envoy-attempt-count: 6`, `x-envoy-upstream-service-time` 7575 / 31144 / 120961 ms in the DC12a-c samples |
| headers, the sampled `upstream request timeout` answer in DC12d and in DC12e | `content-type: text/plain`, `x-envoy-attempt-count: 1`, no `proxy-status`, no `x-envoy-upstream-service-time` |
| holders | DC12a, b: 500 57014 (the cancel); DC12c, d, e (holds of 240, 480 and 150 s): 504 from every holder |
| metrics snapshot | refreshes seen 60 to 61 s apart in every arm (5 s reads; snapshots at 22/63/123 s after the arm began in DC12a, 71/132/192 s in DC12b, 129/189/250 s in DC12c, 132/193/253 s in DC12d and DC12e) |

Readings:

- The resending layer is Envoy, behind the hop that writes `edge_logs`:
  `x-envoy-attempt-count: 6` on each sampled PGRST003 answer, one
  `edge_logs` row per client request, six PostgREST attempts. GET, HEAD,
  PATCH and POST were all resent. The attempts follow each other with no
  added back-off (the gap between PostgREST lines is the acquisition timeout
  plus 0.0 to 1.0 s), so a client waits 6 x the timeout plus 0.4 to 2.1 s
  (DC12a-c).
- PostgREST counts every attempt: `pgrst_db_pool_timeouts_total` went up 6
  per failed client request (48 for 8, 24 for 4, 246 for 41), and 6 for the
  three DC12d requests that reached PostgREST twice each. One client 504 is
  six pool timeouts on that counter.
- Envoy's whole-request limit is about 125 s: at a 60 s acquisition timeout
  two attempts fit (0 and 60 s) and the third was cut, so the client got
  Envoy's own `upstream request timeout` 504 after 125 s instead of a
  PGRST003, and holders still running at about 125 s were answered 504 too
  (DC12c-e; DC12b's 150 s holders were cancelled after the last probe
  answer, about 70 s in, and got 500 57014). At 20 s six attempts (about 121
  s) still fit. Retry policy and timeout values are not readable from a
  project; the attempt count and the about 125 s are this run's
  observations.
- Postgres kept running a request's query after the gateway answered it:
  the holders' answers in DC12c-e were the gateway's 504 (the cancel gives
  57014, as in DC12a-b), and `pg_stat_activity` still showed every holder
  sleeping after the last probe answer (131 s into DC12d and DC12e), until
  the module cancelled them. Ordering inferred: holder answer times were not
  recorded.
- Two requests never reached PostgREST: DC12d's POST /rpc and one of the 42
  in DC12e, each 0 PostgREST lines, 1 edge row and Envoy's 125 s timeout. The
  timeout counter agrees (DC12d: 6 = three requests x 2 attempts; DC12e: 246 =
  41 x 6), so they are not lost log lines. DC02b's request with 0 lines and no
  answer by 105 s fits the same thing. Where they waited is not identified.
- The DC12c PATCH with 0 edge rows had 6 PostgREST lines and its 504; an
  `edge_logs` row missing from ingestion is the likely reading, not separated.
- The burst did not shorten the wait: with the pool held throughout, 41 of
  42 waited about 6 x 5 s. DC02c's shorter waits (holders finishing in waves)
  are a different shape and are not contradicted.

### Not run

- DC09 under the anon or service_role key, other hoisted settings
  (`plan_filter.statement_cost_limit`, `default_transaction_isolation`),
  functions reached through views or RLS policies; PostgREST's hoisting code
  (source not read); the sender of the reload after an ALTER.
- DC12 on another size or region; a 5xx other than PGRST003 (for example
  503 PGRST002) to test whether Envoy resends it (DC03d: a 500 was not
  resent); the time at which a holder's 504 arrived; where the two requests
  without PostgREST lines waited.
- Repeats of either module.

### Cost

Project time about 38 minutes (00:23:46 to 01:01:42 UTC, the artifact's
start and finish stamps), Small throughout, one project.

## 2026-10-26 - DC13-DC15, defaults per size up to 2XL, statements of a few seconds, a set pool across a resize (one run each)

Lab commit 848b9f3 plus the uncommitted DC13-DC15 modules (`lib/tier.ts`,
the `lib/dc.ts` changes). Five projects on the Pro org, ap-southeast-1 (the
main project, the DC15 custom project and three DC15 control projects, two
of which failed before any read and are not published), each created with
`desired_instance_size: small`, Postgres 17.11, PostgREST 14.18
(`application_name` of its connections). Vantage: this lab's Mac over the
public internet (`dc_ping` through the Data API 38 to 47 ms, DC14a).

- Main project: DC13 resized it Small -> XL -> 2XL, then DC14 ran on 2XL,
  then realtime-surface RT05 (its RUNLOG, 2026-10-26) reused it at 2XL; it
  was deleted after RT05. Published:
  `out/2026-10-26/run-2026-10-26T00-24-26-283Z.json` (27 results; DC13
  took 942 s, DC14 2,484 s).
- The two published DC15 projects (custom and control arms), each deleted by
  its DC99; section below.
- Of the three published projects' `POST /v1/projects` calls, two returned a
  project whose `created_at` was before the request (about 4 min and 3.7
  min, read from `GET /v1/projects` during the run, console only); DC13
  logged the main project, one of those two, ready 4 s after the POST, at
  Small (`max_connections` 90; the 4 s is console only). The third project's
  `created_at` matched its request. Read: the platform sometimes hands out a
  project provisioned ahead of the request; not investigated further, and
  nothing in the measurements depended on it.

### DC13 - pool and Realtime connections with nothing configured, Small -> XL -> 2XL

Per size: GET `/postgrest`, `pgrst_db_pool_max` scraped every 5 s for 90 s,
two bursts of 150 concurrent 12 s `dc_sleep_xl` calls (service_role key)
with the mid-burst PgSleep count of `authenticator`; then GET
`/config/realtime` and one raw-protocol burst of 100 Postgres Changes joins
(realtime-surface `lib/burst.ts`, a table with an `authenticated` select
policy, settings as created), Realtime's connections sampled each second
while it settled, and client backends by role and application afterwards.

| Size | `max_connections` | node CPUs (metrics) | `db_pool` read | `pgrst_db_pool_max` (18 scrapes) | PgSleep mid-burst (150) | burst outcomes |
| --- | --- | --- | --- | --- | --- | --- |
| Small | 90 | 2 | null | 30 | 30 / 30 | 130 x 200 + 20 x 504 `PGRST003`, both |
| XL | 240 | 4 | null | 60 | 60 / 60 | 150 x 200, both |
| 2XL | 380 | 8 | null | 70 | 70 / 70 | 150 x 200, both |

- **2XL default pool 70 held** (hypothesis: 70). XL reads 60, a figure not
  measured before. With DC01 (Small 30, Large 50) and DC04 (4XL 70) the
  unset pool reads 30 / 50 / 60 / 70 / 70 for Small / Large / XL / 2XL /
  4XL; whether 8XL and above go higher was not measured. The metrics series
  agreed with the burst count at every size (no change during the 90 s).
- Resizes: Small -> XL settled 161 s after the add-on PATCH, XL -> 2XL
  195 s; no 429 on either; 0 of 60 Data API pings failed in the 60 s watch
  after each.
- **Realtime config as created read the same at all three sizes:**
  `connection_pool` 5, `postgres_changes_pool` null, `max_concurrent_users`
  10000, `max_joins_per_second` 2500, `max_channels_per_client` 100,
  `max_events_per_second` 2500. RT05 on 2026-10-22 read `connection_pool` 2
  on a new project; this one read 5 from the start (Small).
- **Realtime's connections around the 100-join burst (every burst 100 of
  100 ready):**

  | Size | `realtime_connect` | `realtime_subscription_manager_pub` | `realtime_subscription_manager` | `realtime_rls` | `realtime_replication_connection` |
  | --- | --- | --- | --- | --- | --- |
  | Small | 5 | 4 | 1 | 1 | 1 |
  | XL | 5 | 7 | 1 | 1 | 1 |
  | 2XL | 5 | 7 | 1 | 1 | 1 |

  All `supabase_admin`. Before each burst only the 5 `realtime_connect`
  connections were open; 30 s after it, the others were still open.
- **2XL Realtime subscription pool 7 held** if `realtime_subscription_manager_pub`
  is the "Subscription management" pool of the concepts page
  (https://supabase.com/docs/guides/realtime/concepts, table of default
  pool sizes: Small to Large 4, XL to 4XL 7). That name tracked
  `postgres_changes_pool` in RT05 (2026-10-22), which is the basis for the
  reading; it is not a documented mapping.
- **The authorisation pool did not follow the size.** The concepts table
  gives an "Authorization Pool Size" of 5 for Small to Large and 10 for XL
  to 4XL, "If not specified". `realtime_connect` held 5 at every size here
  and `connection_pool` read 5 (an explicit value, not null) on XL and 2XL.
  Two readings, not separated: the 5 was written at creation for Small and
  is not re-derived on a resize (as `db_pool` 45 was kept in DC15), or the
  table does not describe this project; a project created at XL or 2XL was
  not run. That `realtime_connect` is the authorisation pool is inferred
  from it equalling `connection_pool`. Separated by DC16 (later run the
  same day, section above): a project created at 2XL read 10 and held 10
  `realtime_connect`, a Small one created alongside read 5, so the value is
  set from the creation size and a resize keeps it.

### DC14 - statements of about 3 s against `db_pool` unset (70), 140, 200 on 2XL

Two kinds of RPC, both declaring `set statement_timeout = '180s'`:
`dc_sleep_xl(3)` (waits) and `dc14_cpu(n)`, a plpgsql loop of `sqrt`
additions with n = 34464536 calibrated to 2966 / 2957 / 2941 ms alone
in SQL (3060 and 3021 ms through the Data API). Arms in order: unset (the
project as DC13 left it), PATCH 140, PATCH 200 (each read back, PostgREST
restart 0.6 s after the PATCH, then 15 s). Per arm and kind: bursts of 1.5
and 3 x the pool, then an open loop (requests sent on schedule whether or
not earlier ones answered) of 40/s (sleep) or 4/s (CPU) for 120 s. Legacy
service_role key, a fresh connection per request, 240 s client timeout.
One run per cell. "ok/s" is 200s divided by the row's wall time (until the
last answer). Backends: client backends sampled every ~3 s.

Sleep (3 s `pg_sleep`):

| `db_pool` | load | outcomes | wall s | p50 / p95 ms (all) | ok/s | max client backends (`authenticator`) |
| --- | --- | --- | --- | --- | --- | --- |
| unset (70) | burst 105 | 105 x 200 | 6 | 3367 / 6348 | 16.5 | 90 (71) |
| unset (70) | burst 210 | 210 x 200 | 10 | 6480 / 9495 | 22.1 | 90 (71) |
| unset (70) | 40/s x 120 s | 4800 x 200 | 208 | 45237 / 85443 | 23 | 88 (71) |
| 140 | burst 210 | 198 x 200, 12 client | 6 | 3456 / 6421 | 30.7 | 144 (141) |
| 140 | burst 420 | 346 x 200, 74 client | 9 | 3257 / 9253 | 37.3 | 144 (141) |
| 140 | 40/s x 120 s | 4800 x 200 | 123 | 3045 / 3056 | 39 | 144 (141) |
| 200 | burst 300 | 276 x 200, 24 client | 6 | 3560 / 6384 | 43 | 204 (201) |
| 200 | burst 600 | 521 x 200, 79 client | 9 | 6142 / 9387 | 55.4 | 204 (201) |
| 200 | 40/s x 120 s | 4800 x 200 | 123 | 3045 / 3057 | 39 | 204 (201) |

CPU (`dc14_cpu`, about 3 s alone):

| `db_pool` | load | outcomes | wall s | p50 / p95 ms (all) | p50 / p95 ms (200s) | ok/s | `authenticator` on CPU (max) | node CPU % (span s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| unset (70) | burst 105 | 105 x 200 | 74 | 50639 / 73943 | same | 1.4 | 70 | 42 (26) |
| unset (70) | burst 210 | 140 x 200, 70 x 504 `PGRST003` | 99 | 51138 / 98650 | 95510 / 98675 | 1.4 | 70 | 99.8 (61) |
| unset (70) | 4/s x 120 s | 290 x 200, 190 x 504 `PGRST003` | 205 | 61639 / 101078 | 69068 / 103628 | 1.4 | 70 | 92.4 (190) |
| 140 | burst 210 | 140 x 200, 55 x 504 `PGRST003`, 15 client | 99 | 97226 / 98709 | 98005 / 98710 | 1.4 | 140 | 99.9 (61) |
| 140 | burst 420 | 170 x 200, 116 x 504 `PGRST003`, 106 x 504 uncoded, 28 client | 194 | 98122 / 187816 | 100856 / 193875 | 0.9 | 140 | 91.5 (158) |
| 140 | 4/s x 120 s | 254 x 200, 77 x 504 `PGRST003`, 44 x 504 uncoded, 105 x 503 `PGRST002` | 211 | 87156 / 125077 | 98294 / 127003 | 1.2 | 140 | 92.6 (210) |
| 200 | burst 300 | 0 x 200, 200 x 504 uncoded, 51 x 504 `PGRST003`, 49 client | 125 | 125304 / 125407 | - | 0 | 200 | 99.8 (124) |
| 200 | burst 600 | 0 x 200, 200 x 504 uncoded, 138 x 504 `PGRST003`, 262 client | 240 | 125274 / 240013 | - | 0 | 200 | 99 (188) |
| 200 | 4/s x 120 s | 0 x 200, 400 x 504 uncoded, 80 x 504 `PGRST003` | 292 | 125062 / 172343 | - | 0 | 200 | 100 (233) |

- **Waiting statements: a pool at or above the concurrent requests turned
  queueing into 3 s answers.** At 40/s of 3 s sleeps (about 120 in flight)
  the unset pool of 70 answered every request 200 but at p50 45 s and p95
  85 s, completing 23 per second (70 / 3 s = 23.3); 140 and 200 answered at
  p50 3045 ms, 39 per second (the offered rate, less the run's ramp). No
  `PGRST003` at 70 even with requests waiting over 60 s, the 6 x
  acquisition-timeout wait of DC01b. Postgres was idle in the open loops
  (node CPU 0.9 to 1.5 % over 71 to 197 s windows; 0 to 1 `authenticator`
  on CPU).
- **CPU-bound statements: a larger pool made it worse, and at 200 no request
  succeeded.** At 70, 70 `authenticator` backends were active with no wait
  event at once (the module's 'on CPU'; 8 vCPUs, so most waited for a core;
  node CPU 92.4 to 99.8 % except 42 % in the 26 s burst-105 window), 200s
  came at 1.4 per second, and the excess got `PGRST003`. At 140, 140 were on
  CPU, requests took longer (p50 of the 200s about 98 s, client time
  including the wait for a connection; statement time was not recorded), and
  two new answers appeared: 504 without a PostgREST code, body `upstream
  request timeout`, and 503 `PGRST002`. At 200, 200 were on CPU and every
  answer that came back was an error: the uncoded 504s arrived at about 125
  s (row p50 125062 to 125304 ms), so the timeout that produced them sits
  near 125 s; the body and the time match DC12d's Envoy `upstream request
  timeout` (about 125 s, `x-envoy-attempt-count: 1`), and DC14 kept no
  headers, so the match rests on body text and timing. Whether the statement
  kept running in Postgres after its 504 was not measured here; node CPU
  stayed at 99 to 100 % in those rows. DC17 (later run the same day, section
  above, Small, `pg_sleep`) measured the 504 at 125 s with Envoy's headers,
  and that each of its own 504'd POST statements ran to its end and
  committed; DC14's CPU-bound statements were not followed.
- Throughput ceiling, reasoned: 8 vCPUs at one 3 s statement each is about
  2.7 statements per second; the best measured was 1.4 per second (200s
  over wall time, including the drain). The vCPU-to-core mapping and the
  per-statement cost under contention were not read, so the gap is not
  explained.
- **`PGRST002` appeared without `db_pool` exceeding `max_connections`**
  (140 of 380, 144 client backends at most): 105 of 480 requests in the
  140 CPU open loop. DC02 and DC15 saw it with the pool above
  `max_connections`. Here it came with all cores busy; the schema-cache
  query timing out under CPU saturation fits, not checked in the PostgREST
  log.
- **Client-side failures** (status 0, Bun's `Unable to connect. Is the
  computer able to access the url?`, the first one's text): in every burst
  at pool 140 and 200 (210 to 600 requests), none in the unset pool's
  bursts of 105 and 210, none in any open loop. They are this Mac's connection
  failures, not server answers; the 600-request CPU burst's 262 also
  include the 240 s client timeout (only the first error's text is kept,
  so the split is not recorded). Not investigated.
- Not measured: CPU statements between 3 s and the 125 s timeout at other
  pool sizes or rates; a pool below 70; the gateway timeout's exact value
  and owner (measured later the same day by DC17, section above);
  statements that both compute and wait; another vantage.

### DC15 - a set `db_pool` across a resize (two projects, one run each)

Two projects in separate processes, both created Small in ap-southeast-1
and deleted by their DC99. Published: custom arm
`out/2026-10-26/run-2026-10-26T00-24-41-341Z.json` (10 results), control
arm `out/2026-10-26/run-2026-10-26T00-37-13-794Z.json` (8 results). Each
"read" is one GET `/postgrest`, `pgrst_db_pool_max` scraped every 5 s for
90 s, and two bursts of K concurrent 12 s `dc_sleep_xl` calls with the
mid-burst (6 s) count of `authenticator` backends in PgSleep.

| Step | custom: `db_pool` read | custom: `pgrst_db_pool_max` | custom: PgSleep mid-burst (K) | custom: outcomes per burst | control: `db_pool` / max / PgSleep (K) |
| --- | --- | --- | --- | --- | --- |
| Small (90) | 45 after PATCH | 45 | 45 / 45 (70) | 70 x 200, both | null / 30 / 30, 30 (70) |
| Large (160) after resize | 45 | 45 | 45 / 45 (70) | 70 x 200, both | null / 50 / 50, 50 (70) |
| Large, custom PATCHed to 120 | 120 | 120 | 120 / 120 (150) | 149 x 200 + 1 client error; 150 x 200 | null / 50 / 50, 50 (150) |
| Small (90) after resize | 120 | 120 | no row (150) | 84 x 200 + 66 x 503 `PGRST002`, both | null / 30 / 30, 30 (150) |

- **A set `db_pool` survives a resize in both directions.** 45 set on Small
  read 45 on Large, and Postgres saw 45 (Large's unset value is 50, control
  and DC01). 120 set on Large read 120 on Small, and `pgrst_db_pool_max`
  read 120 there. Nothing clamped it to the new `max_connections` and the
  resize PATCH answered 200 (its body was not recorded, so whether it
  carried a warning is unknown).
- **On Small with `db_pool` 120, each burst of 150 got 84 x 200 and 66 x
  503 `PGRST002`** (PostgREST's "Could not query the database for the
  schema cache. Retrying.", as DC02's pool-1000 arm on Large). 84 is about
  `max_connections` 90 less the other roles' backends (after the bursts 3
  client backends belonged to other roles: `pgbouncer`, the Management
  API's `postgres`, `supabase_admin` exporter; reserved superuser slots
  were not read), so a fit, not a measured identity. The mid-burst Management API query returned no row
  in both bursts (status and error not recorded), so the backend count at
  the peak was not observed. After the bursts: 4 of 90 client backends, a
  Management query answered 201, 5 good Data API pings within 4 s.
- **The control arm repeats DC01**: unset reads null and follows the size,
  30 / 50 / 50 / 30, and on Small a burst of 150 gave 130 x 200 and 20 x
  504 (both bursts).
- Resizes: custom Small to Large settled 53 s after the PATCH (1 of 60 watch
  pings failed, HTTP 521 from the edge), Large to Small 92 s (0 of 60);
  control 70 s and 50 s (0 of 60 each). No add-on 429 on either project.
- Two earlier control-arm attempts failed before any read and are not
  published: the first because a fresh project's first `POST
  /auth/v1/admin/users` answered 500 and `lib/dc.ts` did not retry it (it
  does now, 6 tries 10 s apart), the second on a bug in that retry (a
  `Response` with status 0, which Bun rejects). Both projects were deleted
  by DC99 (DELETE 200).

### Cost and teardown

Main project: requested 00:24:26 UTC, Small to about 00:31, XL to about
00:35, 2XL from then until deleted at 01:42:50 UTC (about 68 minutes at 2XL;
the size boundaries are from the console, the run stamps and DC13's settle
times, not exact). The deletion came after realtime-surface RT05 (01:21:52
to 01:33:06 UTC) and was done with `lib/cleanup.ts --delete` under the run's
`pvlab-dc` prefix (DELETE 200); list mode then showed 0. DC15 custom:
00:24:41 to 00:36:44 UTC, Small and Large. DC15 control: three projects in
turn, the two failed attempts (00:24:56 to 00:27:12 and 00:28:01 to 00:28:07
UTC, stamps of the unpublished artifacts) and the published run (00:37:13 to
00:48:10 UTC), Small and Large. At the compute page's hourly rates (2XL
$0.562, XL $0.2877) that is about $0.65 of 2XL and under $0.10 for the rest;
how billing rounds partial hours was not checked.

## 2026-10-23 - DC08, in-region clients and an application-like mix on 4XL (one run)

Harness: `make run ONLY=DC08,DC99` with `PVLAB_DC_REGION=ap-northeast-2`
and `PVLAB_DC_SIZE=small`, lab commit 235cac8 plus the uncommitted DC08
module and generator. One Pro-org project, created Small, resized to 4XL
(`ci_4xlarge`) in DC08a, deleted by DC99. Published:
`out/2026-10-23/run-2026-10-23T09-37-44-863Z.json` (13 results) and its
`.facts.md`.

Load generator. The plan named Fly Machines in the region nearest Seoul
(Fly's region list, https://fly.io/docs/reference/regions/, has Tokyo `nrt`
and no Seoul region) or EC2 in ap-northeast-2. Neither
was usable from this lab on the day: flyctl had no login session and the
only Fly token available was scoped to one unrelated app (`apps create`
and `apps list` answered `unauthorized`), and both AWS key pairs answered
`InvalidClientTokenId` to `sts get-caller-identity`. The clients are
therefore Supabase Edge Function invocations of `gen/dc08-gen/index.ts`,
deployed to the project under test and invoked with `x-region:
ap-northeast-2`: every invocation that returned `x-sb-edge-region`
reported ap-northeast-2 (none another region; 1,910 of 2,304 in the
pool-150 arm carried it), the smoke invocation reported `SB_REGION`
ap-northeast-2, and every sampled (1 in 50) Data API response carried a
`cf-ray` from the ICN colo. One invocation is one closed-loop client of 8
workers for one round of 8 s; a step is 6 rounds (48 s), and each round's
invocations are given the same start time (observed starts were up to
16.2 s late), fired from this lab's Mac after a warm-up call per client.
Requested concurrency is clients x 8; the delivered concurrency is lower
(next paragraph).

The generator in this run took the target host from the request body (the
module sent the project's own host). After the run the generator was
changed to target only the project it is deployed in (`SUPABASE_URL`) and
to ignore any host in the request, so a copied deployment cannot be used
as a load relay against a third party; that version has not been run.

Mix, by weight per request, legacy anon key on every request, 100,000-row
`dc_items` (int primary key, md5 text):

| op | weight | request |
|---|---|---|
| point | 50 | `GET /rest/v1/dc_items?id=eq.<random>&select=id,payload` |
| range50 | 15 | `GET /rest/v1/dc_items?id=gte.X&id=lt.X+50&select=id,payload&order=id` (50 rows) |
| rpc | 15 | `POST /rest/v1/rpc/dc08_lookup {"p_id": <random>}` (`language sql stable`, one indexed row as json) |
| insert | 10 | `POST /rest/v1/dc08_events {"item_id", "note"}`, `Prefer: return=minimal` (identity primary key, no secondary index) |
| countExact | 10 | `GET /rest/v1/dc_items?id=gte.X&id=lt.X+10000&select=id,payload&order=id&limit=20`, `Prefer: count=exact` (counts 10,000 rows, returns 20) |

What the generator did not deliver. Invocations failed with 546
`WORKER_RESOURCE_LIMIT` ("Function failed due to not having enough compute
resources"), 503 `BOOT_ERROR` ("Function failed to start"), 429
`RATE_LIMIT_EXCEEDED` ("Too many requests. Re-try the request in 1
seconds.") and, from the Mac, a closed socket (status 0). A failed
invocation was retried while 2 s of its round remained, so a retried
client ran only part of its round. The "clients answered per round" column
is the invocations that returned a result, divided by 6; the requested
figure is the clients column.

### DC08b - ramp on 4XL, `db_pool` unset (pool max 70, `max_connections` 480)

Client side (from the generator):

| concurrency (clients x 8) | clients answered per round | req/s | p50 / p95 / p99 ms | statuses | success | per-client req/s median (min-max) | event-loop lag p99 median / max ms | invocation statuses; retried attempts |
|---|---|---|---|---|---|---|---|---|
| 64 (8) | 3.8 | 989 | 18.6 / 30.7 / 47.2 | 200:38064 201:4775 206:4633 | 1 | 236 (0-411) | 9 / 103 | 200:23 503:14 546:11; 546:23 |
| 128 (16) | 9.5 | 1857 | 19.2 / 31.8 / 47.7 | 200:71386 201:8856 206:8896 | 1 | 184 (0-410) | 4 / 113 | 200:57 503:10 546:29; 503:4 546:62 |
| 256 (32) | 17.2 | 3110 | 19.9 / 34 / 59 | 200:119223 201:15075 206:14984 | 1 | 164 (0-405) | 6 / 168 | 200:103 503:45 546:44; 503:2 546:97 |
| 512 (64) | 34.5 | 3962 | 41.9 / 63.8 / 85.3 | 200:152099 201:18918 206:19162 | 1 | 107 (0-236) | 6 / 100 | 200:207 503:72 546:105; 503:11 546:158 |
| 1024 (128) | 88.8 | 4806 | 125 / 163 / 265 | 200:184737 201:23193 206:22766 | 1 | 58 (0-196) | 9 / 1375 | 200:533 429:2 503:140 546:93; 429:9 503:21 546:158 |
| 2048 (256) | 237 | 5844 | 230 / 312 / 512 | 200:224411 201:28225 206:27896 | 1 | 30 (0-43) | 5 / 627 | 0:11 200:1422 503:52 546:51; none |
| 3072 (384) | 365.7 | 6148 | 273 / 320 / 384 | 200:236259 201:29312 206:29554 | 1 | 25 (0-34) | 2 / 504 | 0:1 200:2194 429:54 503:41 546:14; 429:1372 |

Every op had the same latency within a step; at c=3072 the per-op p50 was
273 to 275 ms (point 273, countExact 275) and p99 381 to 391 ms. 206 is
PostgREST's answer to `count=exact` with a `limit` below the total; 201 is
the insert.

Server side. `authenticator` states are the samples taken during the 48 s
of load (13 per step to c=1024; 5 at c=2048 and above, where the sampling
gaps grew to about 8 s, cause not measured), read through the Management
API. Postgres figures are deltas of `pg_stat_statements`
(`total_exec_time`, `calls`) and `pg_stat_database` (commits plus
rollbacks) divided by that window. The window started about 3 s before the
load and ended after the last invocation returned: the sampling loops,
which stop then, ran to 73-75 s after load start at c=2048 and c=3072 and
to 65 s in the pool-70 arm, so those windows were about 1.5 times the 48 s
of load. Calls and transactions per client request also fall from about 4
and 2 at c=64 to 1.3 and 0.66 at c=3072 (0.48 and 0.24 in the pool-150
arm), which the window alone does not explain (not investigated). Read
these columns as a floor within a step, not as a comparison between steps.
Node CPU is the busy share of `node_cpu_seconds_total` between the step's
first and last metrics scrape; -1 when the counters did not move between
them (the payload did not refresh).

| concurrency | pool snapshots waiting/available/max | `authenticator` active / idle / idle in transaction (range in load) | Postgres exec ms/s | calls/s | xact/s | node CPU % |
|---|---|---|---|---|---|---|
| 64 | 0/2/70 | 0-1 / 9-13 / 0-4 | 258 | 3990 | 1961 | -1 |
| 128 | 0/13/70 | 0-7 / 20-33 / 0-4 | 622 | 8546 | 4253 | -1 |
| 256 | 0/32/70 | 0-6 / 37-71 / 0-16 | 1057 | 12230 | 6025 | -1 |
| 512 | 0/70/70 | 0-14 / 50-71 / 0-14 | 1491 | 14969 | 7377 | -1 |
| 1024 | 0/70/70 | 0-9 / 56-68 / 3-15 | 1256 | 12678 | 6304 | -1 |
| 2048 | 0/70/70 | 0-6 / 49-66 / 2-22 | 777 | 7840 | 3974 | 49.6 |
| 3072 | 0/70/70, then 1078/58/70 from 33 s | 0-7 / 58-64 / 6-13 | 801 | 7995 | 4066 | 29.9 |

From c=512 on, 71 `authenticator` backends were open in every sample (the
pool of 70 plus one; DC05 counted the same extra idle backend).

Readings:

- Throughput rose 27 %, 21 %, 22 % and 5 % per step from c=256 (3,110
  req/s) to c=3072 (6,148 req/s) while p50 went 19.9, 41.9, 125, 230, 273
  ms. Requests in flight, derived as req/s x p50 (a median, so an
  approximation): about 62, 166, 600, 1,340 and 1,680. Above c=512 latency
  grew roughly with the requests in flight, and the last step (c=3072, also
  the stop-rule step) added 5 % for 25 % more requests in flight: it reads
  as a queue in front of a fixed service rate (one step; nothing above
  c=3072 was run).
- That queue showed no sign of being in Postgres. In the samples taken
  during load, at most 14 `authenticator` backends were active; from
  c=256 at least 37 were idle (49 or more from c=512, when all 71 were
  open). Every op, including a `count=exact` over 10,000 rows, had a p50
  within 3 ms of a point read at every step. Executor time was at most
  1,491 ms per second of a window longer than the load (about 0.1 ms per
  call, derived: 1,491 / 14,969 at c=512, 801 / 7,995 at c=3072), on 16
  vCPU.
- The one pool tuple that changed inside a step's load window, first
  scraped 33 s into c=3072 (the 25 s scrape read 0/70/70), read 1,078
  waiting with 58 of 70 available. DC05 measured lags of 1.5 to 41.5 s
  between a change and the payload showing it, so the tuple describes some
  moment between load start and 33 s. Waiting counts queued plus holding
  (DC05), holding is at most 70 - 58 = 12, so at least 1,066 requests were
  queued for a pool connection inside PostgREST while 58 open connections
  were idle. The `authenticator` samples during that step read 0 to 7
  active and 58 to 64 idle (33 s: 0 active, 64 idle; not the same instant
  as the snapshot). That is one snapshot of the waiting-with-free-slots
  pattern on 4XL, during the c=3072 step (6,148 req/s averaged over 48 s).
  It still read 1,078 waiting at 73 s, 25 s after the load ended, when the
  `authenticator` samples read 0 active, 71 idle; the 14
  `queued_with_free_snapshots` in the artifact are 14 scrapes of that one
  tuple (n = 1).
- Whether it was there earlier is not settled. The pool tuple changed
  between steps but within a step's window only once (c=3072). At c=2048
  the node CPU counters moved between the 16 s and 73 s scrapes (49.6 %),
  so the payload refreshed at least once, and the pool tuple after it still
  read 0/70/70; the refresh may have landed after the 48 s of load (DC05:
  one change in 100 s of 1 s scrapes; a fixed period, if any, of at least
  about 40 s). The latency growth with idle backends from c=512 (3,962
  req/s) fits the same queue, and another layer between client and
  PostgREST (the edge, the API gateway) was not instrumented and would
  look the same from here.
- Generator CPU did not look like the limit: event-loop lag p99 had a
  median of 2 to 9 ms per step (max 100 to 1,375 ms), and the per-client
  rate fell as latency rose (25 req/s at c=3072 against 8 workers / 0.273
  s, about 29), so workers mostly waited on answers. Lag does not cover the
  runtime's outbound connections or the Mac's dispatch, which were not
  measured. The generator under-delivered concurrency: failed and late
  invocations; at c=3072, 2,926 answered workers (365.7 x 8, derived)
  against about 1,680 requests in flight. Each step's concurrency label
  therefore overstates the load, and the in-flight estimate (client-side,
  including edge and gateway time) is the closest this run has to the
  delivered load.
- Node CPU read 49.6 % (c=2048) and 29.9 % (c=3072) of 16 vCPU, each across
  one payload refresh at a moment not recorded; which process used it was
  not measured.
- Every answer in the ramp was 200, 201 or 206; no 403 and no 5xx.

### DC08c - `db_pool` arms at c=3072

Each arm: PATCH, wait for the restart line, readback, 20 s, then the
c=3072 step. Order 150, 250, 70; the ramp's c=3072 step (pool 70 with
`db_pool` unset) ran before them.

| `db_pool` (PATCH, readback, restart after) | clients answered per round | req/s | p50 / p95 / p99 ms | statuses | `authenticator` active / idle / idle in transaction (range in load) | pool snapshots (scrapes) | Postgres exec ms/s | invocation statuses; retried attempts |
|---|---|---|---|---|---|---|---|---|
| unset, 70 (ramp) | 365.7 | 6148 | 273 / 320 / 384 | 200:236259 201:29312 206:29554 | 0-7 / 58-64 / 6-13 | 0/70/70, 1078/58/70 (16) | 801 | 0:1 200:2194 429:54 503:41 546:14; 429:1372 |
| 150 (200, 150, 1.8 s) | 299 (void, #234) | 4830 (void, #234) | 281 / 362 / 490 | 200:185881 201:22964 206:22977 | 0-4 / 133-149 / 2-18 | 0/51/150 (4) | 240 | 0:394 200:1794 429:56 503:13 546:47; 429:1749 |
| 250 (200, 250, 1 s) | 360 | 5901 | 278 / 353 / 462 | 200:226689 201:28304 206:28249 | 0-5 / 173-240 / 7-78 | 0/0/250 (5) | 1204 | 200:2160 429:78 503:66; 429:2124 |
| 70 (200, 70, 1.4 s) | 368.8 | 6210 | 274 / 328 / 379 | 200:238435 201:29769 206:29875 502:3 | 0-6 / 51-61 / 5-14 | 0/70/70 (12) | 891 | 0:13 200:2213 429:78; 0:3 429:2716 |

The three 502s in the last arm (1 countExact, 2 rpc): the one body
recorded (countExact) was Cloudflare's page, `502 Bad Gateway` with
`cloudflare` in the footer; the rpc bodies were not kept.

Readings:

- A bigger pool did not lower p50, and pool 250 did not raise throughput.
  p50 was 273, 281, 278 and 274 ms at pool 70 (unset), 150, 250 and 70;
  req/s 6,148, 4,830 (void, host sleep audit below), 5,901 and 6,210. p95 and p99 were higher at 150 and 250 (362 / 490 and
  353 / 462 against 320 / 384 and 328 / 379; one step each). One step per
  arm, no repeats; the two pool-70 steps differ by 62 req/s.
- The pool 150 arm's lower rate came with fewer clients answering (299
  per round against 360 to 369). 394 invocations ended with status 0 on
  the Mac; their error text was not recorded in that arm (the pool-70
  arm's status-0 sample was a closed socket). 394 is about one round of
  384 clients, and the arm's samples stop at 41 s, which fits one lost
  round (derived; the artifact has no per-round split): 4,830 x 6/5 is
  about 5,800 req/s. Its rate measures the generator; its p50 matched the
  other arms. **Host sleep audit (2026-10-26, #234):** two sleeps of the
  orchestrator Mac fell inside DC08, 09:50:15 to 09:53:46 (211 s) and
  09:53:57 to 09:55:10 (73 s) UTC, 750 s and 972 s of wall time after the
  module began; walking the module across them lands 3 s from `finishedAt`
  (`../platform-downtime/out/2026-10-26/host-sleep/overlap.txt`). No step
  has a wall stamp, but about 253 s of the module remained after the second
  wake, room for the last two arms, and the pool-150 arm carries the marks:
  394 status 0 (what in-flight fetches get across a sleep), samples ending
  at 41 s, and Postgres exec at 240 ms/s against 801 to 1204 in the other
  c=3072 steps (a window stretched by a sleep dilutes a per-second rate;
  the lower calls per request is not explained by it). Void: the
  pool-150 arm's req/s, clients answered per round, Postgres exec ms/s,
  calls/s and xact/s. Its p50 / p95 / p99 are timed by the generator in the
  project's region, which a Mac sleep does not pause: unaffected. No other
  step shows those marks (status 0 on at most 13 invocations); unaffected,
  by that reading rather than by placement.
- With more connections, more sat idle: 133 to 149 at pool 150, 173 to
  240 at 250, active 0 to 4 at 150 and 0 to 5 at 250. Idle in transaction
  reached 78 in one pool-250 sample, against at most 22 in any other step.
- None of the arms' pool tuples changed during the step (`0/0/250` is not
  a reading of 250 connections in use: the `authenticator` samples beside
  it read 173 to 240 idle), so whether requests queued for a connection at
  pool 150 or 250 is not shown by the metric. In the pool-70 arm the node
  CPU counters moved (48.1 %), so the payload refreshed at least once
  between the 17 s and 65 s scrapes and still read 0/70/70; when that
  refresh happened relative to the load is not recorded.
- Flat throughput with most connections idle at pools of 70, 150 and 250
  fits a limit in PostgREST that a pool below the requests in flight does
  not lift. Upstream issue #5336
  (https://github.com/PostgREST/postgrest/issues/5336) reports collapse
  growing with cores and a workaround of a pool at least as large as the
  concurrent requests. 250 is below the 1,360 to 1,700 requests in flight
  in these arms (derived, req/s x p50), so that workaround was not
  tested. This run also does not separate a limit in front of PostgREST.
- `db_pool` 250 answered 200 here; DC04d's PATCH to 250 on 4XL answered
  500 (not investigated there or here).

### Not run

- Fly Machines or EC2 clients (unavailable, see above); a generator whose
  delivered concurrency matches the requested one; a client outside the
  Edge Functions runtime to compare against.
- The pool series at a known refresh during c=512 to c=2048; a pool
  reading during the 150 and 250 arms.
- A per-process CPU split between PostgREST, the gateway and Postgres; the
  latency added by each layer between the client and PostgREST.
- Postgres rates over exactly the 48 s of load (the window ran to the last
  returned invocation, up to about 75 s); why calls and transactions per
  request fell at the top steps.
- Authenticated-user JWTs (every request used the anon key), larger
  payloads, writes with indexes or triggers, a mix without `count=exact`.
- Repeats of any step or arm; XL, 2XL, 8XL.

### Cost

Project time about 22 minutes (09:37:44 to 09:59:21 UTC, the artifact's
start and finish stamps): Small for about a minute (console), 4XL after the resize
(settled 81 s after the PATCH, `max_connections` 90 to 480, 0 of 60 pings
failed in the 60 s watch), deleted by DC99 (DELETE 200, gone from the
listing at the first check). Before it, a Small development project in the
same region ran two short DC08 trials for about 9 minutes (console only,
not published) and was deleted with `lib/cleanup.ts --delete`. Edge
Function calls, summed from the artifact's `gen_invocations`,
`gen_failed_attempts` and `clients` columns: 12,240 measured invocations,
8,509 retried attempts and 2,040 warm-up calls. `make clean` afterwards listed 0
`pvlab-dc-` projects (console, not in the artifact).

## 2026-10-23 - DC05-DC07, the pool metrics, aborted connections, pool size under load (one run)

Harness: `make run ONLY=DC05,DC06,DC07,DC99` with
`PVLAB_DC_REGION=ap-northeast-2` and `PVLAB_DC_SIZE=small`, lab commit
661afdf plus the uncommitted DC05-DC07 modules. One Pro-org project, Small
for the whole run (shared CPU per the compute docs, no core count published; `max_connections` 90 was
read by DC04a on the same size, not in this artifact; `db_pool` unset at
creation), deleted by DC99. The artifact's top-level `region`
(ap-southeast-1) is the harness default; the project's region came from
`PVLAB_DC_REGION` and is not recorded in this artifact (DC04a and DC05a
record it as `project_region_requested` from the next run on). Same client
as DC04: this lab's Mac in Singapore; `oha` 1.16.0 for DC07 (console, not
in the artifact's tool versions). The PostgREST version is not recorded in
this artifact (DC04a, same day and region, read 14.18). Metric series are
`pgrst_db_pool_*` from `/customer/v1/privileged/metrics`; "truth" is
`pg_stat_activity` for `usename = 'authenticator'` read through the
Management API query endpoint. Published:
`out/2026-10-23/run-2026-10-23T07-49-11-858Z.json` (17 results) and its
`.facts.md`.

What the two pool series are, from PostgREST v14.18 source (source-read;
Supabase's build is assumed to match the tag, not checked):
`pgrst_db_pool_waiting` goes up when a request asks the pool for a
connection and down when its session returns (`usePool` in
https://github.com/PostgREST/postgrest/blob/v14.18/src/PostgREST/AppState.hs),
so it counts requests queued for a connection plus requests holding one;
its help text, "Requests waiting to acquire a pool connection", describes
only the first part. `pgrst_db_pool_available` is connections opened minus
connections in use (`calcAvailable` in
https://github.com/PostgREST/postgrest/blob/v14.18/src/PostgREST/Metrics.hs),
so open idle pool connections.

### DC05a - how often the metric series change

1 s scrapes for 100 s while held `dc_sleep_xl` requests stepped 0, 5, 15,
25, 0 every 20 s (holds of 18 s), truth about every 2.5 s.

| measured | value |
|---|---|
| scrapes | 100 (0 failed) |
| distinct waiting/available/max tuples | 2: `0/1/30` from 0 s to 60 s, `25/0/30` from 62 s to 99 s |
| changes | 1 |
| lag from each step (5, 15, 25, 0 held) to the first changed scrape | 41.5, 21.5, 1.5, -1 (none) s |
| response headers (first scrape only) | `cf-cache-status=DYNAMIC`, `date` current |
| truth, authenticator total/in PgSleep/idle | 2/0/2 to 20 s; 6/5/1 from 22 s; 16/15/1 from 41 s; 16/0/16 at 58 s; 26/25/1 from 61 s; 26/0/26 from 81 s |

Reading: the series moved once in 100 s while the truth moved five times.
No refresh landed between about 22 s and 58 s (the 5- and 15-held states
never appeared) or between 81 s and 99 s (the 25-held state was still
shown 18 s after the holds ended). The step lags in the table are all the
one change at 62 s, measured from different starts. The endpoint answered
`DYNAMIC` with a current `date` on the first scrape, so the staleness sits
behind the edge. If the payload refreshes on a fixed period, that period is
at least about 40 s; no upper bound was measured.

### DC05b - what the series read, against pg_stat_activity

10 then 40 requests held for 30 s on a pool of 30; five scrapes 1.5 s apart
from 12 s into the hold, truth at the third.

| held | scrapes (waiting/available/max) | truth total / in PgSleep / idle | "available" if it meant open idle / max minus checked out | hold outcomes |
|---|---|---|---|---|
| 10 | `25/0/30` x4, then `10/15/30` | 26 / 10 / 16 | 16 / 20 | 200:10 |
| 40 | `10/15/30` x5 | 31 / 30 / 1 | 1 / 0 | 200:40 |

Readings, against the source definitions above (three snapshots that line
up with a known state):

- `available` read 15 with 10 held (16 idle `authenticator` backends), 0
  with 25 held (DC05a, 62 s; 1 idle) and 1 at rest (DC05a, 0 s; 2 idle).
  That agrees with open idle pool connections; max minus checked out would
  have read 20, 5 and 30. In those three, one idle `authenticator` backend
  was not counted, which fits a connection outside the pool (PostgREST's
  listener; not identified).
- `waiting` read 25 with 25 held and 10 with 10 held on a pool of 30 where
  nothing queued: the holders alone, as queued-plus-holding predicts. DC07
  pool 15 at c=128 read 31 waiting on a pool max of 15, so it does include
  queued requests when there are some.
- The 40-held row is the 10-held snapshot, still being served; the queued
  state (30 in PgSleep, 10 waiting for a connection) was never scraped.

### DC05c - pool max after a db_pool PATCH

| PATCH | status | restart line after | `pgrst_db_pool_max` read the new value after |
|---|---|---|---|
| `db_pool` 20 (from unset, 30) | 200 | 1.2 s | 1.4 s (first scrape) |
| `db_pool` 30 | 200 | 1 s | 28.9 s (22 scrapes) |

Reading: the PATCH restarted PostgREST within about 1 s both times; the
metric followed after 1.4 s once and 28.9 s the other time. The 1.4 s case
needs a refresh in the 0.2 s after the restart line, so a competing reading
is that a restart resets or refreshes the payload; not separated. Either
fits DC04d, where each arm read the previous arm's pool.

### DC06 - statement timeouts from a lock, then the pool

20 workers looping anon GETs on `dc_items` (anon `statement_timeout` 3 s,
measured by DC03a in an earlier run on another project, not in this
artifact); `begin; lock table public.dc_items in access exclusive mode;
select pg_sleep(N); commit;` through the Management API; 75 s observed
after the lock; `authenticator` states every 5 s. Control (2 s) ran first.
One run per arm. The pool was 30 (DC05c's last PATCH) against 20 workers,
so no request waited for a pool connection: a cancellation while queued
for the pool was not exercised.

| lock asked / held | before | during (to 4 s after the lock) | after (4 s to 75 s after) | 25P02 after | most `idle in transaction (aborted)` seen | requests |
|---|---|---|---|---|---|---|
| 2 s / 2.7 s | 200:2034 | 200:664 | 200:9857 | 0 | 0 | 12555 |
| 12 s / 12.6 s | 200:2050 | 200:643, 500 57014:60 | 200:9920 | 0 | 0 | 12673 |

States sampled in the 12 s arm: `active:20 idle:1` twice during the lock,
`idle:21` from 1.4 s after it, with at most 2 `idle in transaction` (not
aborted) in any later sample.

Reading: 60 requests were cancelled by anon's statement timeout while
waiting on the lock, and none of the pooled connections they used was left
aborted: every request from 4 s to 75 s after the lock answered 200, and no
sample showed an aborted backend. The competing hypothesis in the module
header stays open: a stall where Postgres stops as a whole (cancellations
landing at a different protocol step) was not made, since this lab has no
way to SIGSTOP Postgres on a managed project.

### DC07 - db_pool 15, 30, 60 on Small under closed-loop load

Each arm: PATCH, wait for the restart line, 30 s settle, then the DC04 step
(`oha`, 40 s, one indexed point read `GET
/rest/v1/dc_items?id=eq.4242&select=id,payload`, anon key) at 128, 256,
512 concurrent, 20 s apart. Success is 200s over all attempts, client-side
errors included.

| `db_pool` (restart after PATCH) | concurrency | req/s | p50 / p99 ms | success | waiting max (available then, of max) | `authenticator` mid-step | client errors | client load1 |
|---|---|---|---|---|---|---|---|---|
| 15 (1.1 s) | 128 | 814 | 147 / 422 | 1 | 31 (1 of 15) | idle:12 idle in transaction:4 | none | 8.8 |
| 15 | 256 | 853 | 288 / 667 | 1 | 0 (15 of 15) | idle:15 idle in transaction:1 | 1 connection closed | 12.9 |
| 15 | 512 | 863 | 615 / 1073 | 0.992 | 0 (15 of 15) | idle:16 | 280, 262 of them os error 51 | 11.7 |
| 30 (1.5 s) | 128 | 834 | 147 / 376 | 1 | 0 (0 of 30) | idle:28 idle in transaction:1 | none | 4.9 |
| 30 | 256 | 902 | 281 / 470 | 0.998 | 0 (28 of 30) | idle:28 idle in transaction:1 | 60 timeouts | 3.6 |
| 30 | 512 | 878 | 618 / 863 | 0.985 | 0 (28 of 30) | idle:27 idle in transaction:2 | 516, 478 of them os error 51 | 4.2 |
| 60 (1.3 s) | 128 | 836 | 147 / 348 | 1 | 0 (0 of 60) | idle:35 | none | 3.7 |
| 60 | 256 | 909 | 277 / 579 | 1 | 0 (34 of 60) | idle:31 idle in transaction:4 | 17 timeouts | 4.2 |
| 60 | 512 | 868 | 615 / 940 | 0.993 | 0 (34 of 60) | idle:34 idle in transaction:1 | 238, 165 of them os error 51 | 3.6 |

Every `db_pool` PATCH answered 200 and read back the value set. Every
answer in every step was a 200; the failures are client-side (`Network is
unreachable (os error 51)`, timeouts, closed connections). Node CPU was not
computed in any step (-1): the CPU counters on the metrics endpoint did not
change across any step's scrapes. The pool columns are snapshots (DC05).

Readings:

- Pool size made no difference this run can separate. Pool 15 / 30 / 60
  gave 814 / 834 / 836 req/s at 128, 853 / 902 / 909 at 256 and
  863 / 878 / 868 at 512. The same configuration measured twice (DC04b,
  default pool 30, against this run's pool 30) differed by 9, 23 and 40
  req/s at 128, 256 and 512, against 56 req/s between pool 15 and 60 at
  256. One step per cell, no repeats; the pool 15 arm also ran with the
  Mac's load1 at 8.8 to 12.9 against 3.6 to 4.9 in the others.
- The same Mac reached 1699 req/s at 256 and 3158 at 512 against a 4XL
  (DC04c, same day). The Small ceiling here is about the DC04b figure (925
  at 256), with latency doubling per step as there.
- Mid-step, most `authenticator` backends were idle at every pool size, and
  the 60 pool never showed more than 35 `authenticator` backends. Which
  process used the node's CPU was not measured.
- Upstream PostgREST issue #5336
  (https://github.com/PostgREST/postgrest/issues/5336) reports throughput
  collapsing when requests wait for a pool connection, growing with
  PostgREST's cores: mild at 2 cores (5,714 req/s, 293 us per request in
  its table), collapsing at 8 and 16; its pool 20 against 200 contrast was
  on 4 cores. Its workaround is a `db-pool` at least as large as the number
  of concurrent requests; the fix it points to is hasql-pool PR #58
  (https://github.com/nikita-volkov/hasql-pool/pull/58). On a shared-CPU Small
  with Postgres, flat throughput across pool sizes is consistent with the
  issue's small-core rows. Whether requests queued for a connection at all
  in the 30 and 60 arms is not established (the pool series are snapshots).

### Not run

- A pool metric refresh interval measured directly (a longer 1 s scrape
  window across several refreshes); a scrape of `waiting` while requests
  are known to queue for a connection.
- A per-process CPU split between PostgREST and Postgres; node CPU in
  DC07 (not computed, see above).
- DC07 on a size with more vCPU, or with requests that hold a connection
  longer than a point read, where waiting for a connection is certain;
  DC07 from a client whose load stays level across arms.
- For DC06: a whole-instance stall; a pool smaller than the workers, so a
  request is cancelled while queued; the authenticated role's 8 s timeout;
  RPC or write requests under cancellation.
- Repeats of any row.

### Cost

Project time about 21 minutes (07:49:11 to 08:09:57 UTC, the artifact's
start and finish stamps), Small throughout, deleted by DC99 (DELETE 200,
gone from the listing at once). `make clean` afterwards listed 0
`pvlab-dc-` projects (console, not in the artifact).

## 2026-10-23 - DC04, request rate instead of request duration (one run)

Harness: `make run ONLY=DC04,DC99` with `PVLAB_DC_REGION=ap-northeast-2`
and `PVLAB_DC_SIZE=small`, lab commit 4141477 plus the uncommitted DC04
module. One Pro-org project, Small, resized to 4XL (`ci_4xlarge`) in DC04c,
deleted by DC99. Load generator: `oha` 1.16.0, closed loop, 40 s per step,
one GET `/rest/v1/dc_items?id=eq.4242&select=id,payload` (indexed point read
on a 100,000-row table) with the legacy anon key, from this lab's Mac in
Singapore, so every latency includes the Singapore-Seoul round trip (p50 141
to 150 ms at low load). Pool series are `pgrst_db_pool_*` read from
`/customer/v1/privileged/metrics` every 3 s; node CPU from
`node_cpu_seconds_total`; `authenticator` states read once mid-step through
the Management API query endpoint. Published:
`out/2026-10-23/run-2026-10-23T07-13-34-754Z.json` (19 results) and its
`.facts.md`.

### DC04a - what the metrics endpoint exposes

9 `pgrst_*` series: `pgrst_db_pool_available`, `pgrst_db_pool_max`,
`pgrst_db_pool_timeouts_total`, `pgrst_db_pool_waiting`, three JWT cache
series and two schema cache series. Small: pool max 30, `db_pool` null,
`max_connections` 90, `application_name` "PostgREST 14.18". 4XL (DC04c
resize, settled 68 s after the PATCH): `max_connections` 480, `db_pool`
null, pool max 70.

### DC04b - Small (shared CPU)

| concurrency | req/s | p50 / p99 ms | success | waiting max (available then, of max) | timeouts | node CPU % | `authenticator` mid-step | client errors |
|---|---|---|---|---|---|---|---|---|
| 16 | 108 | 143 / 374 | 1 | 0 (1 of 30) | +0 | -1 (not computed) | idle:7 | none |
| 32 | 214 | 144 / 345 | 1 | 1 (5 of 30) | +0 | 9.5 | idle:7 | none |
| 64 | 428 | 145 / 334 | 1 | 1 (5 of 30) | +0 | 21.7 | active:1 idle:18 | none |
| 128 | 825 | 149 / 370 | 1 | 7 (11 of 30) | +0 | 49.1 | idle:16, idle in transaction:3 | none |
| 256 | 925 | 269 / 526 | 1 | 139 (11 of 30) | +0 | 73.9 | idle:16, idle in transaction:3 | 2 |
| 512 | 918 | 547 / 1039 | 0.993 | 139 (11 of 30) | +0 | -1 | idle:27, idle in transaction:4 | 277 |
| 1024 | 1020 | 1110 / 1748 | 0.872 | 0 (30 of 30) | +0 | -1 | idle:22, idle in transaction:9 | 5,323 |

Reading: from 256 on, throughput stopped at about 920 to 1,020 req/s while
latency doubled per step, and at 256 the pool reported 139 requests
waiting while 11 connections were available, timeouts flat, and the
`authenticator` backends idle. That is the waiting-with-free-slots pattern,
on Small (shared CPU), with node CPU at 73.9 %. Postgres and PostgREST share that node,
so node CPU does not say which process used it; no per-process figure was
read. The 512 row repeats the 256 row's pool figures exactly and the 1024
row reads 0 waiting with every slot available while 12.8 % of requests
failed on the client; the pool series appear to update less often than the
3 s scrape (a reading, not separated). Treat the pool columns as coarse.

2026-10-23, after DC05: `pgrst_db_pool_waiting` counts requests queued for
a connection plus requests holding one (PostgREST v14.18 source), and the
pool columns are snapshots that change at most about every 40 s. The 139
waiting / 11 available pair was one snapshot: the 256 step's waiting median
was 7, and the 512 step showed 139 / 11 on all 12 scrapes. If that snapshot
is internally consistent, 139 includes at most 30 holders, so at least 109
requests were queued while 11 open connections sat idle. Node CPU 73.9 % is
the change between two payload refreshes, not the whole step.

### DC04c - 4XL (16 vCPU)

| concurrency | req/s | p50 / p99 ms | success | waiting max (available then, of max) | node CPU % | `authenticator` mid-step | statuses | client errors |
|---|---|---|---|---|---|---|---|---|
| 64 | 436 | 141 / 365 | 1 | 0 (1 of 70) | -1 | idle:10 | 200:17521 | none |
| 128 | 860 | 143 / 339 | 1 | 0 (1 of 70) | 2.2 | idle:10 | 200:34810 | none |
| 256 | 1699 | 144 / 355 | 1 | 1 (10 of 70) | 5 | active:1 idle:11 | 200:68773 | 1 |
| 512 | 3158 | 150 / 457 | 0.996 | 1 (10 of 70) | 11.5 | active:1 idle:31 | 200:127297 | 456 |
| 1024 | 2243 | 164 / 2162 | 0.837 | 0 (66 of 70) | 11.5 | idle:67 | 200:75566 403:6804 | 16,018 |
| 1536 | 539 | 801 / 4460 | 0.375 | 0 (66 of 70) | 0.1 | idle:67 | 403:8856 | 14,729 |

Reading: on 16 vCPU the same request scaled linearly to 3,158 req/s at 512
with nothing waiting and node CPU at 11.5 %. The pattern DC04b met on Small
did not appear up to that rate. Above 512 the run stopped measuring
PostgREST: the client logged "Network is unreachable (os error 51)" on
thousands of requests, and from 1024 the answers that came back included
HTTP 403 (6,804 at 1024, every answer at 1536), with node CPU falling to
0.1 %. The 403 body was not recorded, so which layer sent it is not
established. These two rows describe this client and the edge in front of
the project, not PostgREST.

2026-10-23, after DC05: "nothing waiting" above means a waiting max of 1
(median 1, 10 of 70 available) at 256 and 512, read from snapshots (DC05).
Node CPU read 11.5 % at both 512 and 1024, which fits one stale refresh
window spanning the two steps.

### DC04d - db_pool arms on 4XL (not usable)

`db_pool` 20 (PATCH 200), 150 (PATCH 200) and 250 (PATCH 500), each
followed by the 1024 step. The first two returned 531 and 548 req/s, 403
only, with one `authenticator` backend; the 250 arm returned 2,749 req/s
(98,340 x 200, 4,347 x 403). The pool max read in each arm was the value
from the arm before (70, then 20, then 150), so the reading lagged a PATCH.
The arms ran behind the same client and edge limit as DC04c's top rows and
compare nothing about pool size; the 500 on `db_pool` 250 was not
investigated.

### Not run

- Load above about 3,000 req/s from a vantage that is not one Mac (several
  clients, or clients in-region).
- Any request other than one indexed point read: RPCs, inserts, wide
  responses, `Prefer: count=exact`, a high `max_rows`.
- A per-process CPU split between PostgREST and Postgres.
- The `db_pool` comparison, which needs the above before it means anything.
- XL and 2XL/8XL, between the two sizes measured.

### Cost

Project time about 18 minutes (07:13:34 to 07:31:20 UTC, the artifact's
start and finish stamps), Small until DC04c and 4XL after, deleted by DC99
(DELETE 200).

## 2026-10-22/23 - four runs (run 4 is the reference)

Harness: `make run` (DC01, DC02, DC03, DC99, `--destructive`), lab commit
3a2f9bd plus the uncommitted tree that adds this experiment. All figures
below are run 4 unless a run is named. Published (redacted):

- run 1 `out/2026-10-22/run-2026-10-22T23-02-55-371Z.json` (13 results)
- run 2 `out/2026-10-22/run-2026-10-22T23-43-28-093Z.json` (10 results)
- run 4 `out/2026-10-23/run-2026-10-23T00-37-06-485Z.json` (14 results)

each with a `.facts.md`. Run 3 died in DC02 on an unhandled `ECONNRESET`
from `api.supabase.com` (a `PATCH /postgrest` inside the ping sampler) and
wrote no artifact; its project was deleted with `make clean DELETE=1` at
about 00:36 UTC (console time, not in an artifact). Its console output is
not cited for any figure.

What changed between runs, and why the earlier rows are not used where run 4
differs:

- Run 1 sent PostgREST config PATCHes without waiting for the restart each
  one causes and did not record PATCH times. Its DC02d row (the restart
  count; run 4 moved it to DC02e) lists six "Starting PostgREST" lines from
  23:09:56 to 23:35:05 UTC. Where DC02 began and ended in run 1 is not fixed
  by the artifact: the module durations (DC01 419046 ms, DC02 650760 ms,
  DC03 332782 ms, DC99 1398 ms) add up to about 1404 s, against 2295 s
  between the run's start and finish stamps. Three of run 1's rows look like
  restart overlaps: DC02b at timeout 4 s (0 holders sleeping at probe time),
  DC02c (`db_pool` 1000 burst: 218 of 220 requests ended on the client with
  "The socket connection was closed unexpectedly") and the DC03a anon row
  (client errors at 18.1 s, no error text recorded). DC02 now waits for the
  restart log line after every PATCH and records the delay (`waitRestart`),
  and run 4's DC02d measures a restart's effect on purpose.
- Run 2: DC01c settled 41 s after the resize PATCH; the next row is a
  module-level DC01 failure, "threw: The operation timed out." (DC01d did not
  report), then DC02 could not measure the pool, and DC03's first calls
  failed at once on the client (status 0, 0.0 s, no error text recorded)
  until one hung for 78.6 s. DC01c now watches the Data API for 300 s after
  settling, and DC03 waits for 10 consecutive good pings before it starts.
- From run 4 every Data API request is sent with `keepalive: false` (a fresh
  connection per request), and PATCH and logs calls catch client-side
  network errors. The client-side failures before that: run 1, "The socket
  connection was closed unexpectedly" on 218 of 220 DC02c requests; run 2,
  status 0 with no text recorded; run 3, an `ECONNRESET` from
  `api.supabase.com` (console only). The first and third match a client
  reusing a pooled socket the server had closed; that is a reading of the
  client side; no separating probe was run. Run 4 still has status-0 rows (listed
  where they occur) whose error text was not recorded.
- Module durations do not add up to the wall clock in runs 2 and 4 either:
  561029 ms against 800 s, and 2323221 ms against 2419 s. The cause is not
  separated. **Separated by the host sleep audit (2026-10-26, #234):** in all
  three runs the difference is the orchestrator Mac asleep.
  `harness/scripts/sleep-overlap.ts` against the sleep log
  (`../platform-downtime/out/2026-10-26/host-sleep/overlap.txt`, from the
  trimmed `pm-events.tsv` beside it) places 4 sleeps (898 s) inside run 1's
  DC02, 2 (244 s) in run 2 and 1 (97 s) inside run 4's DC02; walking each
  run's modules forward across them lands 2 to 7 s from `finishedAt`. By
  figure:
  - Run 4, the reference: unaffected. Its sleep (01:10:01 to 01:11:38 UTC)
    began after DC02d's second ping window had ended (restart line
    01:08:48, 55.3 s after that PATCH, so the 120 s window ran to about
    01:09:53) and before DC02e's log read, a line count with no timing.
  - Run 1: DC01 and DC03 spanned no sleep, so the run-1 figures quoted in
    DC01 stand, and the DC03a anon row's client errors at 18.1 s stay
    unexplained. In DC02 the fourth restart line (23:17:00) is the
    timeout-4 s PATCH and the first sleep began at 23:17:28; that row's two
    probes answered 200 after 261 ms with 0 holders sleeping, which fits the
    holders having finished while the Mac slept. Void: the run-1
    timeout-4 s row. DC02c's `db_pool` 1000 burst went out with its PATCH,
    about 6 s after the 23:29:09 dark wake that ended a 262 s sleep
    (restart line 23:29:15; restarts came 0.5 to 0.9 s after a PATCH); the
    next sleep began 55 s later, at 23:30:10. Its 218 closed sockets fit a
    restart overlap or pooled sockets the server closed during that sleep;
    not separated.
  - Run 2: DC01's sleep (23:48:34 to 23:50:58) began 306 s into a module
    that ran 309 s of monotonic time, after DC01a to DC01c had reported, so
    "The operation timed out." came right after the wake; DC01b (61972 /
    61795 ms) and DC01c (41 s) came before the sleep and stand. DC03's sleep
    (23:51:08 to 23:52:48) began 1 s into DC03, beside its first calls'
    status 0 at 0.0 s (a reading; the 78.6 s hang is not placed). DC02 (6
    s, 23:51:00 to 23:51:06) ran inside the 10 s dark wake between the two
    sleeps, which fits its failure to measure the pool (a reading). DC03d
    came later in the module, after DC03's only sleep had ended: its run-2
    result (the same as run 4, DC03 table) stands.
  - Run 3 wrote no artifact and its console times were not kept; between
    run 2's finish (23:56:48) and run 3's project deletion (about 00:36
    UTC) the sleep log has four sleeps, 00:24:39 to 00:36:13 UTC. Whether
    run 3 was still running at any of them, and whether its `ECONNRESET`
    came at a wake, is not known.

### DC01 - default pool and the default wait for PGRST003

Docs (Management API spec, `V1UpdatePostgrestConfigBody` and the GET
response): `db_pool` "If `null`, the value is automatically configured based
on compute size"; `db_pool_acquisition_timeout` "If `null`, ... configured to
10". PostgREST docs: a request waits for a pooled connection until
db-pool-acquisition-timeout, then answers 504 PGRST003.

| row | measured |
|---|---|
| DC01a Small, `GET /postgrest` | `db_pool` null, `db_pool_acquisition_timeout` 10 (a number, not null); `max_connections` 90 |
| DC01a Small, pool | 30 `authenticator` backends in `PgSleep` mid-burst, both bursts of 100 (runs 1, 2 and 4: 30 / 30 each) |
| DC01a Small, burst outcomes | 100 + 100 of 200 answered 200, 0 PGRST003 (12 s sleeps, so the queue drained in waves of 30 within the wait described in DC01b) |
| DC01b Small, pool held, two single requests (service_role key) | 504 PGRST003 after 61364 ms and 61972 ms; each request's User-Agent appears on 6 PostgREST access-log lines, all 504 (run 1: 61343 / 61493 ms, run 2: 61972 / 61795 ms, 6 lines each) |
| DC01c resize Small to Large | `PATCH /billing/addons` 200; `max_connections` 160, ACTIVE_HEALTHY and 5 good pings 66 s after the PATCH (run 1: 66 s, run 2: 41 s); the next 300 s of 1 s pings: 0 of 300 failed |
| DC01d Large, pool | 50 / 50 mid-burst, bursts of 140 (run 1: 50 / 50); `db_pool` still null, timeout 10, `max_connections` 160 |

Reading (no separate probe): 6 access-log lines for one client request
means PostgREST received that request 6 times in total, so something between
the client and PostgREST sends the request again after a PGRST003, and a
request that never gets a connection waits about 6 x the acquisition timeout
before the client sees the 504. DC02b shows the same factor at 2 s and 4 s.
The component and its policy are not identified.

### DC02 - changing the pool settings

| row | measured |
|---|---|
| DC02a `db_pool` 70 (default 50 + 20) | PATCH 200, PostgREST restart logged 0.7 s after, readback 70; 0 of 357 pings (250 ms apart) failed in 90 s; mid-burst pool 70 with 110 requests |
| DC02a `db_pool` 90 | PATCH 200, restart 0.7 s after, readback 90; 0 of 358 pings failed; mid-burst pool 90 with 130 requests (129 answered 200, 1 status 0 on the client) |
| DC02b acquisition timeout 2 s, pool held (90 of 90 sleeping), two single requests (service_role key) | 504 PGRST003 after 13767 and 13752 ms, 6 PostgREST lines each (504:6) |
| DC02b acquisition timeout 4 s, pool held (90 of 90 sleeping), two single requests | request 1: 504 PGRST003 after 25007 ms, 6 lines (504:6). Request 2: status 0 at the client's 105001 ms timeout and 0 PostgREST lines; not explained. The 4 s figure is n = 1 |
| DC02c bounds sent | `db_pool` 1001: 400 `db_pool: Too big: expected number to be <=1000`; `db_pool` -1: 400 `db_pool: Too small: expected number to be >=0`; acquisition timeout 61: 400 `db_pool_acquisition_timeout: Too big: expected number to be <=60`. A 0 for either was not sent |
| DC02c control: `db_pool` PATCHed back to 50 (and timeout 10) just before, then 220 concurrent 15 s sleeps | 150 answered 200, 70 answered 504 PGRST003 between 10923 and 20903 ms (median 20855); mid-burst pool 50 |
| DC02c `db_pool` 1000 on Large (`max_connections` 160), same burst | PATCH 200, readback 1000, restart 0.7 s after; 154 answered 200, 66 answered 503 with PostgREST's own message `{"code":"PGRST002",...,"message":"Could not query the database for the schema cache. Retrying."}`; the mid-burst read through the Management API query endpoint gave no row (its status and error were not recorded); after the burst, 5 consecutive good pings took 6 s (the check's floor is about 4 s, so no outage after the burst was measured) |
| DC02c restore (`db_pool` 50, timeout 10) | PATCH 200, restart 0.5 s after, 5 good pings in 4 s |
| DC02d no-change `db_pool` PATCH with 20 requests sleeping 60 s in flight (sent 5 s before the PATCH), twice | restart logged 55.3 s after the PATCH both times; all 20 in-flight requests answered 200 both times; 5 of 267 and 5 of 265 pings failed (status 0, no text, 10 s client timeout), first at 1.3 s and 0.8 s, in one run of about 50 s that ended before the logged 55.3 s restart |
| DC02e | 9 "Starting PostgREST" lines for 9 accepted PATCHes |

Readings (no separate probes):

- Every accepted PostgREST config PATCH restarted PostgREST, including one
  that changed nothing (DC02d, as data-api-reenable found). Across the seven
  PATCHes in DC02a to DC02c the restart came 0.5 to 0.9 s after the PATCH;
  ping failures were recorded for three of them (the two DC02a PATCHes and
  `db_pool` 1000), and none failed. With 60 s requests in flight (DC02d) it
  came 55.3 s after, about when they finished (they were sent 5 s before the
  PATCH), all of them completed, and new requests got no answer in the
  meantime. That fits a restart that drains in-flight requests before
  stopping, with new requests held behind it.
- Under load the wait for PGRST003 was shorter than for a lone request: in
  the 220-request control the 70 PGRST003 answers came after 10923 to 20903
  ms (median 20855), one or two acquisition timeouts. This is inferred from
  latency only; `burst()` does not count access-log lines, so attempts per
  request were not counted there. The policy (a budget, a cap on concurrent
  resends, or something else) is not separated.
- `db_pool` above what Postgres can give changed the failure in this one
  burst per arm: 504 PGRST003 at `db_pool` 50 became 503 PGRST002 at 1000,
  and the Management API read in the same burst gave no row. No connection
  count near 160 was observed (the mid-burst read is the one that failed).

### DC03 - statement timeouts through the Data API

Docs (Supabase timeouts guide): anon 3 s, authenticated 8 s, set per role.

| row | measured |
|---|---|
| DC03a `rolconfig` | anon `{statement_timeout=3s}`; authenticated `{statement_timeout=8s}`; service_role null; authenticator `{"session_preload_libraries=supautils, safeupdate",statement_timeout=8s,lock_timeout=8s}` |
| DC03a `dc_sleep` (no function setting) | anon key, 5 s sleep: 500 57014 after 3062 / 3057 ms. Anon key plus a user token (authenticated), 10 s: 8065 / 8048 ms. service_role key, 10 s: 500 57014 after 8056 / 8048 ms. Body: `{"code":"57014","details":null,"hint":null,"message":"canceling statement due to statement timeout"}` |
| DC03b `dc_sleep_long` (`set statement_timeout = '30s'` on the function), 12 s sleep | 200 for all three keys, twice each, 12067 to 12105 ms |
| DC03c `alter role authenticated set statement_timeout = '15s'`, user token, 10 s sleep | right after the ALTER: 500 57014 at 8078 / 8064 ms; after `notify pgrst, 'reload config'`: 200 at 10076 / 10103 ms; after `'reload schema'` as well: 200 at 10098 / 10080 ms; back to 8 s plus a config reload: 500 57014 at 8074 ms |
| DC03d anon key plus a user token (authenticated), `dc_tick_sleep(10)` (nextval, then a sleep past 8 s) | 500 57014 at 8058 and 8296 ms; the sequence counted 1 execution per request and PostgREST logged 1 line per request (500:1) (run 2: the same) |

Readings: service_role carries no timeout of its own, so a Data API request
under it runs with the 8 s that `authenticator` logs in with. A function's
own `set statement_timeout` applied to the call for every key, anon's 3 s
included. Correction (2026-10-26, DC09): this is PostgREST applying the
called function's setting before the statement starts; the module header's
competing hypothesis (the timer starts before the function's setting
applies) holds for Postgres itself, since a nested function's setting did
not lift the 8 s and a top-level function's did not lift it outside the Data
API. An `alter role` reaches the Data API only at the next config reload. A
500 under the authenticated role (DC03d) was not sent again, while the
PGRST003 probes (DC01b, DC02b, service_role key) were.

### Not run

- Compute sizes other than Small and Large; another region; a Team or
  Enterprise org.
- `db_pool` 0; `db_pool_acquisition_timeout` 0.
- Requests through Supavisor or direct Postgres (only the Data API path).
- A separating probe for which component sends PGRST003 requests again, or
  for its policy under load; attempt counts inside a burst.
- Client-side error text for the status-0 rows in run 4 (not recorded).

### Cost

Project time from the artifacts' start and finish stamps: run 1 about 38
minutes (23:02:55 to 23:41:10 UTC), run 2 about 13 minutes (23:43:28 to
23:56:48), run 4 about 40 minutes (00:37:06 to 01:17:25). Run 3's project
was created at 23:58:02 (the epoch in its generated name) and deleted with
`make clean DELETE=1` at about 00:36 (console time), about 38 minutes. Each
project was Small until DC01c and Large after. One development project
(Small, never resized, created 22:37:39 by the same reading of its name) was
deleted with `make clean DELETE=1` just before run 1, about 25 minutes. All
times 2026-10-22/23 UTC.
