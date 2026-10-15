# sqlite-edge-compare

For seven application shapes (database per tenant, point reads, job-state
writes, write contention, an analytics event log, search, transaction
semantics, plus a local-first replica), what are the latency, throughput,
failure shape and provisioning cost of Turso (libSQL), Supabase Postgres and
Cloudflare D1, measured from one Cloudflare Worker and from one local client,
with all three data planes in Sydney: Supabase `ap-southeast-2`, Turso
`aws-ap-southeast-2`, D1 location hint `oc`.

- Plan: `docs/plans/2026-10-15-sqlite-edge-compare.md` (use cases TD01-TD08,
  fairness rules).
- Documented facts the plan rests on (limits, pricing, concurrency and
  transaction models, with URLs): `docs/research/2026-10-15-sqlite-edge-compare-facts.md`.
- Measured values: `RUNLOG.md`; published artifacts: `out/2026-10-15/`.
- Results by use case, with documented ceilings: below.

Self-provisioning, no OpenTofu state. Every resource is named `sec-*`; the
Cloudflare account and both orgs hold other work, so the fixture, `down` and
`cleanup` only ever list, change or delete `sec-*` names (`assertSec` /
`secOnly` in `lib/vendors.ts`; deletes by id read the name first).

## Results by use case (2026-10-15)

One battery, 2026-10-15, published under `out/2026-10-15/`; per-module detail,
superseded runs and every caveat in `RUNLOG.md`. Conditions for every number
below: data planes in Sydney; the Worker ran at SIN unless a row says
otherwise; "local" is one machine in Singapore; one run per row (re-runs named
in the RUNLOG); ms per operation as timed inside the Worker or on the local
machine. A backend is called faster only where the p25-p75 ranges do not
overlap. Documented ceilings are vendor defaults from the facts doc
(`docs/research/2026-10-15-sqlite-edge-compare-facts.md`), not measurements.

Worker orderings depend on the colo. The first TD06 run landed every
Worker row in NRT instead of SIN, and the order reversed: Postgres full-text
p50 104-115 ms, Turso 123.5-134.5, D1 201.5-212.5, against Turso 192-205, D1
219-232.5, Postgres 282-292.5 from SIN. Every Worker ordering below is SIN's.

### Database per tenant (TD01, local, n = 1 single plus a burst of 20)

| backend | create to first read-back, single | burst of 20: create to first query p50 (max) | burst wall | refused |
|---|---|---|---|---|
| Turso (Platform API + per-database token + HTTP) | 3670.67 ms | 4732.6 (5318.94) ms | 5319.19 ms | 0 |
| D1 (REST create + REST query, admin path) | 2587.7 ms | 2244.42 (3008.54) ms | 3009.13 ms | 0 |
| Postgres schema on one project (pooler 6543) | 1085.54 ms | 1017.55 (1064.6) ms | 3175.82 ms | 0 |

Documented ceilings: Turso Free 100 databases (https://turso.tech/pricing,
re-read 2026-10-15), and more than one group needs Scaler, Pro or
Enterprise (Turso API reference); D1 50,000 databases per account on Paid
(raisable on request), 10 on Free (D1 platform/limits). A Supabase project per tenant was not
measured beyond the fixture's one create (TD01g, n = 1, `ACTIVE_HEALTHY` is
not readiness).

Reading: all three gave every tenant in a burst of 20 a working first query,
the slowest at 5318.94 ms (Turso), with no refusals. The run does not reach any plan
ceiling, does not measure a first query from a Worker (a D1 binding needs a
redeploy per database), and says nothing about cost per tenant.

### Point reads (TD02, n = 300 per row after 20 warm-up)

| vantage -> path | p50 ms (p25-p75), p95 |
|---|---|
| Worker -> D1 binding | 227 (224-232), 239 |
| Worker -> Turso over HTTP | 190 (184-194.25), 738.2 |
| Worker -> Hyperdrive (caching off) -> Postgres | 257 (251-284), 293 |
| Worker -> Hyperdrive (caching on), uniform ids, mostly misses | 288.5 (258-291.25), 297.05 |
| Worker -> PostgREST | 307 (302-324), 366 |
| Worker -> Hyperdrive (caching on), hot set of 10 ids (TD02k, n = 100) | 5 (4-10.25), 33.6 |
| local -> Turso over HTTP | 257.9 (252.23-282.2), 1050.8 |
| local -> Supavisor transaction mode (6543) | 252.29 (244.47-259.13), 298.52 |
| local -> Postgres direct | 294.29 (279.42-296.47), 343.37 |
| local -> D1 REST query endpoint (admin path) | 291.34 (278.96-332.23), 407.97 |

