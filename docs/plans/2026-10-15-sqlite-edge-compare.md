# sqlite-edge-compare (2026-10-15) Implementation Plan

> **For agentic workers:** Execute this plan inline, task by task, in the current session. Steps use checkbox (`- [ ]`) syntax for tracking. Per-task subagents (subagent-driven-development) only if the user asks for them.

> **STATUS 2026-10-16: DONE.** Battery run 2026-10-15 and torn down;
> Tasks 0-5 and 7 executed, reviewer findings applied, results committed.
> Results:
> `experiments/sqlite-edge-compare/README.md` (by use case) and `RUNLOG.md`
> (by module); artifacts `experiments/sqlite-edge-compare/out/2026-10-15/`.
> Spend: one Micro project on the Pro org from before the first smoke run
> (04:04 UTC) to `make down` after 07:23 UTC; Turso and D1 inside their free
> allowances.

**Goal:** Measure Turso, Supabase Postgres and Cloudflare Workers + D1 on the
same workloads, from the same vantages, so a "which database for this use
case" answer rests on dated runtime numbers instead of vendor pages.

**Platform question:** For each of seven application shapes (below), what are
the latency, throughput, failure shape and provisioning cost of each backend,
measured from one Cloudflare Worker and from one local client, with all three data
planes in one region: Sydney (Supabase `ap-southeast-2`, Turso
`aws-ap-southeast-2`, D1 location hint `oc`). Turso Cloud has no
`ap-southeast-1` (live `GET /v1/locations`, 2026-10-15), so the lab's usual
Singapore region would put Turso in another country from the other two.

**Architecture:** One new experiment, `experiments/sqlite-edge-compare/`, self-provisioning
like `hyperdrive-direct` and `logs-volume` (no OpenTofu state: Turso has no
provider this lab pins, and the other two are one API call each).

