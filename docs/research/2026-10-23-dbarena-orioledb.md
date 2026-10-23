# DBArena's OrioleDB numbers against the lab's pgbench result (2026-10-23)

Question: the OrioleDB guide cites a 1.8x TPC-C-derived speedup on 8xlarge;
`experiments/orioledb` OR05 (2026-10-10, `small`, pgbench through the
session pooler at a 7.1 to 7.8 ms round trip) found no difference between an
OrioleDB and a heap table that "is resolvable at this run count" (OR05
RUNLOG). Does DBArena's published harness explain the gap,
and is there a cell worth rerunning? Derived tables:
`raw/2026-10-23-dbarena-orioledb/` (`peak-table.tsv`, `sweep-all.tsv`, and
`peak.jq`, which builds them from the published `result.json` files).

Sources, all read 2026-10-23:

- Methodology: https://dbarena.com/methodology
- Results site: https://dbarena.com/ ("Measured Sep 25 - Oct 1, 2026"; the
  page states "DBArena is sponsored by Supabase")
- Published results, pinned:
  https://github.com/dbarena/dbarena.com/tree/1d7b6309cb0849698709125f9adb478650914c42/results/supabase
- Scheduler and candidate manifests, pinned:
  https://github.com/dbarena/dbarenactl/tree/7a0161b1cf55714fd954f6c85536efc4f0f1517a/candidates/supabase
- Runner: the DBArena runner repository (linked from the results repository above); load generator:
  https://github.com/supabase/go-tpc (Apache-2.0, all four public)
- OrioleDB guide (1.8x, "8xlarge instance"):
  https://supabase.com/docs/guides/database/orioledb

## How DBArena measures

From the methodology page and the OrioleDB candidate files:

- Workload: go-tpc (Supabase fork) TPC-C-derived, no think time, Postgres 17,
  `us-east-1`, Pro plan, HA off. Clients connect directly over TLS
  (`connection_mode: direct`, `sslmode=require`), no pooler.
- Load generator: an EC2 instance (`c8gd.xlarge` up to XL) in the same region;
  Supabase's AZ is not selectable, so each run records a round-trip baseline
  (`metadata.network_rtt`).
- Two data-set sizes per tier: cache fit (`warehouses = 2 x RAM GiB`; 4 on
  `small`) and cache exceeding (`warehouses = 40 x RAM GiB`, about 4x RAM; 80
  on `small`, `db_size_before.total_bytes` 12299283970 in the heap result).
- Client sweep per tier (`small`: 2, 4, 8, 12), 30 min warm-up and 60 min
  measurement per client count, three fresh environments per test point.
  Published `tpm` is NEW_ORDER tpm of the run with the median value at the
  client count whose median is highest. The methodology table says "Published
  results use 12 clients" for `small`; the selection rule picked 4 clients for
  both products in the `small` cache-exceeding cell (`sweep-all.tsv`).
- The OrioleDB scenario creates the project with `postgres_engine:
  "17-oriole"` and `experimental: true`, and records `orioledb_version()`,
  `pg_settings` and OrioleDB page-pool stats per run.

## What the published data says (pasted from `peak-table.tsv`)

OrioleDB over heap, NEW_ORDER tpm at each test point's peak, three runs each:

| tier | cache exceeding: ratio (oriole runs / heap runs) | cache fit: ratio (oriole runs / heap runs) |
|---|---|---|
| small | 1.47 (6404-6618 / 4344-4669) | 0.91 (13037-17087 / 13998-18358) |
| medium | 1.44 (7066-7221 / 4909-5116) | 1.01 (10134-10772 / 10220-10560) |
| large | 1.33 (7058-7194 / 5153-5358) | 1.13 (18193-21782 / 18484-21536) |
| xlarge | 1.73 (24772-26709 / 14374-15092) | 1.08 (38596-41268 / 33680-38184) |
| 2xlarge | 1.69 (35270-36458 / 20998-21243) | 1.17 (78879-80785 / 68096-69322) |
| 4xlarge | 1.88 (58750-59438 / 29834-31591) | 1.25 cost-opt, 1.28 perf-opt |
| 8xlarge | 1.89 (112831-114193 / 51391-64907) | 1.29 cost-opt, 1.29 perf-opt |

Ratios are a division of two published figures (derived). The run ranges are
disjoint in every cache-exceeding cell (1.33-1.89x) and in the cache-fit cells
from xlarge up (1.08-1.29x); they overlap in the small, medium and large
cache-fit cells. Read against the lab:

1. The guide's 1.8x matches DBArena's cache-exceeding cells at 4xlarge and
   8xlarge (1.88, 1.89), not cache fit at 8xlarge (1.29). The guide does not
   name the data-set size; whether its chart is this data set is not stated
   (inference that it is the closest public match, not a confirmed source).
2. DBArena's own `small` cache-fit cell shows no OrioleDB advantage either:
   the run ranges overlap (0.91, OrioleDB lower). Its throughput follows the
   round trip, not the engine: heap runs at 2 clients went 3339 / 5729 / 7303
   tpm at 925 / 479 / 294 microseconds median RTT, and the cell still climbed
   at 12 clients (`sweep-all.tsv`, `cache-fit-small`). Sub-millisecond
   differences between fresh environments moved throughput by more than 2x in
   that cell. OR05's data set (pgbench scale 20, about 0.3 GB on a 2 GB
   instance) was a cache-fit shape at a round trip about 8 to 27 times longer
   (7.1 to 7.8 ms against the 294 to 925 microseconds above, derived), so
   OR05's null result and DBArena's agree.
