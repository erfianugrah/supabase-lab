# RUNLOG - sqlite-edge-compare

Runs 2026-10-15 (UTC) in the sections below, and a re-run on 2026-10-16 with
the Turso engine added in the last section. Vantage: one macOS machine in Singapore (Bun
1.3.14), reaching the probe Worker at a nearby Cloudflare colo (SIN for most
rows; each row records its colo, and some landed in HKG, NRT or KIX, see
below). Data planes in Sydney (Supabase `ap-southeast-2`, Micro, Postgres
17.11; Turso `aws-ap-southeast-2`, libSQL; D1 hint `oc`). Drivers in the
Worker: the D1 binding, `@libsql/client/web` and node-postgres (`pg`) through
Hyperdrive; each row records the driver and its version. Code: lab commit
e1fa570 (recorded in each artifact) with this experiment uncommitted in the
working tree; `lib/client.ts` changed once during the battery (TD02n below).

Figures below are quoted from the published artifacts (`pvlab --facts`
output beside each); the raw artifacts are in `evidence/` (gitignored).
Worker rows time each operation inside the Worker (`performance.now()` around
the driver call: I/O wall time from that colo to Sydney and back); local rows
time it on this machine.

Published artifacts (redacted, a `.facts.md` beside each, `out/2026-10-15/`;
Turso and workers.dev hostnames, D1 and Hyperdrive ids and both org slugs
redacted by `make publish-evidence`):

| module | artifact | UTC | note |
|---|---|---|---|
| TD02 | `run-2026-10-15T04-43-58-162Z.json` | 04:43-05:09 | canonical except TD02n (client lost the 10001-query request) |
| TD02 | `run-2026-10-15T05-10-14-718Z.json` | 05:10-05:17 | TD02n re-run after the `lib/client.ts` fix; TD02a again as the only latency row |
| TD03 | `run-2026-10-15T05-18-21-082Z.json` | 05:18-06:07 | canonical except TD03b (80 client timeouts); Worker rows HKG and SIN |
| TD03 | `run-2026-10-15T06-07-47-149Z.json` | 06:07-06:10 | TD03b re-run (`TD03_TARGETS=turso`), SIN |
| TD04 | `run-2026-10-15T06-10-58-793Z.json` | 06:10-06:20 | C16 and C64 cells spread over SIN, NRT, HKG, KIX |
| TD05 | `run-2026-10-15T06-20-52-746Z.json` | 06:20-06:30 | superseded: ingest passed, aggregates and cleanup lost to a local network outage |
| TD05 | `run-2026-10-15T06-33-22-567Z.json` | 06:33-06:38 | canonical, SIN |
| TD06 | `run-2026-10-15T06-38-16-055Z.json` | 06:38-06:58 | superseded: every Worker row from NRT; TD06f and TD06z lost to a local network outage |
| TD06 | `run-2026-10-15T07-03-32-010Z.json` | 07:03-07:05 | smoke size (`TD_SMOKE=1`: 500 docs, 500 vectors, n = 5), SIN |
| TD06 | `run-2026-10-15T07-05-49-880Z.json` | 07:05-07:15 | canonical, full size, SIN |
| TD07 | `run-2026-10-15T07-16-08-863Z.json` | 07:16-07:19 | SIN, TD07d-d1 and TD07d-pg-rr HKG |
| TD08 | `run-2026-10-15T07-19-54-628Z.json` | 07:19-07:22 | local vantage only |
| TD01 | `run-2026-10-15T07-22-33-827Z.json` | 07:22-07:23 | local vantage only |