Documented ceilings: D1 1000 queries per Worker invocation on Paid (D1
platform/limits); measured on this account (TD02m, TD02n): 10000 for D1
(`Too many API requests by single Worker invocation`) and 10000 for Turso
(`Too many subrequests by single Worker invocation`). Hyperdrive caching:
max_age 60 s, writes do not invalidate (Hyperdrive query-caching).

Reading: from SIN the Worker order was `turso < d1 < pg ~ pg_cached <
postgrest`, a 190 to 307 ms spread over a Singapore-Sydney path; locally the
pooler was separated from the direct host and D1 REST, and Turso overlapped
the pooler and D1 REST. Turso's first read per invocation cost 740 ms against
189 for the rest, so its p95 is a cold-client figure. Client setup is not
counted the same way on every path: Postgres lanes connect before their first
timed op (local connect p50 1640.4 ms pooler, 2197.86 ms direct), while
Turso, PostgREST and D1 REST pay their setup inside the first op. Cached Hyperdrive reads of
unchanging hot rows answer from the edge (5 ms). One colo, no concurrency;
this does not rank the backends for a Worker in another colo.

### Job-state writes (TD03, n = 100 jobs of 8 statements)

| path | whole job p50 (p25-p75) | Worker colo |
|---|---|---|
| Worker -> D1 | 1470 (1453-1829.5) | HKG and SIN |
| Worker -> Turso | 1608 (1588-1659.25) | SIN (re-run) |
| Worker -> Hyperdrive -> Postgres | 1737.5 (1456-2002) | HKG and SIN |
| Worker -> PostgREST | 2387 (1874.75-2665) | HKG and SIN |
| local -> Supavisor (6543) | 2041.23 (1964.22-2104.94) | - |
| local -> Turso | 2219.61 (2125.79-2294.77) | - |
| local -> Postgres direct | 2405.66 (2364.2-2451.27) | - |
| local -> D1 REST (admin path) | 2601.64 (2409.56-2765.9) | - |

Documented ceilings: D1 processes one query at a time per database (D1
platform/limits); 30 s query duration (D1 platform/limits).

Reading: read-your-write held on every backend and every write changed one
row. The Worker rows ran from mixed colos (HKG and SIN; Turso's row is from a
separate re-run), so they do not rank the backends even where ranges separate; locally the pooler path was fastest (`local_pg_pooler <
local_turso_http < local_pg_direct ~ local_d1_rest`). The main run's Turso
row lost one 10-job block to a client timeout twice (80 statements, cause
not determined; the re-run was clean). Concurrent claimers were not tested.

### Write contention (TD04, 256 ops per cell)

| backend | inserts ops/s at C1 / C4 / C16 / C64 | hot-row increments ops/s at C1 / C4 / C16 / C64 | per-op p50 at C64 |
|---|---|---|---|
| D1 | 4.22 / 16.42 / 59.95 / 172.04 | 4.18 / 16.43 / 63.76 / 135.38 | 253 / 250 ms |
| Turso | 4.71 / 17.45 / 43.88 / 25.82 | 4.65 / 6.07 / 42.39 / 30.63 | 2186 / 1690.5 ms |
| Postgres via Hyperdrive | 3.98 / 14.38 / 53.2 / 150.77 | 3.55 / 15.03 / 56.25 / 147.98 | 251.5 / 256.5 ms |

C16 and C64 cells ran over several colos (SIN, NRT, HKG, KIX). Every cell:
256 of 256 ok, 0 errors, no lost update.

Documented ceilings: D1 overflow fails with `D1 DB is overloaded. Too many
requests queued.` (D1 observability/debug-d1); Turso's docs disagree on whether the Turso
engine's MVCC concurrent writes are on by default or opt-in (not measured
here), and `@libsql/client` lists them as not supported
(Turso docs). The Turso-engine database could not be created on this org
(TD04m0: `tursodb is not enabled for organization`).

Reading: at 64 concurrent writers Turso (libSQL) queued, per-op p50 1690.5
and 2186 ms and fewer ops/s than at 16 (ops/s is one sample per cell, over a different
colo mix per cell), while D1 (per-op p50 234-253 ms) and
Postgres (251-284 ms) held their latency and gained ops/s with concurrency. These cells are bounded by the round
trip from the colo, so they do not find D1's overload point; and the Turso
row is libSQL only, not the Turso engine's `BEGIN CONCURRENT`.

### Analytics event log (TD05, 100,000 events, n = 20 per query)

| backend | ingest, summed op time | by_hour | top_paths | status_by_country | p95_by_colo | last_24h |
|---|---|---|---|---|---|---|
| D1 | 34968 ms | 278 | 300.5 | 320.5 | 467 | 225.5 |
| Turso | 33040 ms | 255.5 | 270.5 | 269.5 | 806 | 188.5 |
| Postgres via Hyperdrive | 63366 ms | 303 | 304 | 308 | 485 | 283 |