3. Where DBArena does separate the engines at `small`, the data set is about
   4x RAM: heap peaked at 4 clients and fell to 1292-1461 tpm at 8 clients,
   OrioleDB peaked at 4 and fell to 3961-4233. RTT medians in those runs
   (504 to 915 microseconds) varied without moving the 4-client values much
   (4344-4669 heap). That reads as a server-side bound (storage or buffer
   churn), the regime OR05 never entered (inference from the shape of the
   sweep).
4. Version confound inside DBArena's cache-exceeding cells: OrioleDB ran on
   PostgreSQL 17.11 with `OrioleDB beta 17` (2026-09-25/26); heap ran on
   PostgreSQL 17.6 (2026-09-27/28). The cache-fit heap runs (2026-10-01) were
   on 17.11. The lab's OrioleDB project on 2026-10-10 read 17.6 and `OrioleDB
   public beta 14` (OR01b), so DBArena's OrioleDB build was newer than what a
   default project got then; the `experimental: true` create flag is a
   candidate cause (not checked).
5. `pg_settings` in the `small` cache-exceeding result: `shared_buffers` 12800
   (8 kB pages, 100 MB) on OrioleDB against 65536 (512 MB) on heap. OR01b read
   512 MB `shared_buffers` and 65536-block `orioledb.main_buffers` on the lab's
   OrioleDB project. Memory split differs between the two OrioleDB readings.

## What the lab already covers

- `experiments/orioledb` OR05: pgbench, scale 20, 12 clients, 30 s x 2 runs,
  session pooler, laptop vantage, `ap-southeast-1`, `small`. Same-project pair
  (`oriole_oriole` vs `oriole_heap`) plus a heap-control project. No
  resolvable difference; `tpcb_like` sat at clients / (7 x RTT).
- OR02-OR04: WAL volume and table growth under UPDATE/upsert (OrioleDB wrote
  less WAL and did not grow). These are the storage-side effects DBArena's
  cache-exceeding cells would reward.
- Not covered: any data set larger than RAM, any in-region vantage, any client
  sweep, any run longer than 30 s.

## Proposed experiment: OR12, one cache-exceeding `small` cell

Goal: reproduce the direction of DBArena's cheapest separating cell (`small`,
80 warehouses) and show where the bound sits, with the lab's own evidence.

- Module: `experiments/orioledb/tests/or12-tpcc-exceeding.ts`, self-provisioning
  like OR01 (one OrioleDB project, one heap project, `small`, 20 GB gp3 disk,
  3000 IOPS), deleted by OR99.
- Load generator: `supabase/go-tpc` pinned by commit, `prepare` with 80
  warehouses and 8 threads, then `run` at 2, 4, 8, 12 clients, direct TLS
  connection (`db.<ref>.supabase.co:5432`), never the session pooler (OR05 hit
  its 15-client cap).
- Measure per client count: NEW_ORDER tpm, p95, round trip (`select 1`
  median, as DBArena does), `pg_stat_database` blks_hit/blks_read deltas,
  `pg_stat_io` reads, database and WAL size before and after, and the Metrics
  API's CPU and disk series for the run window. Record `version()`,
  `orioledb_version()`, `shared_buffers`, `orioledb.main_buffers` first.
- Durations: 10 min warm-up and 15 min measurement per client count, 2 runs
  (DBArena: 30 + 60 min, 3 runs). Label results as not comparable in absolute
  terms; the claim under test is the direction and whether the OrioleDB/heap
  ranges separate.
- Vantage decides whether this answers anything. Option A: an in-region runner
  (the `privatelink-aws` `runner.tf` pattern) - blocked, see below. Option B:
  laptop vantage plus the sweep's shape: if heap tpm peaks and falls with more
  clients while RTT is constant, the server is the bound and the ratio is
  meaningful even at a 7 ms round trip; if tpm keeps climbing linearly with
  clients, the cell is round-trip-bound again and the run proves nothing.
  Option B is cheaper and its failure mode is visible in the data.
- Optional control in the same OrioleDB project: a second database with
  `default_table_access_method = heap` loaded the same way, to separate the
  engine from build and architecture (OR01b found the heap control on a
  different Postgres build and CPU architecture).
- Cost: compute is small (the `small` heap result file's `pricing.components`
  entry reads "$15.000/month", with the file's own `pricing.fetched_at`
  2026-09-28, i.e. DBArena's price fetch; divided by 730 h that is about two
  cents an hour, derived); disk overage for 20 GB is cents for a day. The cost is wall-clock:
  data load over a 7 ms round trip is unmeasured, and DBArena's heap `small`
  cache-exceeding iteration (load plus four client counts at 30 + 60 min) ran
  from 08:12:41 to 15:01:55 UTC on 2026-09-27 in-region (derived from the
  result's `started_at`/`completed_at`). Budget one afternoon and run both
  projects in parallel.

Blockers:

- The lab's AWS credentials still answer `InvalidClientTokenId` on `sts
  get-caller-identity` (checked 2026-10-23), so the in-region EC2 runner
  (Option A) cannot be provisioned.
- DBArena runs in `us-east-1`; the lab defaults to `ap-southeast-1`. For
  Option B pick the region with the shortest round trip from the vantage, and
  say so.
- go-tpc's direct connection needs IPv6 from the vantage (logs-volume found
  `db.<ref>.supabase.co` AAAA-only, with Bun's `dns.lookup` failing on it and
  `dns.resolve6` working). Check the Go resolver before the long load.

## Not settled

- Whether the guide's 1.8x figure is DBArena's cache-exceeding 8xlarge cell.
- Whether a default (non-experimental) OrioleDB project now gets PostgreSQL
  17.11 and OrioleDB beta 17 as DBArena's did.
- How many round trips one go-tpc NEW_ORDER transaction makes (sets the
  round-trip bound for Option B); read from the go-tpc source before the run.