Reading rule (the plan's): a backend is called faster or slower than another
only where the two rows' p25-p75 ranges do not overlap; the `ordering` rows
(TD02l, TD03l) apply it. Every comparison holds for one colo, one local
machine, one region and one run per row unless a re-run is named.

## Fixture (Task 1), 2026-10-15

First `make up` (three invocations: the first two stopped on the issues
below and the third resumed from `.fixture.json`). n = 1 for every line; no
artifact is archived for these, they come from the fixture log and `/meta`.
Smoke-run latencies are deliberately not recorded here: the modules measure
those with n stated.

- Supabase Micro on the Pro org: `ACTIVE_HEALTHY` 19 s after create; the
  per-service health check, management SQL, the pooler (6543) and PostgREST
  (secret key) each answered on the first try after that. Postgres 17.11.
- Direct host from the local vantage: `getaddrinfo ENOTFOUND` for 10 minutes
  (36 tries), while `resolve6` returned one AAAA record and there is no A
  record. Bun's `dns.lookup` (what node-postgres uses) does not return the
  IPv6-only host on this machine; connecting to the resolved AAAA address works
  (`inet_server_addr()` family 6). `pgConfig(f, "direct")` and the fixture's
  readiness check now connect by address. The fixture's `readyMs` from this run
  (663 s) is inflated by those retries and is not a readiness time.
- Turso: group create, database create and the first `/v2/pipeline` answer
  within 4 s. The org had no group before; `sec-syd` is it.
- D1 create answered `created_in_region: OC`, `primary_location_hint: OC`,
  `read_replication.mode: disabled` (the default). `/meta` through the binding:
  `served_by_region OC`, `served_by_colo MEL`, `served_by_primary true`.
- D1 refuses `sqlite_version()`: `not authorized to use function: sqlite_version`.
  `/meta` uses `select 1` on D1 for that reason.
- D1 interactive transaction through the binding (smoke, TD07 owns the
  measurement): `BEGIN TRANSACTION` answers `D1_ERROR: To execute a
  transaction, please use the state.storage.transaction() or
  state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION ...`.
- D1 queries per invocation (smoke): 1100 sequential `select 1` in one
  invocation (`noSplit`) all succeeded, past the 1000 the D1 limits page gives
  for Paid. The account is not on the self-serve Workers Paid plan, so the
  documented ceiling may not be the one that applies here; TD02 records the
  ceiling row.
- Hyperdrive: the first create attempt failed client-side (`The socket
  connection was closed unexpectedly`) with no config saved; on resume both
  configs (caching disabled, caching enabled) saved in about 3 s each and both
  reach the direct host over IPv6 (`family(inet_server_addr()) = 6`).
- `make cleanup DRY=1` against the shared Cloudflare account listed exactly the
  fixture's seven `sec-` resources and nothing else.

## Teardown, 2026-10-15 after TD01

From the battery runner's log (not archived as an artifact):

- `make down` answered 200 for all seven fixture resources (the Worker, both
  Hyperdrive configs, the D1 database, the Turso database, the Turso group
  `sec-syd`, the Supabase project), removed `.fixture.json` and archived the
  identifiers to `evidence/fixture-ids-<stamp>.json` (gitignored).
- `make cleanup` (a real run, exit 0) printed `sec- resources left:
  supabase_projects=0 cf_workers=0 cf_d1=0 cf_hyperdrive=0 turso_dbs=0
  turso_groups=0`. A second listing against the three vendor APIs found no
  `sec-` name. The Cloudflare audit log for the day holds deletes of the two
  `sec-` Hyperdrive configs and the `sec-probe-` Worker script and nothing
  else (D1 deletes do not appear in that log).

## Harness change during the battery

`lib/client.ts` `post()` now passes `timeout: false` to `fetch`. Bun's socket
idle timeout (5 minutes by default, per the `BUN_CONFIG_HTTP_IDLE_TIMEOUT`
note in bun-types) closed the TD02n 10001-query request before the module's
own 600 s `AbortSignal`, twice, in the first TD02 run; the re-run shows that
invocation takes 330912 ms (`step1_wall_ms`). Every run from the TD02n re-run
on has the change; the other rows of the first TD02 run completed without it.

## TD02 - point reads (session or config lookup)

n = 300 per latency row after 20 warm-up reads dropped (hot-set rows n =
100), blocks of 10 reads per Worker invocation or local run, backends
round-robin. 10,000 seeded rows, identical in the three stores (TD02s:
count/sum(n)/max(id) 10000/5004937218/10000 in each). Every Worker row ran
from SIN (32 invocations per row, 12 on the hot-set rows). D1 rows report
`served_by_region OC`, `served_by_colo MEL`.

| row | vantage -> backend | p50 ms | p25-p75 | p95 | p99 | first read in an invocation, p50 vs the rest |
|---|---|---|---|---|---|---|
| TD02a | Worker -> D1 binding | 227 | 224-232 | 239 | 245.03 | 223.5 vs 227 |
| TD02b | Worker -> Turso (libSQL over HTTP) | 190 | 184-194.25 | 738.2 | 762.03 | 740 vs 189 |
| TD02c | Worker -> Hyperdrive, caching off -> Postgres | 257 | 251-284 | 293 | 296 | 258.5 vs 257 |
| TD02d | Worker -> Hyperdrive, caching on, uniform ids (mostly misses) | 288.5 | 258-291.25 | 297.05 | 302.06 | 290 vs 288 |
| TD02e | Worker -> PostgREST (secret key) | 307 | 302-324 | 366 | 778.5 | 342 vs 305 |
| TD02f | local -> Turso over HTTP | 257.9 | 252.23-282.2 | 1050.8 | 1133.04 | 1052.04 vs 256.78 |
| TD02g | local -> Supavisor transaction mode (6543) | 252.29 | 244.47-259.13 | 298.52 | 332.22 | 252.62 vs 252.27 |
| TD02h | local -> Postgres direct (IPv6) | 294.29 | 279.42-296.47 | 343.37 | 375.19 | 294.92 vs 294.27 |
| TD02i | local -> D1 REST query endpoint (admin path) | 291.34 | 278.96-332.23 | 407.97 | 609.89 | 288.88 vs 291.53 |
| TD02j | Worker -> Hyperdrive, caching off, hot set of 10 ids | 254 | 251-285 | 288 | 290.01 | 258 vs 253 |
| TD02k | Worker -> Hyperdrive, caching on, the same hot set | 5 | 4-10.25 | 33.6 | 302.08 | 7 vs 5 |

- TD02l ordering by p50 with the p25-p75 rule: Worker `turso < d1 < pg ~
  pg_cached < postgrest`; local, the pooler is separated from direct and D1 REST, and Turso
  overlaps the pooler and D1 REST.
- Turso's first read in each invocation took 740 ms (Worker) and 1052.04 ms
  (local) at p50 against 189 and 256.78 for the rest. With 10 reads per
  invocation one read in ten is a first read, which is what Turso's p95 (738.2
  Worker, 1050.8 local) shows. The extra time is probably connection setup
  for a new client; this run does not separate it. On the other rows the
  first read sat close to the rest, the widest being PostgREST (342 vs 305).
- Hyperdrive caching: on the hot set, cache hits brought the p50 to 5 ms
  (TD02k) against 254 ms with caching off (TD02j); on uniform ids (TD02d)
  caching on and off overlap.
- The TD02 re-run (05:10, SIN:32) repeated TD02a: p50 230, p25-p75 225-236,
  p95 244.
- Queries per Worker invocation (TD02m, TD02n; concurrency 16 inside the
  invocation): D1 1001 ok; at 10001, 10000 ok and 1 failed with `Too many API
  requests by single Worker invocation. To configure this limit, refer to
  https://developers.cloudflare.com/workers/wrangler/configuration/#limits`.
  Turso (re-run only) 1001 ok; at 10001, 10000 ok and 1 failed with `Too many
  subrequests by single Worker invocation` (same link). The D1 limits page
  gives 1000 queries per invocation on Paid (facts doc); this account allowed
  10000. The account is not on the self-serve Workers Paid plan, so which
  documented figure applies to it is not settled.
- Not settled: other colos and regions, behaviour under concurrent load
  (TD04), D1 read replication (left at its default, disabled), the cause of
  Turso's first-read cost.

## TD03 - job-state writes (queue worker)

n = 100 jobs per row (10 warm-up jobs dropped), 8 statements per job (insert,
three conditional status updates, a read after each write), blocks of 10 jobs
per invocation. Worker rows in the main run landed in HKG and SIN per block
(TD03a HKG:7,SIN:4; TD03c and TD03d HKG:6,SIN:5); the TD03b re-run was SIN:11.

