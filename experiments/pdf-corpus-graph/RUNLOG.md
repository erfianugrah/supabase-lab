# RUNLOG - pdf-corpus-graph

Measured on a throwaway project: **Postgres 17.6**, `ap-southeast-1`, **medium**
compute (2 vCPU / 4 GB), 2026-08-10. Every latency carries `instance_size` in its
`measurements`. Treat them as an upper bound - anything a real deployment
provisions is larger.

All figures below come from **one artifact**, `run-2026-08-10T08-45-41-807Z.json`,
so they are internally consistent. Query latencies are `EXPLAIN ANALYZE`'s own
`Execution Time` with the cold first run discarded, not wall-clock around a
cross-region pooler. Numbers are written without thousands separators so they grep
against the artifact verbatim.

**Network-dependent numbers vary between runs.** The G02 fetch and wall times moved
by tens of percent across two runs of the same fixtures. Read them for shape, not
as constants; the DB-side latencies are stable.

---

## The question, and the honest answer

A terabyte-scale archive of unstructured public PDFs has to become a structured,
queryable database of entities and relationships. What can the managed platform
actually do, and what does it cost?

**There is no property-graph store and no Cypher.** Say that plainly. What exists
is a graph-algorithm library over ordinary relational tables, and it answers most
of the questions a property-graph store would be asked.

---

## G01 - what is actually in the extension catalogue

78 available extensions. Two separate facts, because either alone misleads:

| Capability | Status |
|---|---|
| Property-graph store (node/edge storage + traversal language) | **none available**. No `age`, `agensgraph`, `apache_age`, `sqlg` |
| Graph-algorithm library (algorithms over relational edge tables) | **`pgrouting` 3.4.1**, requires `postgis` |

`pgrouting` provides 209 `pgr_*` functions and they are not geospatial-only:
`pgr_dijkstra`, `pgr_depthFirstSearch`, `pgr_breadthFirstSearch`, `pgr_ksp`
(k-shortest paths), `pgr_connectedComponents`, `pgr_strongComponents`,
`pgr_articulationPoints`, `pgr_bridges`, `pgr_transitiveClosure`, `pgr_maxFlow`,
`pgr_kruskal`.

Also present and relevant: `vector` 0.8.2, `pg_trgm` 1.6, `fuzzystrmatch` 1.2,
`unaccent` 1.1, `ltree` 1.3, `rum` 1.3, `pgroonga` 3.2.5, `pgmq` 1.5.1,
`pg_cron` 1.6.4, `pg_net` 0.20.4, `http` 1.6, `pg_partman` 5.3.1, `hypopg` 1.4.1.

Two name collisions to kill before they reach a customer:

- **`pg_graphql` is not a graph database.** It is a GraphQL API over relational
  tables and shares nothing with the question but the word. It is the single
  recorded name collision in the catalogue.
- **`ltree` is not a graph.** It models single-parent hierarchies. An entity graph
  is not a tree.

### A false negative that nearly shipped

The first hand-written probe used `name ~* 'age|graph|route'`, found nothing, and
was about to become the write-up "no graph capability available".

`pgrouting` contains `routi`, not `route`.

One letter, and the conclusion drawn from it was completely wrong. Hence this
experiment's cardinal rule: a test asserts that a probe RAN and recorded
something, never what it found.

### On "just use Apache AGE" and "wait for PGQ in PG19"

Both come up. Both are wrong for a managed deployment, for different reasons.

**Apache AGE is not installable here.** Measured: 78 available extensions, `age`
is not among them. AGE upstream is healthy - releases exist for PG17
(`v1.7.0-rc0`, 2026-02-11) and PG18 (`v1.8.0-rc0`, 2026-07-09), and a PG19 branch
exists - but those are release *candidates*, and none of it matters until the
provider packages it. That is a packaging request to make of the provider, not a
technology gap to design around.

**SQL/PGQ is real, is committed, and does not change the engine.** Committed
2026-03-16, commitfest PG19-Final, status Committed. Three caveats:

1. PG19 is not released. Newest supported major is PG18; this instance runs 17.6.
   So it is PG19 GA, then provider adoption.
2. It is still settling - the commit notes the security-definer variant is not
   implemented, and follow-up patches were failing rebase for months after.
