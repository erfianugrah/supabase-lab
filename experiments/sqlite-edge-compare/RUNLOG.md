# RUNLOG - sqlite-edge-compare

All runs 2026-10-15 (UTC). Vantage: one macOS machine in Singapore (Bun
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