| row | vantage -> backend | insert p50 ms | update p50 | read p50 | whole job p50 | whole job p25-p75 |
|---|---|---|---|---|---|---|
| TD03a | Worker -> D1 | 192 | 192 | 176 | 1470 | 1453-1829.5 |
| TD03b | Worker -> Turso (re-run, SIN) | 206 | 206 | 191 | 1608 | 1588-1659.25 |
| TD03c | Worker -> Hyperdrive -> Postgres | 228.5 | 218.5 | 220 | 1737.5 | 1456-2002 |
| TD03d | Worker -> PostgREST | 303.5 | 291.5 | 295.5 | 2387 | 1874.75-2665 |
| TD03e | local -> Turso | 275.74 | 272.73 | 257.03 | 2219.61 | 2125.79-2294.77 |
| TD03f | local -> Supavisor (6543) | 249 | 246.39 | 251.28 | 2041.23 | 1964.22-2104.94 |
| TD03g | local -> Postgres direct | 295.76 | 295.55 | 294.83 | 2405.66 | 2364.2-2451.27 |
| TD03h | local -> D1 REST (admin path) | 329.89 | 318.05 | 305.79 | 2601.64 | 2409.56-2765.9 |

- Every read saw the write before it and every write changed exactly one row,
  on every backend (TD03a-h; TD03b in the re-run).
- TD03l ordering (main run): Worker `turso ~ d1 ~ pg ~ postgrest`, with the
  colos mixed inside each row; local `local_pg_pooler < local_turso_http <
  local_pg_direct ~ local_d1_rest`.
- TD03b in the main run failed: 80 errors, all `fetch: The operation timed
  out.`, 0 read-your-write misses, 100 of 110 jobs clean. One 10-job block
  (80 statements) ran past the 300 s client deadline both times it was sent.
  The Worker has no per-operation timeout, so a stalled libSQL call shows only
  as a client timeout; whether the stall was between the Worker and Turso or
  at Turso was not determined. Its 100 clean jobs (90 measured after warm-up) had a whole-job p50 of 1469
  ms (p25-p75 1330.5-1588.25, HKG:6,SIN:4).
- Not settled: concurrent workers claiming one job, batched or transactional
  updates, cached reads after a write (TD07), D1 replicas, crash durability.

## TD04 - write contention

256 ops per cell; concurrency C spread over ceil(C/4) parallel invocations of
up to 4 lanes; one warm-up op per backend before the first cell. TD04a inserts
one row per op, TD04b increments one hot row. Every cell finished 256 of 256
ok with 0 errors, and the row count or counter matched the ok ops: no lost
update and no errored op that committed. C1 and C4 cells ran from SIN; C16
cells from SIN:3,NRT:1 invocations; C64 cells from SIN:10,HKG:4,NRT:1,KIX:1.

ops/s, with the per-op latency p50 in ms in brackets:

| backend | workload | C1 | C4 | C16 | C64 |
|---|---|---|---|---|---|
| D1 | insert | 4.22 (234) | 16.42 (239) | 59.95 (243.5) | 172.04 (253) |
| Turso | insert | 4.71 (203) | 17.45 (205) | 43.88 (210.5) | 25.82 (2186) |
| Postgres | insert | 3.98 (251) | 14.38 (284) | 53.2 (255.5) | 150.77 (251.5) |
| D1 | hot-row increment | 4.18 (237) | 16.43 (236) | 63.76 (241) | 135.38 (250) |
| Turso | hot-row increment | 4.65 (204) | 6.07 (198) | 42.39 (223) | 30.63 (1690.5) |
| Postgres | hot-row increment | 3.55 (282) | 15.03 (252) | 56.25 (282) | 147.98 (256.5) |

- D1 returned no `overloaded` error at 64 concurrent writers and its per-op
  p50 stayed at 250-253 ms. With 4 ops per lane at C64 the D1 insert cell
  lasted 1488 ms, so these cells are bounded by the round trip and did not
  reach the point where D1 queues; where that point is was not measured.
- Turso at C64: per-op p50 2186 ms (insert) and 1690.5 ms (increment), and
  fewer ops/s than at C16 (one ops/s sample per cell). Writes queued somewhere between the Worker and the
  database; that fits one writer per libSQL database, but this run cannot tell
  libSQL's write lock from a per-database limit in front of it.
- TD04b-turso-c4: one op took 42162 ms, the whole span of the cell, so its
  6.07 ops/s is one stalled op (p50 198). Not explained.
- TD04m0: creating a Turso-engine database through the Platform API with
  `use_tursodb: true` answered HTTP 400 `tursodb is not enabled for
  organization <redacted>; an owner must enable it in the organization
  settings`; the org object reads `tursodb_enabled false`, `plan_id starter`.
  TD04m2 (`BEGIN CONCURRENT`) skipped. The org setting was not changed.
- Not settled: the write rate at which D1 starts refusing, the Turso engine's
  MVCC writes, contention from many colos, multi-statement transactions under
  contention.

## TD05 - analytics event log

Worker only, SIN on every row. 100,000 seeded gateway events ingested in 100
ops of 1000 rows (D1 and Turso: `batch()` of 14-row INSERTs; Postgres: one
multi-row INSERT per op), then five dashboard aggregates, n = 20 each after 2
warm-up iterations. All 15 aggregate rows returned the JavaScript ground truth.

Ingest, summed op time: D1 34968 ms (2859.757 rows/s), Turso 33040 ms
(3026.634 rows/s), Postgres 63366 ms (1578.133 rows/s). The superseded run
(06:20, same sizes, SIN) recorded 38311, 72162 and 67940 ms for the same
ingest, so Turso's figure halved between two runs 13 minutes apart: read the
ingest numbers as one sample each.

| query | D1 p50 (p25-p75), p95 | Turso p50 (p25-p75), p95 | Postgres p50 (p25-p75), p95 | D1 rows_read |
|---|---|---|---|---|
| by_hour | 278 (267.25-281.5), 296.05 | 255.5 (209-728), 805.1 | 303 (302-306), 312.05 | 200000 |
| top_paths | 300.5 (291-311.5), 327.6 | 270.5 (223.5-287.25), 419.7 | 304 (302-305.5), 310.15 | 200030 |
| status_by_country | 320.5 (315-326.25), 344.8 | 269.5 (254.25-289), 340.85 | 308 (306-311), 329.35 | 200000 |
| p95_by_colo | 467 (454.5-476.5), 534.85 | 806 (801.5-1000.75), 1508.75 | 485 (480.5-489), 498.45 | 700047 |
| last_24h | 225.5 (213-230.25), 231.2 | 188.5 (182-192.5), 224.55 | 283 (282-284.25), 290.05 | 14241 |