Query columns are p50 ms; every aggregate returned the correct answer.

Documented ceilings: D1 10 GB per database on Paid, 100 bound parameters per
query, 30 s per query (D1 platform/limits); D1 Paid includes 25B rows read
per month (D1 platform/pricing); Turso Free 500 million rows read and 10
million written per month (https://turso.tech/pricing, re-read 2026-10-15).
Vendor counters for this module: D1 `rows_read` 200000 for by_hour, 700047
for p95_by_colo per query; Turso's usage API moved by 23758497 rows read
across TD05.

Reading: at 100,000 rows every aggregate came back at a p50 between 188.5
and 806 ms from the Worker on all three, path time dominating the light
queries (D1's own `sql_duration_ms` for last_24h was 0.44 ms of 225.5) but
not the heavy ones (p95_by_colo 241.57 of 467 ms). by_hour ran first in every
invocation, so Turso's by_hour row also carries its client setup (p25-p75
209-728). Turso's p95_by_colo was the slow outlier
(806 ms p50, separated). Turso's ingest time halved between two runs
(72162 vs 33040 ms), so the ingest column is one sample. Nothing here covers
concurrent ingest, Postgres-specific tools (partitioning, BRIN,
`percentile_cont`), or larger tables.

### Search (TD06, 10,000 docs and 10,000 x 384 vectors, n = 20 per query)

| backend | FTS ingest | FTS query p50 (4 shapes) | vector load | ANN p50, recall@10 mean | exact top-10 p50 |
|---|---|---|---|---|---|
| D1 (FTS5) | 13823 ms | 219-232.5 | no vector type (`no such function: vector32`) | - | - |
| Turso (FTS5; libSQL vector index) | 12064 ms | 192-205 | 243274 ms | 206, 0.265 | 212 |
| Postgres (`tsvector` + GIN; pgvector HNSW) | 26583 ms | 282-292.5 | 93549 ms + 2855 ms build | 281, 1 | 277 |

Documented: Turso native vector search (`F32_BLOB`, `libsql_vector_idx`);
the Turso engine's Tantivy `USING fts` is a different surface from FTS5 (out
of scope); D1 databases with virtual tables (FTS5) cannot be exported (D1
best-practices/import-export-data). No D1 vector support found in its docs.

Reading: full-text match counts were identical on all three; from SIN the
order was Turso < D1 < Postgres, from NRT (superseded run) it reversed. The
Turso ANN recall of 0.265 belongs to the index arguments this module chose
(`compress_neighbors=float8, max_neighbors=16`, picked because libSQL's
default arguments loaded far slower in TD06g); it is not a measure of libSQL
vector search in general, and the defaults' recall at 10,000 vectors was
not measured. Relevance quality, stemming and filtered vector search were
not tested.

### Transaction semantics (TD07, Worker)

| behaviour | D1 | Turso | Postgres via Hyperdrive |
|---|---|---|---|
| interactive transaction (TD07a, n = 1) | refused (`To execute a transaction, please use the state.storage.transaction() ...`); `batch()` committed in 247 ms | committed, 584 ms | committed, 1140 ms |
| rollback on a duplicate key (TD07b) | `batch` 0 rows left | `batch` and `tx` 0 rows left | `batch` and `tx` 0 rows left |
| read-your-write, next request (TD07c, n = 30) | 30/30 | 30/30 | 30/30; via the caching config 1/30 fresh, 29 stale |
| a second writer during a transaction (TD07d, n = 1) | batch, reads equal (HKG) | second writer's slowest write 1885 ms, consistent with waiting (inferred, n = 1), reads equal | READ COMMITTED: second read saw 6 new commits; REPEATABLE READ (HKG): `[40001]` |

Documented: D1 `batch()` is its transaction, statements in sequence, rolled
back as a whole (D1 worker-api/d1-database); Hyperdrive's cache is not
invalidated by writes.

Reading: only Turso and Postgres gave a Worker an interactive transaction;
D1 needs the whole transaction known up front as a batch. Reading through
Hyperdrive's cache after a write returned the old value 29 times in 30. The
timing rows are n = 1.

### Local-first replica (TD08, Turso only, local, n = 30)

| measure | value |
|---|---|
| open a fresh replica, then first sync | 36143.833 ms, then 10032.968 ms |
| PK read: replica file vs HTTP at the primary | 0.25 vs 244.53 ms p50 |
| write at the primary to visible after one `sync()` | 913.28 ms p50, 1000.81 p95 |
| INSERT through the replica client | 1497.68 ms p50, 30/30 readable locally at once |
| bytes synced (usage API delta across all of TD08) | 154484736 |