- `lib/fixture.ts up|down` creates one of each backend and writes
  `.fixture.json` (gitignored): a Supabase Micro project (Pro org,
  `ap-southeast-2`), the Turso org's one group in `aws-ap-southeast-2` (Free
  allows one group; none exists yet) with a libSQL database in it, a D1
  database (location hint `oc`; the landing city is undocumented, so
  `served_by_region` is recorded), a Hyperdrive config on the
  Supabase direct string (caching off; a second config with caching on for
  TD02's cached row), and one probe Worker bound to all of it.
- The probe Worker is workload-generic: `POST /run` takes
  `{backend, statements[], params[], repeat, concurrency}`, executes against
  the named backend, times each operation inside the Worker
  (`performance.now()` around the driver call), and returns per-op timings
  plus driver metadata (D1 `meta.served_by_region`/`rows_read`/`rows_written`,
  `request.cf.colo`). Modules ship their own SQL per backend, so modules can be
  written in parallel without touching the Worker. The route rejects any
  request without the per-fixture random `X-Probe-Key` (generated at `up`,
  never written to a tracked file); the Worker is deleted at `down`.
- The Worker runs at the colo nearest the caller (Singapore for the local
  vantage), so every backend sits one SIN-SYD round trip away from Worker
  code; Smart Placement stays off so that distance is the same for all
  three. Rows record `request.cf.colo`.
- D1 caps queries per Worker invocation (1000 on Paid per the D1 limits
  page, a higher subrequest ceiling per the Workers page); `/run` splits
  `repeat` across invocations above 500 so no module trips it by accident,
  and TD02 records the ceiling it actually hits on one deliberate row.
- Backends inside the Worker: D1 binding; Turso via `@libsql/client/web`
  (HTTP); Postgres via Hyperdrive + `pg`; Supabase Data API via `fetch` to
  PostgREST with the secret key. Local vantage: `@libsql/client` (HTTP),
  `pg` against the pooler (transaction mode) and the direct host, D1 via the
  REST query endpoint (admin path; recorded as such, not as an app path).
- Modules `TD01`-`TD08` under `tests/`, each one file, `where: "local"`,
  reading the fixture from `ctx.endpoints`/`ctx.peers`
  (`PVLAB_ENDPOINT_PROBE`, `PVLAB_PEER_TURSO_DB`, ...), which `make probe`
  exports from `.fixture.json`. TD01 provisions its own extra databases.

**Use cases** (two are common D1 shapes: an edge gateway's request-event log
with dashboard aggregates, and a transform-job state table driven by a
queue):

| ID | Use case | What is measured | Backends |
| --- | --- | --- | --- |
| TD01 | Database per tenant / per agent | create-to-first-query time for one DB, then 20 in a burst; plan ceilings hit; delete time | Turso API, D1 API, Postgres schema-per-tenant on one project (and one project-create for scale) |
| TD02 | Point reads (session / config lookup) | p50/p95/p99 of a PK read, n=300 interleaved round-robin, 20 warm-up dropped | D1, Turso, Hyperdrive (cache off, cache on), PostgREST; plus local |
| TD03 | Job-state writes (queue worker) | insert job, 3 status updates, read back; per-op latency; read-your-write after each | same as TD02 minus cache |
| TD04 | Write contention | concurrency 1/4/16/64 single-row inserts and hot-row increments; ops/s, error rate, error text (D1 documents single-threaded databases and an "overloaded" error) | D1, Turso libSQL, Postgres via Hyperdrive; a Turso-engine (`--tursodb`) MVCC row only if the Platform API can create one (no engine field found in its create body: TD04 records which) |
| TD05 | Analytics event log | ingest 100k synthetic events in batches (D1 `batch`, libSQL `batch`, PG multi-row insert), then 5 dashboard aggregates; latency, rows read reported by each vendor | D1, Turso, Postgres |
| TD06 | Search | FTS5 (D1, Turso libSQL) vs `tsvector`+GIN on 10k docs (the Turso engine's Tantivy `USING fts` index is a different surface, out of scope with the engine itself); vector top-10 on 10k x 384-dim (Turso native vector vs pgvector HNSW), recall@10 vs exact; D1 recorded as "no in-DB vector" | Turso, D1, Postgres |
| TD07 | Transaction semantics | interactive transaction from a Worker (expected: D1 batch-only), rollback on error, read-your-write after commit, isolation under a concurrent writer | all three |
| TD08 | Local-first replica | Turso embedded replica on the local vantage: write-at-primary to visible-after-sync lag, local read latency; no D1/Postgres equivalent, recorded as such | Turso |

Not in scope this round (qualitative column in the write-up only, sourced to
docs): Auth/RLS, Storage, Realtime, backup/restore timings (restore-paths
covers Supabase), cost per month (Task 7 derives it from measured rows and
published pricing, offline).

**Fairness rules every module follows:**

- Same schema and the same seeded synthetic data per backend; the seed is a
  module constant.
- Round-robin across backends per iteration, so drift over the run hits all
  of them equally. Warm-up iterations dropped and counted in the artifact.
- Record vantage facts with every row: Worker colo, D1 `served_by_region`,
  Turso location, Supabase region, driver versions.
- n stated on every row; nothing reported as faster or slower unless the
  p50 gap exceeds the run's own spread (p25-p75 do not overlap).
- One battery at a time: modules run in sequence, never in parallel, since
  parallel modules would share the Worker colo and skew each other.

**Tech Stack:** Bun 1.3.14, the pvlab harness (`harness/src/run.ts`), wrangler
4.147.0, `@libsql/client`, `pg`, `sx` for every credential.

---

## Conventions every task relies on

- Run from the repo root. Sensors after every offline task:
  `bunx tsc --noEmit -p harness/tsconfig.json` and `(cd harness && bun test)`,
  both exit 0; experiment unit tests via `bun test experiments/sqlite-edge-compare/lib`.
- Credentials per command, never in argv or files:
  - Supabase: `sx SUPABASE_ACCESS_TOKEN`, org via `PVLAB_ORG_PRO`.
  - Cloudflare: `sx CLOUDFLARE_EMAIL CLOUDFLARE_API_KEY CLOUDFLARE_ACCOUNT_ID`
    (the Global API Key trio H01 uses; a scoped token fails wrangler's account
    lookup on this box).
  - Turso: `sx TURSO_API_TOKEN=TURSO_API_TOKEN` (unmapped item), org slug via
    `PVLAB_TURSO_ORG`. Database tokens are minted at `up` and live only in
    `.fixture.json` and as a Worker secret.
- `.fixture.json` is gitignored and holds refs, hostnames, the probe key and
  the Turso DB token: never quoted into prose. Published artifacts go through
  `make publish-evidence`; check the Turso hostname and D1 database id are
  redacted (the redactor matches Supabase ref shapes only, so extend
  `publish-evidence.ts` or strip them in the module - Task 1 decides).
- Every resource name starts with `sec-` so `make cleanup` can find leftovers
  across all three vendors after a killed run.

## Task 0 - facts sheet (offline) - DONE 2026-10-15

- [x] `docs/research/2026-10-15-sqlite-edge-compare-facts.md`: D1 limits,
  pricing, concurrency and transaction model; Turso engines, plan limits,
  Platform API, live location list; Hyperdrive limits and caching. Region
  choice (Sydney) follows from the location list. The experiment README
  links it rather than copying it.

## Task 1 - fixture and probe Worker

- [x] `lib/fixture.ts` (`up`, `down`, `status`, plus `env`, `cleanup`,
  `literals`) and `lib/fixture.test.ts` (name prefix, fixture-file shape,
  idempotent `down` on a missing resource). Shared modules: `lib/contract.ts`,
  `lib/exec.ts`, `lib/adapters.ts`, `lib/client.ts`, `lib/stats.ts`,
  `lib/vendors.ts`.
- [x] `worker/` source, `wrangler.jsonc` rendered at `up` (gitignored), probe
  key check, `/run` contract, `/meta`.
- [x] Makefile: `gen up down status probe list cleanup publish-evidence`;
  `harness/src/makefile-secrets.test.ts` passes. Redaction decided: the
  publish redactor now matches Turso and workers.dev hosts by shape and takes
  `PVLAB_REDACT_LITERALS`, which `make publish-evidence` fills from the live
  and archived fixtures.
- [x] Live (2026-10-15): `make up`, `/meta` returns all five backends
  reachable (D1, Turso, Hyperdrive uncached and cached, PostgREST);
  `make cleanup DRY=1` lists only the fixture's `sec-` resources.
- [x] Live `make down` and `make cleanup` reporting 0. Executed 2026-10-15
  after TD01: `down` answered 200 for all seven resources and archived the ids
  to `evidence/fixture-ids-<stamp>.json`; `cleanup` printed 0 for all six
  `sec-` resource kinds (RUNLOG "Teardown").

## Task 2 - TD01 to TD08

- [x] One file per module from `bun harness/scripts/new-module.ts`, doc
  comment naming the question, rows, n, cleanup. Pure helpers (percentiles,
  round-robin scheduler, recall@k, synthetic data generators) in `lib/` with
  tests. Executed 2026-10-15: `tests/td01-...` to `td08-...`, each header
  with a "Not settled by this module" paragraph; helpers in `lib/stats.ts`
  and `lib/td*-*.ts` with `*.test.ts` beside them.
- [x] Offline skip-run lists all eight as skipped with a reason. Checked
  2026-10-15 after teardown: 0 pass, 0 fail, 8 skip; TD01-TD04 and TD07 skip
  with ``no .fixture.json: run `make up` (sqlite-edge-compare) first``,
  TD05, TD06 and TD08 on the missing `pat` capability.

## Task 3 - live battery

- [x] `make up`, `make probe IDS=TD02,TD03,TD04,TD05,TD06,TD07,TD08`, then
  `make probe IDS=TD01` (it creates and deletes its own databases),
  `make down`, `make cleanup`. Executed 2026-10-15 04:43-07:23 UTC, one module
  per `make probe`. Re-runs: TD02n after a client fix (Bun's 5-minute socket
  idle timeout, `lib/client.ts`), TD03b (`TD03_TARGETS=turso`) after a
  client timeout, TD05 and TD06 after two local network outages (TD06's
  first run was also all NRT). Canonical artifacts are listed in the RUNLOG.

## Task 4 - write-up

- [x] `pvlab --facts`, `make publish-evidence`, RUNLOG section per module,
  AGENTS.md key-facts block; `check-doc-numbers.ts` clean. Executed
  2026-10-15: 13 artifacts published to `out/2026-10-15/` (canonical runs
  plus the superseded TD05 and TD06 runs and the TD06 smoke run, which the
  RUNLOG cites); a scan of `out/` found no Turso or workers.dev host, UUID,
  email, home path, IP address or fixture literal. `check-doc-numbers.ts`
  (now also matching `TD` ids) flags only the millisecond part of artifact
  file names in the RUNLOG and nothing in the README or the AGENTS.md block;
  an all-lines pass (table rows without a module id) left only docs figures
  and two derived rewordings, since replaced by the measured values.
- [x] Reviewer pass on the diff: the Workflow's adversarial reviewer (Task 6
  step 4) found no identifier leaks and 17 reading or citation problems
  (overlap claims under an adjacent-only `rankBySpread`, Postgres connect
  time excluded from op timings, single-sample ops/s, TD07d and TD08
  inferences stated as fact, three citation mismatches). All applied to
  README, RUNLOG, AGENTS.md and the facts doc the same day; `rankBySpread`
  now lists non-adjacent separations (test added). Not re-measured: the
  Postgres connect exclusion and TD05's fixed query order stay as stated
  caveats until a re-run.

## Task 5 - stocktake

- [x] This plan's status line, README experiment list, board card.

## Task 6 - Workflow shape (how Tasks 1-4 run)

1. Build fixture + Worker (one agent; it owns the shared files) and prove
   `up`/`down` live.
2. Modules in four groups (TD01; TD02+TD03; TD04+TD07; TD05+TD06+TD08), one
   agent each, writing distinct files only; offline sensors per group.
3. One runner agent: the live battery in sequence (Task 3).
4. Write-up agent (Task 4), then an adversarial reviewer that checks every
   number against the artifacts and every documented claim against its URL.
5. Teardown verifier: lists `sec-` resources on all three vendors and the
   Pro org's projects; expects zero.

No commits from the workflow: files are staged and the commit message is
handed to the operator.

## Task 7 - comparison write-up (after the battery)

- [x] Per use case: the measured table, the documented ceilings, and a
  one-line reading that says what the numbers support and what they do not
  (one region, one vantage pair, n per row). Executed 2026-10-15 in the
  experiment README, "Results by use case". Cost per month was not derived:
  the README lists the vendor row counters a cost estimate would need.