3. **It is syntax, not a storage or execution model.** From the commit itself: a
   property graph is a new relkind that "acts like a view in many ways" and "is
   rewritten to a standard relational query in the rewriter."

That third point is the one that matters. PGQ makes graph queries far nicer to
write - declarative `GRAPH_TABLE` patterns instead of hand-rolled recursive CTEs -
but the plan underneath is the same relational plan measured in G04. Waiting for
PG19 buys ergonomics, not capability, and the capability is available now.

---

## G02 - can an Edge Function extract PDF text, and where does it stop

Yes, up to a hard ceiling, and the ceiling is low.

| Fixture | Source bytes | Result | Wall |
|---|---|---|---|
| `bill-hr3746` | 191290 | ok - 40 pages, 108423 chars | 1902ms |
| `form-1040` | 220237 | ok - 2 pages, 10151 chars | 2973ms |
| `budget-2025-bud` | 2504695 | **ok - 188 pages, 609446 chars. The ceiling.** | 11601ms |
| `cfr-t17-v4` | 3595043 | **HTTP 546 `WORKER_RESOURCE_LIMIT`** | 16906ms |
| `nist-sp-800-53r5` | 6073678 | HTTP 546 `WORKER_RESOURCE_LIMIT` | 4105ms |
| `conan-2022` | 14034445 | HTTP 546 `WORKER_RESOURCE_LIMIT` | 57165ms |
| `budget-2025-app` | 14930674 | HTTP 546 `WORKER_RESOURCE_LIMIT` | 60136ms |

The ceiling sits between **2504695 B and 3595043 B**.

Two details that change how this reads:

- **Extraction is cheap; fetching dominates.** The 2.5 MB success took 11601ms
  wall, of which 9788ms was fetching the PDF and only 1663ms was extracting it.
  Optimizing the parser would be optimizing about 14% of the request.
- **Failure is not size-ordered in time, and not even monotonic.** The 6 MB fixture
  gave up in 4105ms while the *smaller* 3.6 MB one took 16906ms, and the two 14 MB
  fixtures took around a minute each. Do not build a timeout budget on the
  assumption that bigger fails faster.

So the platform's own runtime can host extraction for small documents only. For a
corpus of this shape, extraction runs elsewhere - and "elsewhere" turned out to
matter a lot, see the runtime comparison below.

---

## Runtime comparison - the same extraction on Cloudflare Workers

Same seven fixtures, same `unpdf`/pdf.js build, both V8 isolates. The difference
measured is the runtime's resource envelope, not the parser.

| Fixture | Bytes | Supabase Edge Function | Cloudflare Worker |
|---|---|---|---|
| `bill-hr3746` | 191290 | ok | ok - 40 pages, 108423 chars |
| `form-1040` | 220237 | ok | ok - 2 pages, 10151 chars |
| `budget-2025-bud` | 2504695 | **ok (ceiling)** | ok - 188 pages, 609446 chars |
| `cfr-t17-v4` | 3595043 | HTTP 546 | **ok - 894 pages, 3913385 chars** |
| `nist-sp-800-53r5` | 6073678 | HTTP 546 | **ok - 492 pages, 1550548 chars** |
| `conan-2022` | 14034445 | HTTP 546 | **ok - 2780 pages, 11751448 chars** |
| `budget-2025-app` | 14930674 | HTTP 546 | 1102 / HTTP 503 after 119.67s |

**Workers clears roughly 5.6x more.** The ceiling moves from between
2504695 and 3595043 bytes to between 14034445 and 14930674 bytes.

**The failure was disambiguated rather than reported as "resource limit".** Error
1102 covers CPU *or* memory and the HTTP response cannot tell them apart; the
docs say the split is only visible in analytics. Querying the GraphQL analytics
API for the script returned:

```
status=success         requests=15  errors=0
status=exceededMemory  requests=1   errors=1
```

So it is the **128 MB per-isolate memory limit** (heap plus WebAssembly), not
CPU. CPU was not the constraint: `cpu_ms` was set to 300000, which the docs
confirm is the paid-plan maximum.

### A measurement gotcha specific to Workers