- D1's own `sql_duration_ms` p50 for the five: 51.61, 79.54, 95.58, 241.57
  and 0.44 ms. last_24h took 225.5 ms at the Worker for 0.44 ms in the
  database, so most of a D1 query's time from SIN is the path to the database.
- p95_by_colo (window functions) is the slowest query on all three; Turso's
  p50 806 ms is above D1's and Postgres's, with p25-p75 separated.
- Turso Platform API usage across TD05 (whole database, read right after the
  run, may lag): rows_read +23758497, rows_written +200028, storage 6520832
  bytes. D1 after ingest: `rows_written` 200000, size 6524928 bytes.
- Not settled: the local vantage, concurrent ingest, ingest while the
  dashboard reads, Postgres-specific options (`percentile_cont`, BRIN,
  partitioning), cost per month.

## TD06 - search

Canonical run 07:05, Worker SIN on every row. Full text: 10,000 seeded
documents; FTS5 on D1 and Turso, generated `tsvector` ('simple') + GIN on
Postgres. Vector: 10,000 x 384-dim, cosine.

FTS ingest (31 ops, index maintained during the load), summed op time: D1
13823 ms (723.432 docs/s), Turso 12064 ms (828.912), Postgres 26583 ms
(376.18). Top-10 queries, n = 20 after 2 warm-up; every match count equalled
the ground truth:

| query (matches) | D1 p50 (p25-p75), p95 | Turso p50 (p25-p75), p95 | Postgres p50 (p25-p75), p95 | Postgres top-10 overlap with D1 |
|---|---|---|---|---|
| common (9672) | 232.5 (226.5-237.25), 239.3 | 205 (202-206.5), 272.5 | 292.5 (267-296), 302.25 | 0.3 |
| mid (1414) | 223 (219.5-225.5), 232.1 | 195 (193.75-197.25), 201.25 | 283 (258.75-287.25), 290.1 | 0.5 |
| rare (62) | 221 (217.75-223.25), 225.25 | 192 (191.75-196.25), 207.55 | 282 (257-284), 289.1 | 0.5 |
| and2 (364) | 219 (215.75-223), 225.45 | 194 (192.75-196.25), 227.3 | 282 (257-285), 291.15 | 0.1 |

Turso's top 10 equalled D1's on all four (overlap 1, both FTS5 bm25);
Postgres ranks with `ts_rank`, so lower overlap is by design.

Vector rows:

| row | Turso (libSQL `F32_BLOB`, `vector_top_k`) | Postgres (pgvector HNSW) |
|---|---|---|
| TD06c load | 243274 ms summed, index created before the load (`metric=cosine, compress_neighbors=float8, max_neighbors=16`) | 93549 ms summed, HNSW built after the load in 2855 ms (defaults, `hnsw.ef_search` 40) |
| TD06d ANN top-10 | p50 206, p95 258.7; recall@10 mean 0.265, min 0 | p50 281, p95 297.05; recall@10 mean 1, min 1 |
| TD06e exact top-10 | p50 212, p95 217.55; recall 1 | p50 277, p95 299.1; recall 1 |

- The Turso recall belongs to the index arguments above, chosen because
  libSQL's defaults loaded slowly: TD06g-turso-defaults put 500 rows into a
  default-argument index in 48101 ms summed (first op 2142 ms, last 18586 ms),
  where the measured-argument index took 6056 ms for its first 5 ops. At
  smoke size (500 vectors, 07:03) the same arguments gave recall 1. Recall at
  10,000 vectors with the default arguments was not measured.
- TD06g-turso-after-load: `CREATE INDEX` over 3000 preloaded rows failed once
  with `vector index: unable to initialize diskann` and built on attempt 2 in
  19228 ms. `DROP INDEX` on a libSQL vector index left its shadow table and
  meta row behind (`td06_vecd_idx_shadow`, `td06_vecd_idx`); TD06z removed
  them.
- TD06f: D1 answers `D1_ERROR: no such function: vector32` (no in-database
  vector type; Vectorize is a separate product, not measured).
- The superseded run (06:38) ran every Worker row from NRT, and its ordering
  is the reverse of SIN's: FTS query p50 Postgres 104-115 ms, Turso
  123.5-134.5, D1 201.5-212.5; pgvector ANN p50 106 ms against 281 from SIN.
  The same Postgres in Sydney answered a Worker in NRT sooner than one in SIN,
  both through Hyperdrive; why was not measured. In that run pgvector recall@10
  was mean 0.95, min 0 (one of 20 queries found none of the true top 10; not
  explained) and Turso's 0.295.
- Not settled: the Turso engine's `USING fts` index, stemming and language
  configs, relevance quality (overlap only), index parameter tuning, filtered
  vector search, the local vantage.

## TD07 - transaction semantics from a Worker

Worker SIN, except TD07d-d1 and TD07d-pg-rr (HKG). n = 1 per TD07a, TD07b
and TD07d row; n = 30 per TD07c row.

- Interactive transaction (TD07a): D1 refuses `BEGIN TRANSACTION` through the
  binding (`D1_ERROR: To execute a transaction, please use the
  state.storage.transaction() or state.storage.transactionSync() APIs instead
  of the SQL BEGIN TRANSACTION or SAVEPOINT statements.`), and the next
  request reads null. Turso committed in 584 ms and Postgres in 1140 ms, both
  reading the row inside the transaction and in the next request. The same
  two statements as a D1 `batch()` committed in 247 ms.
- Rollback on a primary-key violation (TD07b): `batch` and `tx` left 0 rows
  on Turso and Postgres, `batch` left 0 on D1; the autocommit control left 1
  on all three.
- Read-your-write (TD07c): 30 of 30 on all three in one invocation and in the
  next request, and on D1 with `withSession("first-unconstrained")`. A read
  through Hyperdrive with caching on after a write through the uncached
  config saw the new value 1 time in 30 and the previous value 29 times.
