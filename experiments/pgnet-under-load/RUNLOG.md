# RUNLOG - pgnet-under-load

Chronological record of what was run. Org and project identifiers are not
recorded; the org class is (Pro). Each process provisions its own throwaway
project through `POST /v1/projects` (ap-southeast-1, `desired_instance_size`
`micro` for NL01/NL02, `large` for NL03-NL05) and NL99 deletes it. The
receiver is a workers.dev Worker (`receiver/index.ts`) with a SQLite-backed
Durable Object ledger, deployed for the day and deleted after. Every
receiver time below is the Worker's `Date.now()` at request entry minus the
enqueue time the database wrote into the body (`clock_timestamp()`), so it
includes the offset between the database host's clock and Cloudflare's (not
separated). "Source read" means the pg_net 0.20.4 source and SQL as read
before the run; "measured" means the artifact.

## 2026-10-26 - NL01, NL02 (Micro, one run)

Harness: `make micro`, lab commit 848b9f3 plus the uncommitted experiment.
Published: `out/2026-10-26/run-2026-10-26T00-24-41-120Z.json` (7 results)
and its `.facts.md`. Postgres 17.11, pg_net 0.20.4.

Artifact label: the NL01b cells ("stored N ms after enqueue") and the NL02
`first_resp_after_enq_ms` / "response stored N ms after enqueue" figures are
`net._http_response.created` minus the enqueue time. They are NOT the time
the response arrived: in NL02c call 1 timed out after 30 s and its row's
`created` was 48 ms after enqueue. Measured, `created` matches the moment
the pg_net worker took the request's batch (NL01 below); the module text
says "row created" from the next run on. `g2_arrived_before_first_done`
compares against that same column and carries no information.

NL01 (ceiling, default, long calls):

- Settings: `pg_net.batch_size=200`, `pg_net.ttl=6 hours`,
  `pg_net.database_name=postgres`, `pg_net.username=postgres` (4 settings,
  nothing else). `show pg_net.max_timeout_ms` answered `42704: unrecognized
  configuration parameter "pg_net.max_timeout_ms"`: the ceiling the upstream
  README at HEAD documents is absent at 0.20.4. The `http_post` signature's
  `timeout_milliseconds` default is 5000. The Supabase pg_net guide
  (https://supabase.com/docs/guides/database/extensions/pg_net, read
  2026-10-26) shows `timeout_milliseconds int default 2000` for http_get,
  http_post and http_delete: contradicted by the hosted signature and by the
  omitted-timeout calls below, which timed out at 5000 ms.
- 28 calls: receiver sleep 4, 8, 30, 90 s x `timeout_milliseconds` 5000,
  30000, 120000, 600000, 600001, 0 and omitted. None refused at enqueue
  (600001 and 0 accepted). Every call arrived at the receiver (28 of 28).
  Outcome: 200 whenever the timeout exceeded the sleep or was 0, `timed_out`
  otherwise; omitted behaved as 5000; 0 behaved as no timeout (200 after a
  90 s sleep). 600001 completed a 90 s call; nothing in this run lasted 600
  s, so whether any cap applies past 600000 is not measured. Calls of 30 s
  and 90 s complete when the timeout allows them (120000 and up).