`extract_ms` came back **0 for every fixture**, and that is not a probe bug. In
Workers, `Date.now()` returns the time of the last I/O and does not advance
during code execution - a deliberate Spectre mitigation. Extraction is pure CPU
with no I/O, so it measures as zero by construction. `total_ms` is real because
it spans the fetch. Any in-Worker CPU timing needs an I/O bracket or an external
clock.

Containers and VMs were deliberately not tested: with gigabytes of memory
available the outcome is predictable, so the measurement would not inform the
decision.

---

## Hosting the read UI: Storage cannot, Workers can

The demo UI is fully static and every data call goes browser-to-PostgREST, so it
can live anywhere. Supabase Storage was tried first and cannot serve it.

| | Recorded mimetype | Served `content-type` |
|---|---|---|
| `index.html` | `text/html` | **`text/plain`** plus `x-content-type-options: nosniff` |
| `_astro/*.js` | - | `application/javascript` (correct) |

Storage records the right mimetype and returns the wrong one, and `nosniff`
forbids the browser from correcting it - confirmed by screenshotting the public
URL and seeing raw source rendered as text. The downgrade is HTML-specific and
deliberate: a public bucket accepts arbitrary uploads, so serving HTML as HTML
would make it a stored-XSS surface on the project's own origin. There is no
setting to change it, and the response also carried `cache-control: no-cache`.

The UI therefore deploys as a Cloudflare Workers **static-assets** Worker, which
serves `content-type: text/html` correctly. It is live at
<https://pggraph.erfi.dev> and its config lives in `demo/wrangler.jsonc`.

---

## G03 - the expansion ratio, which was the largest unknown

Every cost projection for this use case rested on a guessed ratio between source
PDF bytes and the Postgres footprint. The guess in circulation was 5% to 20%.

**Measured: 0.048 to 1.0885.** A 22x spread; the aggregate is 0.7633.

| Fixture | Genre | extracted / source | TOAST / logical |
|---|---|---|---|
| `form-1040` | form | **0.048** | 0.4765 |
| `nist-sp-800-53r5` | standard | 0.2573 | 0.3744 |
| `budget-2025-bud` | budget | 0.2775 | 0.4132 |
| `bill-hr3746` | legislation | 0.5799 | 0.3464 |
| `conan-2022` | regulation | 0.8490 | 0.4668 |
| `budget-2025-app` | budget | 0.9049 | 0.3387 |
| `cfr-t17-v4` | regulation | **1.0885** | 0.3896 |
| **aggregate** | | **0.7633** | **0.3965** |

Three things to carry:

- **Extracted text can exceed its own PDF.** Dense regulation came out at 1.0885,
  because a PDF already compresses its content streams. "Text is a small fraction
  of the PDF" is false.
- **Genre does not predict it.** The two `regulation` fixtures came out at 0.8490
  and 1.0885; the two `budget` fixtures at 0.2775 and 0.9049. What predicts it is
  whether the PDF is text-dense and how well it already compressed.
- **TOAST roughly halves it again.** Logical text is 0.3965 of its on-disk size, so
  the 7-document corpus occupies 13131776 bytes for about 40 MB of source PDF.

A projection built on 5% would be wrong by roughly 6x at the aggregate, and by more
than 20x on the worst document.

---

## G04 - traversal with plain SQL, and what the indexes are worth

100000 entities / 400000 edges. Recursive CTE, `EXPLAIN ANALYZE` median. Raw
measurement keys, so these grep against the artifact:

```
index_build_ms=602
depth1_no_index_ms=21.4    depth1_indexed_ms=0.08
depth2_no_index_ms=92.51   depth2_indexed_ms=0.12
depth3_no_index_ms=167.59  depth3_indexed_ms=0.22
cooccurrence_no_index_ms=60.1  cooccurrence_indexed_ms=0.1
```

Depth-3 traversal goes from about 168 milliseconds to about a fifth of one, on a
602 millisecond index build over `edges(source_id)` and `edges(target_id)`.

Reporting only the fast column would hide the entire design decision, which is why
both are recorded. Sub-millisecond depth-3 traversal on a 2 vCPU instance is the
number that matters for "can Postgres answer graph questions".

---

## G05 - vector index shape

30000 chunks at 1536 dimensions. Vector *values* are synthetic; storage, build time
and latency are value-independent, so those are valid. **Recall and result quality
are not measurable this way and are not claimed.**