- A concurrent writer during a transaction (TD07d; A reads, waits, reads,
  increments; B makes 6 autocommit increments 300 ms after A starts):
  - Turso: A committed in 2347 ms, its two reads equal (0, 0); B 6 of 6 ok,
    slowest 1885 ms; final 7 of 7. B's slowest write fits B waiting for
    A's write transaction to finish (inference; B's per-write timing against
    A's commit was not recorded).
  - Postgres (READ COMMITTED): A committed in 3250 ms and read 0 then 6
    (non-repeatable read); B slowest 193 ms; final 7 of 7.
  - Postgres REPEATABLE READ: A failed after 2581 ms with `[40001] could not
    serialize access due to concurrent update`; final 6 of 6.
  - D1 batch: A in 232 ms, reads equal; B slowest 247 ms; final 7 of 7.
- Not settled: other isolation levels, libSQL read transactions, D1 with read
  replication on, transactions across invocations; n = 1 for the timing rows.

## TD08 - Turso embedded replica (local only)

n = 30 per row after 3 warm-up dropped (TD08a n = 1). The replica is a local
file opened with the native `@libsql/client`, synced by hand (`sync()`) from
the fixture database; "remote" is the same database over HTTP.

- TD08a: opening a fresh replica took 36143.833 ms (`createClient` blocks
  while it bootstraps the file), the first sync 10032.968 ms, 1000 of 1000
  seeded rows visible locally. The database's usage counter moved by
  154484736 `bytes_synced` and 1103 rows read between seeding and the end of
  TD08d. That delta covers the open, the first sync, 33 syncs and 33
  forwarded writes, so it does not show what the open alone pulled.
- TD08b: a write at the primary became visible in the replica after one
  `sync()` every time; lag p50 913.28 ms, p95 1000.81 ms, of which the sync
  call was p50 912.42 ms; 0 of 30 visible before a sync.
- TD08c: a PK read from the replica file p50 0.25 ms (p95 0.38) against
  244.53 ms (p95 313.39) over HTTP; p25-p75 separated.
- TD08d: an INSERT through the replica client (forwarded to the primary) p50
  1497.68 ms, p95 1573.81 ms; 30 of 30 readable in the local file right after,
  33 of 33 rows at the primary.
- TD08e: D1 and Postgres recorded as having no equivalent in the drivers this
  experiment uses; not measured.
- Not settled: `syncInterval`, offline writes, Turso Sync
  (`@tursodatabase/sync`), conflicts, a replica inside a Worker (no
  filesystem).

## TD01 - database per tenant (local only)

Turso: Platform API create in the fixture group, a per-database token, first
query over HTTP. D1: REST create and the REST query endpoint (admin path; a
Worker binding to a new database needs a redeploy, not measured). Postgres:
`CREATE SCHEMA` on the fixture project over the transaction pooler, with the
connection opened before the clock (1801.43 ms for the single tenant, not
counted). "First query" is create table, upsert, read back; every first query
succeeded on attempt 1.

| backend | single: create ms | single: create to first read-back | single: delete | burst of 20: create p50 | burst: create to first query p50 (max) | burst wall |
|---|---|---|---|---|---|---|
| Turso | 1269.9 | 3670.67 (includes a 541.53 ms token mint) | 942.88 | 2157.17 | 4732.6 (5318.94) | 5319.19 |
| D1 | 1010.72 | 2587.7 | 1181.22 | 774.27 | 2244.42 (3008.54) | 3009.13 |
| Postgres schema | 346.67 | 1085.54 | 284.77 | 257.69 | 1017.55 (1064.6) | 3175.82 (includes opening 20 connections, slowest 2114.55) |

- No create in either burst was refused; all 20 of each were deleted and
  TD01z found 0 left under the run's prefix on all three.
- TD01g restates the fixture's own project create (n = 1, not re-measured):
  status `ACTIVE_HEALTHY` 19121 ms after the fixture started, polled every
  10 s, which is not readiness (AGENTS.md, 2026-08-03); the `ready_ms` of
  662716 is inflated by the direct-host lookup failure in the fixture section
  above and is not a readiness time.
- Not settled: first queries from a Worker, plan ceilings (100 Turso
  databases on Free and 50,000 D1 databases per account on Paid are docs
  figures; neither was reached), per-tenant cost, many schemas under load,
  project-per-tenant beyond one create.

## Re-run 2026-10-16: the Turso engine added

The org setting the 2026-10-15 TD04m0 row asked for was switched on by the
account owner on 2026-10-16 (dashboard: the concurrency setting; the
organization object then reads `tursodb_enabled true`). The fixture gained a
second Turso database in the same group, created with `use_tursodb: true`
(`sec-tdb-<stamp>`, 990 ms), and the probe Worker a `tursodb` backend: the
same `@libsql/client/web` client against that database. TD01 to TD07 run it
next to the libSQL one where the fixture has it (`withTursodb`,
`lib/td04-07-plan.ts`). Same vantage (this machine in Singapore), same
regions, Worker at SIN unless a row says otherwise. Code: the working tree on
top of lab commit 4edcdd1.

Code changes before or during this run, each recorded here because a row
depends on it:

- TD05 rotates the order of its five queries per iteration
  (`rotate`, `lib/stats.ts`) and records each query's p50 when it ran first in
  the invocation and when it did not.
- TD04's Turso-engine rows open a Hrana stream per statement outside a
  transaction (see TD04m1 below); the first attempt (run 23:56) failed on that.
- `pgConfig` (local Postgres paths) gained `query_timeout: 120000` and
  `keepAlive: true` after the first TD03 attempt hung for 34 minutes on one
  query over a dead connection to port 5432; that attempt was stopped and
  wrote no artifact.
- TD05 re-sends a failed ingest batch once, only when a row count shows the
  batch did not land (generated ids); TD06 re-sends a failed vector batch once
  (explicit ids; a duplicate-key answer counts the batch as landed).
- Row ids: TD02 printed the Turso-engine row as `TD02undefined` (fixed later
  to TD02o; the TD03 artifact already has TD03o); TD01 printed the
  Turso-engine rows as TD01g / TD01h, and TD01g collides with the Supabase
  project row in the same artifact (fixed later to TD01i / TD01j). The
  artifacts keep the ids they were written with, and the sections below quote
  those ids.