- Timeout `error_msg` text: `Timeout of 5000 ms reached. Total time: 5001.621000 ms (DNS time: 5001.621000 ms, TCP/SSL handshake time: 0.000000 ms, HTTP Request/Response time: 0.000000 ms)`.
  All eight timeouts in NL01 put the whole time in "DNS time" although every
  one of those requests had arrived at the receiver, so name resolution,
  TCP and TLS had completed. NL02c's timeout split it differently: `DNS
  time: 0.294000 ms, TCP/SSL handshake time: -0.294000 ms, HTTP
  Request/Response time: 30000.796000 ms`. The phase split in `error_msg`
  does not locate a timeout; why the figures come out this way was not
  investigated.
- Batch pickup seen in NL01 itself: the matrix was enqueued one statement at
  a time. The first call's row was created 7 ms after its enqueue; the 27
  calls enqueued behind call 1 show created-minus-enqueue falling from 4500
  to 1607 ms in enqueue order, consistent with one pickup about 4.5 s after
  the first enqueue, i.e. after the first call (a 4 s sleep) finished
  (per-call enqueue times not published; on that reading the enqueue took
  2893 ms, 4500 - 1607). That fits the pg_net worker taking call 1 alone,
  then the other 27 as one batch.
- NL01t (side check): `count(*)` over `generate_series(1, 5e6)` in FROM wrote
  17090 temp blocks (work_mem 3500kB, 1108.012 ms); in the target list 0
  temp blocks (577.889 ms). The NL03/NL04 CPU burners therefore spin a
  PL/pgSQL loop rather than a FROM-clause `generate_series(1, 1e9)`.

NL02 (head-of-line, 400 calls per part in one transaction, default 5000 ms
timeout on calls 2-400):

| part | call 1 | calls 2-200 arrival delay p50 / max | calls 201-400 arrival delay min / p50 / max | gap after last of 2-200 | timed_out 2-200 / 201-400 |
|---|---|---|---|---|---|
| NL02a control | fast, HTTP 200 | 134 / 374 ms | 2132 / 2151 / 2187 ms | 1775 ms | 0 / 0 |
| NL02b slow | 4.5 s receiver, HTTP 200 | 67 / 126 ms | 6010 / 6031 / 6065 ms | 5904 ms | 0 / 0 |
| NL02c hang | 60 s receiver, timeout 30000, timed_out | 65 / 96 ms | 31031 / 31048 / 31083 ms | 30957 ms | 0 / 0 |

- Source-read prediction held: calls 201-400 wait for the whole first batch,
  so one slow call delays the next batch by its own duration (4.5 s
  receiver: batch 2 arrived 6010-6065 ms after enqueue; a 30 s timeout:
  31031-31083 ms).
- The timeout clock starts at send, not enqueue: calls 201-400 waited about
  6 s and about 31 s in the queue with a 5000 ms timeout and none timed out
  (0 of 200 in both parts).
- Even with no slow call (NL02a) the second batch started 1775 ms after the
  last arrival of the first, 2132 ms after enqueue at the earliest. Not
  explained by this run (a wait between batches in the pg_net worker loop
  would produce it; not separated).

## 2026-10-26 - NL03 (Large, one run) and NL04 (Large, run 1)

Harness: `make large`, lab commit 848b9f3 plus the uncommitted experiment.
The first `make large` (NL03, NL04, NL99 on one Large) aborted NL03 in setup
with `22003: integer out of range` (the test table's generator multiplied an
int past 2^31; fixed with a bigint cast) and ran NL04 to the end:
`out/2026-10-26/run-2026-10-26T00-28-01-744Z.json` (10 results, the NL03
abort among them). NL03 was started in a separate process on a second Large
(`make large LARGE=NL03,NL99`) at 00:30:17 UTC. It ran alongside NL04 run 1
and NL04 run 2 (00:28:01-00:56:26 UTC between them), against the same
receiver Worker: `out/2026-10-26/run-2026-10-26T00-30-17-690Z.json` (5
results). NL03's Large: Postgres 17.11, pg_net 0.20.4, pg_cron 1.6.4; NL04's
pgmq 1.5.1 (the NL04 and NL05 projects' Postgres and pg_net versions were
not recorded). `node_cpu_seconds_total` lists 2 CPUs.

### NL03 - attribution under CPU saturation

Per arm, a pg_cron job every 10 s enqueued 17 calls to each target with
`timeout_milliseconds` 5000 for 600 s. Saturated arm: 4 session-pooler
backends (2 x the 2 CPUs) spinning a PL/pgSQL loop; all 4 seen `active` in
`pg_stat_activity`. CPU busy from the metrics endpoint: idle arm 0.162 over
the arm (presumably the ef_query load; not separated), saturated arm 0.954
over the arm, 1 in nine of the ten 60 s samples (0.735 in the first).
`nl_work()` (a count over 2M rows) took 181.361 ms on the idle database by
EXPLAIN ANALYZE.

| arm | target | calls | 2xx | timed_out | enqueue-to-arrival p50 / p95 / max | query inside the function p50 / p95 / max |
|---|---|---|---|---|---|---|
| idle | `worker` (Cloudflare Worker) | 1020 | 1020 | 0 | 8 / 20 / 363 ms | - |
| idle | ef_echo | 1020 | 1020 | 0 | 104 / 146 / 2579 ms | - |
| idle | ef_query | 1020 | 1019 | 1 | 104 / 151 / 1387 ms | 1326 / 1397 / 3870 ms |
| saturated | `worker` (Cloudflare Worker) | 1003 | 1003 | 0 | 19 / 31 / 146 ms | - |
| saturated | ef_echo | 1003 | 1003 | 0 | 109 / 136 / 2551 ms | - |
| saturated | ef_query | 1003 | 1003 | 0 | 110 / 139 / 2623 ms | 1692 / 1790 / 4482 ms |

- Saturating both CPUs with 4 spinning backends produced no timeout on any
  target: 0 of 3009 calls in the saturated arm. The pg_net side kept up: the
  enqueue-to-pickup time (`net._http_response.created`) went from p50 4 ms /
  max 14 ms (`worker` target, idle) to p50 14 ms / max 42 ms (saturated),
  and the Worker's arrival p50 from 8 to 19 ms. The `nl-fire` job ran 60
  times idle (avg 14 ms, max 16 ms) and 59 times saturated (avg 41 ms, max
  53 ms).
- The one timeout of the run (idle, ef_query) fits the receiver-waits-on-
  the-database class by the reading key; its cause is not proven (see the
  end of this bullet). 17 calls arrive together every 10 s, each running a
  query that takes 181 ms alone by EXPLAIN ANALYZE, on 2 CPUs; the query
  inside the function (timed in the function, so including the Data API
  round trip) took 1326 ms at p50 and 3870 ms at most with the database
  otherwise idle, probably mostly that concurrency (inferred, not
  separated); saturation moved it to 1692 ms p50 and 4482 ms max, still
  under 5 s. Its `error_msg` again put all 5000.566 ms in "DNS time", while
  the same function answered the other 1019 calls of the arm; whether this
  call reached it is not recorded (the function returns its arrival time
  only in a response).
- Cold start was not a cause here. `function_logs` counted a Boot for most
  invocations (idle: ef_echo 865, ef_query 858 for 1020 calls each;
  saturated: 833 and 839 for 1003), with arrival p95 at 136-151 ms and
  arrival max 1387-2623 ms, all well under 5 s. Boot rows were counted per
  function id over each arm's window plus 30 s, read 90 s after the second
  arm; whether some Boots belong to a neighbouring window was not checked.
- The pg_net worker's `pg_stat_activity` row, sampled every 1 s: idle arm
  idle `Extension/Extension` x402, active `Extension/Extension` x119, active
  with no wait event x95; saturated arm idle `Extension/Extension` x397,
  active with no wait event x118, active `Extension/Extension` x104, active
  `LWLock/ProcArray` x1. Largest queue seen 51 in both arms.
- Reading key outcome: no target timed out under saturation, so this run
  shows no starvation of the pg_net worker at 4 spinning backends on 2 CPUs;
  the only timeout came from the target that queries the same database. Not
  tested: heavier saturation (more backends than this, I/O or memory
  pressure, lock waits), other compute sizes, Micro's shared CPU, and a
  target slower than 5 s on a cold boot.

### NL04 - delivery of 1,000 messages (run 1)

Receiver `/flaky`: 20% 503, 10% held 8 s then 200, else 200; every call
`timeout_milliseconds` 5000. "Delivered" = the receiver recorded a 200 or a
held request for the message at least once (a held request whose sender
timed out still counts as processed). Deadlines: raw 90 s, retry and pgmq
180 s. CPU busy: idle 0.031, saturated 0.999 (4 burners).

| arm | mechanism | delivered | lost | messages processed twice or more (extra deliveries) | receiver arrivals (503 / held) | sender: calls, confirmed, timed_out | all confirmed |
|---|---|---|---|---|---|---|---|
| idle | raw | 726 | 274 | 0 (0) | 965 (239 / 81) | 1000, 555, 240 | no (90 s) |
| idle | retry | 1000 | 0 | 144 (168) | 1468 (300 / 168) | 1468, 1000, 168 | after 103 s |
| idle | pgmq | 1000 | 0 | 111 (125) | 1414 (289 / 126) | 1414, 999 (1 left in queue), 126 | no (180 s) |
| saturated | raw | 806 | 194 | 0 (0) | 1000 (194 / 104) | 1000, 702, 104 | no (90 s) |
| saturated | retry | 1000 | 0 | 133 (152) | 1444 (292 / 152) | 1444, 1000, 152 | after 73 s |
| saturated | pgmq | 1000 | 0 | 122 (142) | 1450 (308 / 144) | 1450, 998 (2 left in queue), 144 | no (180 s) |

- Raw pg_net loses what the receiver refuses (every 503) and, measured from
  the sender, also counts the held-then-answered requests as failures: the
  sender confirmed 555 and 702 while the receiver processed 726 and 806.
- Retry and pgmq delivered all 1,000 in both arms, at a duplicate cost:
  every held request that timed out at 5 s was processed and then sent
  again. Retry: extra deliveries equal held requests (168 of 168 idle, 152
  of 152 saturated). pgmq: 125 extra for 126 held idle, 142 for 144
  saturated (the remainder, 1 and 2, still waiting in the queue at the
  deadline). Those messages had been delivered already and were waiting out
  their 30 s visibility timeout for a retry the receiver did not need.
- CPU saturation changed no delivery count beyond the receiver's own random
  mix; the retry arm finished sooner saturated (73 s) than idle (103 s), and
  that difference is the random fault draw as much as anything (not
  separated, n = 1 each).
- Unexplained, idle raw: 35 of 1000 calls never reached the receiver (965
  arrivals) and the sender recorded 240 timeouts against 81 held requests,
  so about 159 calls timed out at 5 s without being held (34 of them were
  answered 503 by the receiver: 239 receiver 503s, 205 sender 5xx). The
  ledger groups the 965 arrivals by enqueue-to-arrival second as 0 s:165, 6
  s:200, 12 s:200, 18 s:200, 24 s:200 (ledger read by hand, not in the
  published artifact): the shortfall is all in the first batch of 200. It
  was the first burst of NL04 at the receiver after an idle Worker and the
  first write to that run's Durable Object; the saturated raw arm (1000 of
  1000 arrived, timeouts = held) and the retry arm's first batch (207
  arrivals in the first second, ledger read by hand, not in the published
  artifact) did not repeat it. A receiver first-burst effect was the first
  reading; NL04 run 2 and NL05 below test it.
- Batch pacing visible in the same ledger: with 10% of each 200-call batch
  held past the 5 s timeout, each batch of the raw arm arrived 6 s after the
  previous one (0, 6, 12, 18, 24 s; ledger read by hand, not in the
  published artifact), the NL02 head-of-line effect at work.

## 2026-10-26 - NL04 (Large, run 2)

Harness: `make large LARGE=NL04,NL99` on a third fresh Large, same code as
run 1. Published: `out/2026-10-26/run-2026-10-26T00-42-43-410Z.json`
(9 results). CPU busy: idle 0.025, saturated 0.999 (4 burners).

| arm | mechanism | delivered | lost | messages processed twice or more (extra deliveries) | receiver arrivals (503 / held) | sender: calls, confirmed, timed_out | all confirmed |
|---|---|---|---|---|---|---|---|
| idle | raw | 797 | 203 | 0 (0) | 1000 (203 / 97) | 1000, 566, 277 | no (90 s) |
| idle | retry | 1000 | 0 | 118 (137) | 1425 (288 / 137) | 1425, 1000, 137 | after 93 s |
| idle | pgmq | 1000 | 0 | 125 (139) | 1384 (245 / 139) | 1384, 1000 (0 left in queue), 139 | after 187 s |
| saturated | raw | 792 | 208 | 0 (0) | 1000 (208 / 113) | 1000, 679, 113 | no (90 s) |
| saturated | retry | 1000 | 0 | 127 (144) | 1405 (261 / 144) | 1405, 1000, 144 | after 73 s |
| saturated | pgmq | 1000 | 0 | 140 (158) | 1452 (294 / 158) | 1452, 1000 (0 left in queue), 158 | after 186 s |

- Same shape as run 1: raw loses every refused message (203 and 208 lost,
  equal to the receiver's 503 count); retry and pgmq lose none and process
  12-14% of messages more than once, extra deliveries equal to held requests
  in all four retry and pgmq rows of this run. pgmq finished just past its
  180 s deadline in both arms (187 s and 186 s, the poll that saw the last
  ack); run 1's pgmq rows stopped at 180 s with 1 and 2 messages left.
- CPU saturation again changed no delivery count beyond the receiver's
  random fault mix.
- The idle raw excess repeated without lost arrivals: 1000 of 1000 arrived,
  yet the sender recorded 277 timeouts against 97 held requests, and 157
  5xx against the receiver's 203 503s, so about 180 calls the receiver
  answered at once (46 of them 503) timed out at the sender. Saturated raw
  again matched exactly (113 timeouts, 113 held). In both runs the excess
  sits in the first mechanism the project ran, i.e. the first calls the
  project ever sent to the receiver. Separating probe: NL05.
- Receiver-side control (lab Mac, not the database; curl from the lab Mac,
  not in the published artifact; the Worker's idle time before it not
  recorded): 200 concurrent POSTs to `/echo` with a fresh run id, twice,
  answered 200 of 200 each time with `time_total` p50/p95/max
  0.530/1.154/1.320 s and 0.384/1.259/1.416 s. The Worker and a fresh
  Durable Object took a 200-request burst inside 1.5 s from this vantage;
  that leans against a receiver first-burst cause without excluding one at
  the database's vantage.

## 2026-10-26 - NL05, first burst after the pg_net worker sat idle (Large, one run)

Harness: `make large LARGE=NL05,NL99` on a fourth fresh Large. Published:
`out/2026-10-26/run-2026-10-26T00-57-29-512Z.json` (5 results). Four bursts
of 200 calls to `/echo` (default 5000 ms timeout), each in one transaction
after the queue drained; every burst wrote to a fresh ledger (new run id,
new Durable Object).

| burst | HTTP 200 (of 200 calls) | timed_out (of them arrived at the receiver) | never arrived | arrival delay p50 / p95 / max |
|---|---|---|---|---|
| 1, the project's first outbound calls | 111 | 89 (89) | 0 | 484 / 781 / 816 ms |
| 2, at once after 1 | 200 | 0 | 0 | 55 / 85 / 92 ms |
| 3, at once after 2 | 200 | 0 | 0 | 44 / 69 / 187 ms |
| 4, after 120 s idle | 61 | 139 (139) | 0 | 493 / 785 / 825 ms |

- Reproduced, and it is not about the project being new: a burst of 200
  after the pg_net worker had sent nothing for a while (first ever, or 120 s
  idle) timed out 89 and 139 calls at the 5 s timeout; bursts sent straight
  after a previous one had none. Every timed-out call had reached the
  receiver, within 825 ms of enqueue, and the receiver answers `/echo` at
  once after its ledger write. The slow first-arrival (p50 484 and 493 ms vs
  55 and 44 ms warm) fits 200 new TLS connections, i.e. no reused
  connections.
- The one sampled `error_msg` per cold burst split plausibly this time: `DNS
  time: 35.321000 ms, TCP/SSL handshake time: 112.676000 ms, HTTP
  Request/Response time: 4888.822000 ms` (burst 1) and `15.926000 /
  235.276000 / 4769.802000 ms` (burst 4). Against NL01's all-in-DNS splits
  for requests that had equally arrived, the phases are inconsistent across
  runs; the NL01 rule stands.
- NL04's first-mechanism excess fits this cold-burst effect: the idle raw
  arm was the first burst after setup in both runs (240 timeouts for 81
  held, 277 for 97), while the saturated raw arm started about 35 s or more
  after the idle pgmq arm (a 15 s settle plus the 20 s burner ramp in
  tests/nl04-delivery.ts) and matched exactly (104 and 113 timeouts for 104
  and 113 held). NL05 (0 never arrived in all four bursts) does not explain
  run 1's 35 calls that never reached the receiver. NL04's raw "sender
  confirmed" figures for the idle arm therefore include this effect; its
  receiver-side delivered/lost counts do not depend on it.
- Receiver-side control, lab Mac in Singapore, after the Worker had been
  idle about 150 s (from the end of NL05): 200 concurrent POSTs to `/echo`,
  fresh ledger, answered 200 of 200 with `time_total` p50/p95/max
  0.079/0.557/0.898 s, then 0.522/0.890/0.986 s for a second burst; none
  over 5 s (curl from the lab Mac, not in the published artifact). The
  receiver does not reproduce the stall from this vantage, which points at
  the database host's side (pg_net's first batch of new connections) or the
  path between it and Cloudflare. Not separated: a receiver stall specific
  to the AWS-side colo, and whether a smaller first batch
  (`pg_net.batch_size`) or a longer timeout on the first calls avoids it. n
  = 1 run, two cold bursts.