Documented: embedded replicas are supported in production and Turso Sync is
recommended for new projects (Turso docs); Turso Free includes 3 GB of syncs
per month (https://turso.tech/pricing, re-read 2026-10-15). D1 and Postgres
have no equivalent in the drivers used here.

Reading: once synced, reads are local-file fast and a primary write is one
`sync()` away (913.28 ms p50). Opening a fresh replica took 36143.833 ms plus a
10032.968 ms first sync. The usage counter moved 154484736 bytes across all
of TD08 (open, first sync, 33 syncs, 33 forwarded writes; the counter may
lag); how much of that the open alone moved was not isolated. Periodic sync, offline writes and Turso Sync were not tested.

### Not compared

Cost per month, Auth/RLS, Storage, Realtime and backup or restore paths are
outside this battery. The rows-read and rows-written counters above are the
inputs a cost estimate would need; no estimate is made here.

## Run

```bash
# credentials per command, never exported (see the Makefile header for the list)
sx SUPABASE_ACCESS_TOKEN CLOUDFLARE_EMAIL CLOUDFLARE_API_KEY CLOUDFLARE_ACCOUNT_ID \
   TURSO_API_TOKEN=TURSO_API_TOKEN -- env PVLAB_ORG_PRO=<slug> PVLAB_TURSO_ORG=<slug> \
   make -C experiments/sqlite-edge-compare up          # ~6-10 min
#   ... status | probe IDS=TD02,TD03 | down | cleanup [DRY=1]
make -C experiments/sqlite-edge-compare test           # offline unit tests
```

`make up` writes `.fixture.json` (gitignored, mode 0600: DB password, secret
key, Turso DB token, probe key) and renders `wrangler.jsonc` (gitignored).
`make down` archives the fixture's identifiers (no secrets) to
`evidence/fixture-ids-<stamp>.json` so `make publish-evidence` can redact them
after the resources are gone.

## Fixture

| backend | resource | notes |
|---|---|---|
| Supabase | Micro project on the Pro org, `ap-southeast-2` | waited past ACTIVE_HEALTHY until management SQL, the pooler (6543), the direct host and PostgREST answer |
| Turso | group `sec-syd` (`aws-ap-southeast-2`), one libSQL database, full-access DB token (7-day expiry) | Free allows one group; `down` deletes the group once it is empty |
| D1 | one database, location hint `oc`, read replication at default | the landing region is undocumented; `served_by_region` is recorded per op |
| Hyperdrive | two configs on the Supabase direct string: caching disabled (`HD`), caching enabled (`HD_CACHED`) | |
| Worker | `sec-probe-<stamp>`, `nodejs_compat`, workers.dev, Smart Placement off | bindings `DB`, `HD`, `HD_CACHED`; secrets `PROBE_KEY`, `TURSO_TOKEN`, `SUPABASE_SECRET_KEY` |

## Probe Worker contract

Types: `lib/contract.ts`. Every route needs `X-Probe-Key`.

- `POST /run` `{backend, statements:[{sql, params} | {http}], repeat, concurrency, mode, returnRows, returnMeta, d1Session, noSplit, label}`
  -> per-op timings (`performance.now()` around the driver call), error text
  verbatim, driver meta (D1 `meta` incl. `served_by_region`, `rows_read`,
  `rows_written`), `colo`. Backends `d1 | turso | pg | pg_cached | postgrest`;
  modes `each | batch | tx`. A request above 500 statement executions is
  refused unless `noSplit`; `runOnWorker` (lib/client.ts) splits for you.
- `GET /meta` -> `select 1` (or a PostgREST GET) on every backend, with the
  server version, D1 `served_by_region` and the driver versions.

Clock caveat: a Worker's `performance.now()` advances only across I/O, so
an op timing is I/O wall time. Six connections per invocation may wait for
response headers at once, so fetch-based backends queue above concurrency 6
inside one invocation; contention rows fan out over invocations instead
(`runOnWorker(..., { invocations: k })`).

## Layout

- `lib/contract.ts` wire types and constants; `lib/exec.ts` the executor both
  vantages share; `lib/adapters.ts` per-backend driver code (bundled into the
  Worker too).
- `lib/client.ts` what modules import: `fixtureOrSkip`, `runOnWorker`,
  `runLocal`, `metaOnWorker`, `pgConfig`, `tursoClient`, `d1Query`. The
  direct host is IPv6-only and this vantage's getaddrinfo does not resolve it
  (RUNLOG), so `pgConfig(f, "direct")` connects to the resolved AAAA address.
- `lib/stats.ts` percentiles, summary with warm-up dropped, the IQR-overlap
  test, round-robin scheduler, interleave, seeded RNG.
- `lib/vendors.ts` Cloudflare, Turso and Supabase API helpers, prefix-guarded.
- `lib/fixture.ts` `up | down | status | env | cleanup | literals`.
- `worker/index.ts` the probe Worker; `tests/` the TD modules.