Published artifacts (`out/2026-10-16/` unless noted, redacted as before):

| module | artifact | UTC | note |
|---|---|---|---|
| TD04 | `out/2026-10-15/run-2026-10-15T23-56-11-249Z.json` | 23:56-00:05 | libSQL, D1, Postgres cells (a second sample of each); TD04m0/m1 Turso engine; TD04m2 failed on the stream issue |
| TD04 | `run-2026-10-16T00-07-27-227Z.json` | 00:07-00:43 | with the Turso engine in the Worker cells; TD04m2 complete |
| TD07 | `run-2026-10-16T00-43-57-653Z.json` | 00:43-00:47 | |
| TD02 | `run-2026-10-16T00-47-12-215Z.json` | 00:47-01:14 | Turso-engine row printed as `TD02undefined` |
| TD05 | `run-2026-10-16T02-10-27-593Z.json` | 02:10-02:16 | superseded: one ingest batch per Turso database lost to HTTP 520, Turso aggregates skipped; Worker at HKG |
| TD06 | `run-2026-10-16T02-16-57-235Z.json` | 02:16-02:27 | Turso-engine vector load 9900/10000 (one batch lost, error text not recorded) |
| TD01 | `run-2026-10-16T02-27-14-443Z.json` | 02:27 | Turso-engine rows printed as TD01g/TD01h |
| TD03 | `run-2026-10-16T02-28-06-480Z.json` | 02:28-03:20 | |
| TD05 | `run-2026-10-16T03-20-26-319Z.json` | 03:20-03:27 | canonical |
| TD06 | `run-2026-10-16T03-27-49-254Z.json` | 03:27-03:38 | superseded: vector loads and cleanup lost to a local DNS outage |
| TD06 | `run-2026-10-16T03-44-01-976Z.json` | 03:44-03:59 | canonical |
| TD08 | `run-2026-10-16T03-59-43-029Z.json` | 03:59-04:02 | write and Turso Sync rows failed on the Turso write block |

### TD04 - write contention, two more samples

ops/s at C1 / C4 / C16 / C64, per-op p50 at C64 in brackets. Run 1 is
2026-10-15 06:10 (above), run 2 is 2026-10-15 23:56, run 3 is 2026-10-16
00:07. Every C16 and C64
cell in runs 2 and 3 ran from SIN.

| backend | workload | run 1 | run 2 | run 3 |
|---|---|---|---|---|
| D1 | insert | 4.22 / 16.42 / 59.95 / 172.04 (253) | fail / 16.44 / 57.41 / 148.75 (347.5) | 4.2 / 15.82 / 55.36 / 162.33 (329) |
| D1 | increment | 4.18 / 16.43 / 63.76 / 135.38 (250) | 4.17 / 16 / 63.26 / 149.88 (265) | 4.07 / 15.64 / 61.88 / 166.13 (296) |
| Turso libSQL | insert | 4.71 / 17.45 / 43.88 / 25.82 (2186) | 4.74 / 18.48 / 44.78 / 26.83 (2284) | 4.77 / 18.48 / 50.77 / 24.4 (2592.5) |
| Turso libSQL | increment | 4.65 / 6.07 / 42.39 / 30.63 (1690.5) | 5.16 / 18.3 / 52.44 / 30.96 (1760) | 4.74 / 18.25 / 49.42 / 24.1 (2502) |
| Turso engine | insert | - | - | 3.19 / 12.93 / 14.28 / 13.03 (4575.5) |
| Turso engine | increment | - | - | 3.15 / 14.55 / 13.95 / 10.98 (5500) |
| Postgres | insert | 3.98 / 14.38 / 53.2 / 150.77 (251.5) | 3.55 / 14.48 / 59.62 / 170.55 (281) | fail / 14.75 / 56.78 / 152.47 (253) |
| Postgres | increment | 3.55 / 15.03 / 56.25 / 147.98 (256.5) | 3.53 / 15.3 / 56.35 / 169.65 (251) | 3.51 / 14.48 / 53.55 / 155.25 (280) |

- The libSQL drop at C64 repeated in all three runs (24.1 to 30.96 ops/s,
  per-op p50 1690.5 to 2592.5 ms). Run 1's C64 cells spread over four colos;
  runs 2 and 3 were SIN only, so the drop is not the colo mix.
- The Turso engine's per-op p50 was already 1002 ms (insert) and 1015.5 ms
  (increment) at C16; its ops/s stayed between 12.93 and 14.55 from C4 to
  C16 and fell at C64 (13.03 / 10.98).
- Failed cells: run 2 TD04a-d1-c1 (the request came back as a Cloudflare HTTP
  502 page after 29617 ms; 122 rows had committed), run 3 TD04a-pg-c1 (the
  local client timed out; 256 rows had committed), run 3 TD04a-tursodb-c64
  (all 256 ops ok; the row-count read answered HTTP 520).
- TD04m0 (run 3): create with `use_tursodb: true` HTTP 200 in 1317 ms; DbId
  classifies as tursodb.
- TD04m1: the Turso-engine database reports `journal_mode` `mvcc` and accepts
  `BEGIN CONCURRENT`; `PRAGMA journal_mode = wal` is refused (`SQL not allowed
  statement`). The libSQL database reports `wal` and rejects `BEGIN
  CONCURRENT` as a parse error. On both, a second autocommit statement on one
  Hrana stream fails: the server returns no baton after an autocommit
  statement, so the stream ends (`STREAM_CLOSED` is this lab's client's text,
  `lib/td04-07-hrana.ts`); `@libsql/client` opens a new stream instead.
- TD04m2 (local vantage, Hrana over HTTP, one statement per round trip, n = 64
  transactions per cell, up to 25 attempts):