```
hnsw_build_ms=6950     hnsw_index_bytes=241475584     hnsw_query_ms=0.43
ivfflat_build_ms=4130  ivfflat_index_bytes=247398400  ivfflat_query_ms=46.13
ivfflat_lists=100
vector_table_bytes=250650624  halfvec_table_bytes=126377984
halfvec_vs_vector_ratio=0.5042
```

HNSW builds slower and queries about a hundred times faster at these settings.

**`halfvec` is 0.5042 of `vector`** on tables with identical columns. That matches
the 2-byte against 4-byte element width, so it is a clean halving of vector
storage.

---

## G06 - the disk ceiling question is still open

Probed several endpoint shapes rather than guessing one:

| Endpoint | Result |
|---|---|
| `/projects/{ref}/billing/addons` | **200** - the only one carrying disk fields |
| `/projects/{ref}/config/database` | 404 |
| `/projects/{ref}/database` | 404 |
| `/projects/{ref}/database/disk` | 404 |
| `/projects/{ref}/disk` | 404 |

What `billing/addons` returns is disk **throughput**, not a size ceiling:
`baseline_disk_io_mbs=347` and `max_disk_io_mbs=2085` on the selected addon.

**So "can one project hold a corpus of this order" remains unanswered.** Recorded
as an open gap rather than inferred from the endpoints that 404'd - which is the
mistake `platform-facts` F05 already recorded once.

---

## G07 - pgrouting on a plain, non-geospatial entity graph

It works. No geometry column, no spatial index; node ids are ordinary `bigint`.

```
dijkstra_ms=1092.61          (g04_depth3_ms=0.23 for contrast)
components_query_ms=1098.11
bridges_query_ms=9883.44     bridge_count=254
```

Installing it pulled in nothing new on the re-run - `postgis` was already present
from the first install, and it is a hard dependency.

The Edges SQL contract requires columns named exactly `id`, `source`, `target`,
`cost` (`ANY-INTEGER` for the first three, `ANY-NUMERICAL` for the costs). Note
`ANY-INTEGER`, not `bigint` specifically - an earlier draft of GUIDE.md overstated
that. The practical consequence holds either way: a `uuid` primary key cannot be
handed to `pgr_*` without a surrogate integer key, and naming columns
`source_id`/`target_id` forces an aliasing subquery at every call site.

**The dijkstra figure against the CTE's is not a fair comparison and must not be
quoted as one.** They answer different questions: the CTE expands a bounded
neighbourhood, `pgr_dijkstra` computes a global shortest path over the whole edge
set. Use the CTE for "who is near this", pgrouting for "what connects these two,
and what is structurally critical".

---

## Cost shape

Read-heavy, batch-loaded, low write volume - a good fit for one well-provisioned
instance with read replicas if query concurrency grows.

Two design levers the numbers make concrete:

- **Disk throughput** is separately provisioned (`baseline_disk_io_mbs=347`,
  `max_disk_io_mbs=2085`), so it is a real choice for a large read-heavy corpus
  with vector indexes.
- **`halfvec`** is a measured 0.5042 multiplier on vector storage.

The source-corpus size is **not** the database size. The Postgres footprint is the
extracted structure, and TOAST takes that to 0.3965 of logical text size.
Conflating the two is the most common error in reading this use case.

---

## Method notes worth keeping

**A fully green run is not a correct run.** Every sensor passed on iteration 1,
including the LLM judge, while five measurements were corrupted. `lib/pg.ts` sent
`set statement_timeout='600s'; <sql>` in one `psql -c`; psql prints the command tag
for a SET even under `-At`, so every result carried a phantom leading row `["SET"]`
and `scalar()` returned the string `"SET"` for every query. Symptoms: a fixture
count of 8 instead of 7, a genre named "unknown" with one member, null byte-sizes
throughout G05, a `halfvec` ratio rendering as "unknown", and `Number("SET")`
reaching `pgr_dijkstra` as NaN, where Postgres answered
`column "nan" does not exist`.

It survived because the defect was in the shared helper - in the BASE, not the diff
- so the judge never saw it, and the per-test sensors assert that a measurement
EXISTS rather than that it is coherent. `"SET"` and `null` are both perfectly
present values. That hole is by construction, not bad luck.