| engine | begin | workload | C1 tx/s | C4 tx/s | C16 tx/s | conflicts retried (C4 / C16) | committed at C16 |
|---|---|---|---|---|---|---|---|
| Turso engine | BEGIN CONCURRENT | insert | 1.08 | 4.4 | 1.73 | 0 / 0 | 64 |
| libSQL | BEGIN IMMEDIATE | insert | 1.31 | 1.83 | 1.82 | 0 / 0 | 64 |
| Turso engine | BEGIN CONCURRENT | read-modify-write | 0.9 | 1.13 | 1.24 | 189 / 713 | 53 (11 gave up after 25 attempts) |
| libSQL | BEGIN IMMEDIATE | read-modify-write | 0.99 | 1.26 | 1.24 | 0 / 0 | 64 |

  Every cell's final count equalled its committed transactions (no lost
  update). Conflicts arrive as `[SQLITE_ABORT] Tursodb error: Write-write
  conflict`. One sample per cell.

### TD07 - transaction semantics, with the Turso engine

TD07a to TD07d on the Turso engine matched the libSQL rows: interactive
transaction committed in 634 ms (libSQL 576); a duplicate key rolls back the
batch and the interactive transaction and leaves the earlier row in `each`
mode; 30/30 reads saw their own and the preceding write; in TD07d a writer B
waited behind A's open write transaction (slowest B write 2107 ms, libSQL
1934 ms) and A's two reads were equal. The D1 and Postgres rows repeat
2026-10-15: D1 refuses `BEGIN TRANSACTION`, the Hyperdrive cache returned the
pre-write value on 29 of 30 reads, Postgres read committed showed a
non-repeatable read and repeatable read failed A with 40001.

### TD02 - point reads, with the Turso engine

Worker at SIN:32 for every Worker row; n = 300 after 20 warm-up.

| target | p25 | p50 | p75 | first in invocation p50 | connect p50 |
|---|---|---|---|---|---|
| D1 (TD02a) | 219 | 221 | 223.25 | 221 | 0 |
| Turso libSQL (TD02b) | 180 | 184 | 189 | 729.5 | 0 |
| Turso engine (`TD02undefined`) | 183 | 186 | 188 | 732.5 | 0 |
| Hyperdrive, caching off (TD02c) | 249 | 250 | 282 | 252.5 | 2 |
| Hyperdrive, caching on (TD02d) | 252.75 | 283 | 286 | 285.5 | 2 |
| PostgREST (TD02e) | 290 | 324 | 327 | 337.5 | 0 |

TD02l ordering: `turso ~ tursodb < d1 < pg ~ pg_cached < postgrest`. TD02b
is `fail` on 1 of 320 reads answering HTTP 520. TD02m/n repeated the
2026-10-15 ceiling: 10000 queries ok and the 10001st refused, on D1 and Turso.
Connect time: `connect_ms_p50` is the Hyperdrive connection open inside the
Worker (2 ms here, 7 ms on 2026-10-15); the local pooler and direct paths
connect in 2015.81 and 2123.34 ms, outside op timings in both runs.

### TD01 - database per tenant, with the Turso engine

| backend | single: create / create to first query / delete (ms) | burst of 20: create p50 / first query p50 / max / wall (ms) |
|---|---|---|
| Turso libSQL | 1380.91 / 3727.39 / 790.22 | 1591.49 / 4080.64 / 4322.38 / 4322.8 |
| Turso engine (written TD01g, TD01h) | 1166.34 / 3792.89 / 1110.09 | 2006.4 / 4651.5 / 4934.59 / 4934.85 |
| D1 | 707.41 / 2087.22 / 1010.91 | 767.94 / 2177.16 / 2841.78 / 2842.32 |
| Postgres schema | 248.41 / 987.94 / 244.98 | 253.91 / 1012.95 / 1062.97 / 3179.01 |

All 20 of each burst were created, answered and deleted; TD01z found nothing
left under the run prefix on any backend.

### TD03 - job-state writes, with the Turso engine

Artifact `run-2026-10-16T02-28-06-480Z.json` (02:28-03:20; the earlier
attempt that hung is not published). Worker rows SIN:11 (PostgREST SIN:10);
100 jobs after 10 warm-up. p50 per op and per whole job (insert, three
updates, a read after each), ms:

| target | insert | update | read | job p25 | job p50 | job p75 |
|---|---|---|---|---|---|---|
| D1 (TD03a) | 241 | 239 | 224 | 1844.75 | 1855 | 1869.25 |
| Turso libSQL (TD03b) | 201 | 201 | 186 | 1540.5 | 1565 | 1629.25 |
| Turso engine (TD03o) | 318.5 | 319 | 186 | 1981 | 2002.5 | 2041.25 |
| Hyperdrive, caching off (TD03c) | 283 | 283 | 282 | 2002 | 2262 | 2272 |
| PostgREST (TD03d) | 327 | 322 | 320 | 2469 | 2541.5 | 2639.5 |
| local Turso HTTP (TD03e) | 277.67 | 273.88 | 260.39 | 2152.66 | 2241.76 | 2351.45 |
| local pooler 6543 (TD03f) | 257.3 | 257.25 | 253.8 | 2048.27 | 2137.96 | 2205.94 |
| local direct (TD03g) | 293.72 | 293.25 | 292.75 | 2295.89 | 2390.89 | 2445.52 |
| local D1 REST (TD03h) | 308.7 | 301.05 | 287.38 | 2297.81 | 2396.68 | 2737.43 |

TD03l: `turso < d1 < tursodb ~ pg < postgrest` on the Worker. The Turso
engine's writes took 318.5 / 319 ms against libSQL's 201 / 201 ms on the same
group and client; its reads matched (186 ms). TD03d failed on 80 operations
timing out client-side (one block lost and re-sent with fresh ids; 100 of
110 jobs clean); TD03h failed on one timeout and one ECONNRESET (4
read-your-write misses and 3 writes not changing one row, all on those
errored jobs).

### TD05 - analytics event log, query order rotated

Artifact `run-2026-10-16T03-20-26-319Z.json` (03:20-03:27, Worker SIN).
Ingest of 100000 events in 1000-row ops: D1 36215 ms summed op time, Turso
libSQL 33205, Turso engine 43090, Postgres 64509; every backend counted 100000
rows, no ingest retry was needed. The five queries rotate per iteration, so
each led 4 of the 20 kept iterations (Turso engine last_24h: 3 of 19, one
read failed); p50 overall / when first in the
invocation / when not first, ms:

| backend | by_hour | top_paths | status_by_country | p95_by_colo | last_24h |
|---|---|---|---|---|---|
| D1 | 301 / 294.5 / 302.5 | 365 / 365.5 / 365 | 395 / 389.5 / 396 | 630.5 / 636 / 626 | 228 / 224.5 / 228 |
| Turso libSQL | 211.5 / 756.5 / 208.5 | 236.5 / 802 / 220.5 | 271.5 / 771.5 / 265.5 | 896.5 / 1315.5 / 872 | 187 / 772.5 / 186.5 |
| Turso engine | 402.5 / 788 / 402 | 493.5 / 494.5 / 493.5 | 477 / 471 / 477 | 2413.5 / 2418.5 / 2413.5 | 195 / 198 / 194 (fail) |
| Postgres | 301 / 286.5 / 301 | 304 / 310 / 275.5 | 306 / 294.5 / 306 | 480 / 482.5 / 466 | 282 / 253.5 / 284 |

- Turso libSQL: whichever query ran first in the invocation took 443.5 to 586
  ms longer than its not-first p50, on all five shapes; that is the client's
  first-request cost (TD02 shows the same: first-in-invocation 729.5 vs 183 not first).
  The 2026-10-15 run always ran by_hour first.
- Turso engine: only by_hour shows a first-in-invocation gap (788 vs 402);
  the other four do not. n = 4 first-in-invocation samples per cell (3 for
  last_24h); not explained.
- Turso engine aggregates ran slower than libSQL on the same data, most on
  the window-function query (p95_by_colo 2413.5 vs 896.5 ms).
- TD05b-tursodb-last_24h is `fail` on one read answering HTTP 520.
- Superseded attempt `run-2026-10-16T02-10-27-593Z.json` (Worker HKG): one
  ingest batch per Turso database answered HTTP 520 and the Turso aggregates
  were skipped; that run's D1 and Postgres rows are a second sample.

### TD06 - search, with the Turso engine

Canonical artifact `run-2026-10-16T03-44-01-976Z.json` (03:44-03:59, Worker
SIN), the third attempt: `run-2026-10-16T02-16-57-235Z.json` lost one
Turso-engine vector batch (load 9900/10000, error text not recorded) and
`run-2026-10-16T03-27-49-254Z.json` lost every vector load (6600, 6600 and
6500 of 10000; the Turso engine's first error an HTTP 520) and its cleanup to
a local DNS outage (both published, superseded).

- FTS: the Turso engine refuses the FTS5 table, `Parse error: Virtual tables
  are not supported in MVCC mode` (TD06a-tursodb). D1, Turso libSQL and
  Postgres repeat 2026-10-15: same match counts (9672 / 1414 / 62 / 364),
  libSQL's top-10 equal to D1's on every query, Postgres `ts_rank` overlap
  0.1 to 0.5 with D1's bm25 (0.3 / 0.5 / 0.5 / 0.1 in both runs). TD06b-turso-common is `fail` on one read
  answering HTTP 520.
- Vector load, 10000 x 384, 100 per op: Turso libSQL 202908 ms summed (index
  maintained on insert), Turso engine 75052 ms (TD06 creates no vector index
  on it, after the standalone probe below found index creation refused; one
  batch failed and landed on its one retry), Postgres
  95615 ms plus HNSW build 2728 ms.
- Search: Turso engine exact top-10 p50 211 ms, recall@10 1; its ANN query
  fails on every iteration (`no such table: vector_top_k`; no index was
  created). Turso libSQL ANN
  p50 201.5 ms, recall@10 mean 0.245 with the module's index arguments
  (0.265 on 2026-10-15); exact 207.5 ms, recall 1. pgvector HNSW p50 257 ms,
  recall 1. pgvector recall@10 over four full runs: 0.95 (2026-10-15, NRT), 1
  (2026-10-15, SIN), 1 and 1 (2026-10-16 02:16 and 03:44); the 2026-10-15
  smoke run (n = 5) is not counted. D1 has no
  `vector32` (TD06f).
- A standalone probe on a throwaway Turso-engine database (2026-10-16, not a
  module row) found `CREATE INDEX ... USING fts` and `CREATE INDEX ... USING
  vector` both refused with `index method is an experimental feature. Enable
  with --experimental-index-method flag`, and `libsql_vector_idx` refused as
  an invalid expression.

### TD08 - embedded replica and Turso Sync, cut short by a write block

Artifact `run-2026-10-16T03-59-43-029Z.json` (03:59-04:02, local).

- TD08a: opening a fresh replica of the libSQL fixture database took
  79749.385 ms (first sync 4782.131 ms, 1000/1000 seeded rows visible); the
  usage counter moved 153862144 bytes for the run (2026-10-15: open
  36143.833 ms, first sync 10032.968 ms). One open per run.
- TD08c: local replica read p50 0.31 ms against 252.24 ms over HTTP.
- TD08g: the same native embedded replica pointed at the Turso-engine
  database does not open: `file is not a database`.
- TD08b, TD08d and every Turso Sync row (TD08f) failed: after the seed the
  Turso org refused all writes, `BLOCKED: Operation was blocked: SQL write
  operations are forbidden (writes are blocked, do you need to upgrade your
  plan?)`. Read by hand from the Platform API after the block (not in an
  artifact): the org object showed `blocked_writes true`, `overages false`,
  `plan_id starter` (taken here as the Free plan); usage for the billing
  period from 2026-10-14 showed `rows_written` 11774888, past the Free plan's
  10M rows written per month. Of that, the two fixture databases of this run
  counted 9639906 (Turso engine) and 900317 (libSQL) rows written; the rest belongs to databases
  already deleted (the 2026-10-15 battery and throwaway databases). The two
  fixture databases ran overlapping but not identical workloads, so the
  ratio is not a per-row comparison; why the Turso-engine database counted
  ten times the writes was not isolated.
- A standalone probe before the block (2026-10-16, two throwaway databases,
  not a module row) ran Turso Sync 0.8.3 against both engines: it connected,
  pushed (642 and 599 ms), pulled, and when A and B updated the same row
  offline and pushed in turn, both pushes returned without error and both
  clients then read B's value. These figures are one trial each and are not in
  an artifact.