Two candidate fixes were measured and rejected. **`PGOPTIONS` does not survive the
transaction pooler**: through 6543, `show statement_timeout` reports the role
default of `2min` whether it is set or not, so it fails silently. A single `-c` with
`begin; set local ...; commit` trades one phantom tag for three. The SET now goes
in its own `-c` (verified by a 250 millisecond timeout cancelling `pg_sleep(2)`)
and `-q` suppresses the tag. **`-q` is load-bearing** - removing it silently
restores the original bug.

**`verify-sensors` found five gates that gated nothing** before any budget was
spent: `harness/tsconfig.json` never included `../experiments/*/lib`, so helper
files went unchecked until some test imported them; `bun run gen` globs `tests/`
without parsing, so a file of garbage regenerated the registry happily and only
`bun run build` caught it; and two artifact-reading sensors derived assertions from
a JSON file a *different* sensor produced, so planting a fault could never flip
them.

**`find /` inside the loop's sandbox consumed a whole 40-minute agent budget.** The
agent was hunting Postgres extension files on the client machine - where the
database is remote managed infrastructure and those files do not exist at any
speed. The catalogue was the only possible source of that answer.

---

## Cold rebuild - one command, measured

`make up` goes from nothing to a working pggraph.erfi.dev: `tofu apply`,
`wait-ready`, then `scripts/seed.sh` (extensions, corpus schema, seed restore,
citation extraction, API, security, PostgREST exposure, generated `.env`, build,
wrangler deploy).

**Measured end to end at 446s** against a project that was destroyed and then
recreated, which also closes the two previously-unmeasured cold-rebuild steps:
`tofu apply` provisioning was 4s and the seed restore was 1s. The dominant step
is citation extraction (338s), then Cloudflare deploy propagation and the
PostgREST schema-cache reload.

The rebuild caught four drift bugs that only existed because the system was
assembled interactively and never rebuilt from files: `seed.sh` did not fail
fast (`set -u` only, so a broken phase logged and the next ran on missing
output); the `pg_trgm` relocation raced its own creation; no `demo/db/*.sql`
pinned a `search_path`, which a fresh database over the pooler needs; and
`04-api.sql` still granted on the dropped `v_documents` view. The definer
markers and the tiered search ranking now live in `04-api.sql` rather than in an
interactive psql session, which is why a rebuild no longer silently reverts
exact-match ranking to 1.0.

What `make up` does NOT reproduce: the Cloudflare custom-domain route for
pggraph.erfi.dev. That lives in Cloudflare's state, not the demo's, so destroying
the Supabase project alone is safe - a rebuild just repoints the data. Tearing
down the Worker or its route would need a separate step.

---

## Open gaps

As of 2026-08-10 the project is **parked**, not finished. These are the known
open items, in the order they matter:

- **Editorial entity extraction (Track B).** The demo extracts citations, not
  people or organisations, so it proves the mechanism without answering the
  editorial question. The cross-document "who appears in more than one document"
  panel is unbuilt.
- **Scanned PDFs (G09).** The corpus in scope spans decades, and the early end is
  likely scanned. form-1040 yielded 4.8% text and zero entities; OCR is needed
  and is not available in-database.
- **Maximum disk size for a single project (G08).** G06 found throughput fields
  only. The ceiling question is the largest open commercial risk.
- **Traversal under concurrency (G10).** Every latency here is single-query and
  uncontended.
- **Recall for the vector indexes.** Synthetic vectors cannot support it; needs a
  real embedding model over the real corpus.

The loop for G08/G09/G10 and Track B is queued but the Anthropic API is
rate-limited until 2026-09-01, so those were parked rather than hand-built under
time pressure. See docs/plans/2026-08-10-pdf-corpus-graph-hardening.md for the
exact resume command.

## Teardown and teardown-cost

`make destroy` removes the Supabase project and is proven safe: `make up`
rebuilds the whole thing in 446s. The one thing `make up` does not reproduce is
the Cloudflare custom-domain route for pggraph.erfi.dev, which lives in
Cloudflare state rather than this repo - destroying the project is safe, tearing
down the Worker needs a separate step.

The throwaway project is `medium` compute in ap-southeast-1 and bills while it is
up. Because a rebuild is 446s and one command, destroying between sessions is a
genuine option rather than a destructive one.
