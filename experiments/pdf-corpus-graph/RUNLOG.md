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

## Search tier - document text search + cross-document discovery

Added 2026-08-11. Two new read-only RPCs following the established contract
(security definer, pinned search_path, execute granted to anon+authenticated).

### search_documents - keyword search over extracted text

`search_tsv` is a generated column (`to_tsvector('english', coalesce(extracted_text, ''))`
stored) with a GIN index. Query uses `websearch_to_tsquery` which tolerates raw
user input (quotes, stray operators) instead of erroring.

```
index_size=3192 kB
search_documents_exec_ms=112.6 (median of 3 warm runs; cold discarded)
instance_size=medium
```

Measured via EXPLAIN ANALYZE on the inner query directly (security definer
functions do not inline, so the function-call EXPLAIN reports only "Function
Scan"). On 7 rows the planner chooses a sequential scan; the GIN index is
present (3192 kB) and the generated-column + index pattern is what scales to
real corpus sizes.

### cross_document_entities - the discovery surface

20 of 1521 entities appear in 2+ documents (18 in 2, 2 in 3). Each row carries
the document slugs so the UI can render them without a second query.

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

## Track D measured findings (2026-08-11, via the loop + re-run)

**G08 - disk ceiling (unanswered, recorded).** 3 Management-API endpoints probed
(`projects/{ref}/billing`, `projects/{ref}/billing/addons_test`, `projects/{ref}/addons`):
the first and the addons_test return 200, the other two 404. No disk-size field
exists on any surface; `max_disk_io_mbs` on addons_test is THROUGHPUT, not size
(the G06 lesson, correctly not counted). Ref-qualified controls answer 200 in the
same run, so the 404s are surfaces-that-don't-exist, not auth failures. Conclusion:
a project's maximum disk size is not discoverable through the Management API
today. The single-project-can-hold-this-corpus risk remains open (this was always
the honest expected outcome per the plan).

**G09 - scanned-PDF detection threshold (measured).** New fixture
`jfk-104-10004-10143` (NARA image-only scan, 415,346 B, 2 pages) run beside two
born-digital references: scanned=0.5 chars/page vs born-digital [2710.6, 3241.7].
Threshold candidate: **documents under ~270 chars/page are image-only / scanned**.
OCR is REQUIRED for the pre-1990 end of the corpus and is unavailable in-database
(plpython3u absent from `pg_available_extensions`, verified by query not recall
- the judge's fix). A real pipeline routes below-threshold docs to external OCR.

**G10 - traversal under concurrency (no knee).** G04's depth-3 C pulled at
c=1,4,16,64 on the reused 100k/400k graph: aggregate p50=0.29ms, p95=3ms,
0 errors / 85 queries. p50 holds flat ~0.3-0.7ms to c=64; p95 grows to 2.9-3.6ms
then holds. No knee on a 2-vCPU medium - the graph fits working memory
(medium instance). Prior single-query timings were representative (G04's
0.32ms depth-3 number matches c=1 here).

## sbperf audit (2026-08-11, pre-teardown)

PAT-mode audit with the new vector/query-shape findings (sbperf 60f17bc).
Evidence (local only, evidence/ is gitignored): sbperf-2026-08-11-analysis.json,
sbperf-2026-08-11-report.html. Headline: 3 high (pdf-extract-g02 57% 5xx = the
known shared-cpu-2x OOM; definer view; RLS off - both throwaway-project posture),
disk 88% full (known). The graph schema itself is clean: all FKs covered by the
traversal indexes (zero fkUnindexed hits on entities/mentions/edges after the
zero-based-indkey fix; the 8 remaining hits are the unrelated game-benchmark
schema co-hosted on this project). NOT visible to pgss: every recursive-CTE
traversal - they run inside SQL functions and pg_stat_statements.track=top only
records top-level calls, so zero traversal statements appear in top-by-time.
Lesson recorded in the sbperf heuristics (585f613).

## Teardown (2026-08-11)

`make destroy` - supabase_project.probe (mliyxhgwobcurlssgfdu, medium,
ap-southeast-1): plan 0 add / 0 change / 1 destroy, applied; ref unreachable,
tofu state gone. The Cloudflare Worker serving pggraph.erfi.dev was left up as
a separate wrangler step, with the demo redeployed to explain the dead backend
("data source unavailable" error state, 6f527aa). Rebuild is `make up` (~446s).

## Demo-readiness review (2026-08-14)

A review of the demo against the editorial use case it stands for produced a
gap list, folded into docs/plans/2026-08-14-pdf-corpus-graph-demo-readiness.md
as the next iteration (Tracks E-H). Headline: the demo's clean half
(citations, 1521 entities, regex-exact) is not the half the use case asks
about (people and organisations, graded NOISY at B1); cross-document bridging
is 1.3% (20 of 1521 entities in 2+ documents); there is no time axis on edges;
and "it works" (seven real documents) and "it is fast" (synthetic
100000/400000 graph) are two claims resting on two different artifacts that
one ~100-document real-pipeline run would fuse. The open-gaps list above is
superseded by that plan.

## Editorial layer + AU corpus (2026-08-14, ap-southeast-2)

The project was rebuilt in ap-southeast-2 (the deployment-target region; the
G01 catalogue probe ran there as part of the live suite, which is also the
G13 re-verification) and the corpus is no longer US-federal-only: 103
Inverell Shire Council (NSW) public documents joined the seven US fixtures,
enumerated via the council's open WordPress media API, dated from filenames,
and loaded by scripts/load-au-corpus.ts with the manifest committed at
demo/seed/au-corpus.json. Two tender notices are image-only scans and went
through the loader's OCR path (pdftoppm + tesseract) under the G09
chars/page threshold - the G14 OCR path, exercised by construction rather
than built as a feature. Corpus is now 111 documents (103 AU + 7 US + the
scan fixture).

The editorial layer (demo/db/08-editorial.sql) adds: AU person/org patterns
(Cr/Councillor/Mayor honorifics, Pty Ltd suffix - case-flexible after the
first pass missed all-caps resolution text in 3 of 103 docs), ABN extraction
with the mod-89 checksum as a hard gate, doc_date on mentions+edges (backfill
+ BEFORE INSERT trigger, so extractors and build_edges stay untouched), and
four read RPCs: entity_timeline, neighbourhood_as_at, bridges_as_at,
entity_registry_ids. Measured on the live project after the run:

- AU person/org extraction over 103 docs: 292 distinct persons and 123
  distinct organisations with inv-* mentions (853/2410 totals with the US
  docs). Wall clock for the full re-extract (persons/orgs over the AU docs,
  ABN over all 110, build_edges, refresh_counters): 31.6s.
- ABN: 148 digit-group candidates across the corpus, 14 valid mentions, 134
  rejected by checksum, 3 distinct ABNs (45 153 592 173 WRWF; 89 001 288 400
  and 26 436 588 133 from the tender notices). Zero false positives survive;
  that is the deterministic-resolution claim, made of arithmetic.
- The closed loop closes: entity_registry_ids on WHITE ROCK WIND FARM PTY
  LTD returns 45 153 592 173 via the co-proximity edge in
  inv-wrwf-ccc-2015-08-06. The 2022-02-23 ordinary minutes (item 9.5) put
  three councillors' nominations to the WRWF Community Fund on the record;
  all three are person entities with mentions spanning the corpus.
- Bridging, the number the citation corpus never had: Cr Wendy Wilks appears
  in 93 documents, Cr Paul King 88, Cr Paul Harmon 87, Cr Kate Dight 86. (Top
  of the list is also the honest-noise exhibit: "Director Corporate" spans 92
  documents, an over-capture of the US Director pattern against AU
  job-title text.)
- As-at discrimination: the Hines organisation entity has 0 depth>0
  neighbours as at 2020-01-01 and 171 as at 2026-12-31. The two organic
  spellings HINES CONSTRUCTION PTY LTD / HINES CONSTRUCTIONS PTY LTD survive
  as two entities, the fuzzy-resolution case the corpus provides for free.
- Per-genre expansion ratios (AU): council-minutes 0.0238, committee-minutes
  0.0362, contracts-registers 0.0289, tender-notices 0.0011. Aggregate AU
  0.0256 against the US federal corpus's 0.7633 aggregate - genre swings the
  ratio by 30x, which is why the cost model is per-genre measured or nothing.
- Loop incident, recorded because it is instructive: during loop iteration 2
  the agent ran its own edited seed.sh against the live project, whose
  unrequested truncate lines wiped corpus.documents (and cascade-wiped
  demo.mentions/edges), then re-seeded the US fixtures and re-extracted -
  silently dropping the AU corpus. The scope fence watches files, not SQL
  side effects. Recovery was the loader (cache-warm) plus re-extraction; the
  truncate lines are removed and the rebuild path is make up, not make seed,
  on a populated project.

## The fusion run's first real finding (2026-08-14)

The first traversal measurement on the REAL graph falsified the synthetic
benchmark's transfer: demo.neighbourhood() at depth 3 from a degree-917
councillor (attendance lists clique the whole chamber, so co-occurrence
graphs of minutes have genuine hubs) ran 65,721 ms. The synthetic 100k/400k
graph (average degree 8) never showed it: the walk enumerated PATHS (union
all), and paths explode as degree^depth only when hubs exist. The fix is
set semantics - a level-set UNION keeps each (id, depth) once and bounds
the frontier by nodes, not paths. Same rows out: 344-node depth-3
neighbourhood now 155-159 ms server-side on the 28778-edge real graph,
measured warm over the pooler. Both demo.neighbourhood() and
demo.neighbourhood_as_at() carry the fix; signatures unchanged.

This is the finding the ~100-document run existed to produce: "it works"
and "it is fast" now rest on one artifact, and the price was one real bug
class the synthetic graph could not reveal.

## Editorial UI + edge cache (2026-08-14)

The read surface is now the editorial graph: person/org/ABN kinds with their
own colours, an as-at date filter on the cross-document panel, an entity
timeline, registry-identifier pins, a radial node-link graph over subgraph()
(radial labels, top-24 nodes by weight with top-3 edges each - hub cliques
make full edge sets a hairball: 120 nodes/6561 edges on the deepest
councillor), client-side pagination on the long tables, <details> collapse on
the document slug lists, and refresh-stable deep links (?entity=<id> written
by replaceState on selection; hydrated on load via the new demo.entity_get()
lookup RPC).

Two bugs found by looking at the deployed site rather than the code:

- demo.documents() was a ghost: referenced by the UI, the README and a
  comment in 04-api.sql, defined in no committed file - it had only ever been
  created by hand in a past live database, so every fresh rebuild shipped a
  corpus table 404ing with PGRST202. Now defined in 04-api.sql and granted.
- First cache deploy: every request a permanent MISS because the Cache API
  rejects put() of responses carrying Set-Cookie, and Cloudflare's edge adds
  __cf_bm to everything. The put threw inside waitUntil, invisible. Strip
  set-cookie on the stored copy.

The worker now runs a 90-line script owning /rest/* only: POST bodies hashed
into synthetic GET cache keys (the documented Cache-API POST pattern), 6h
freshness tracked via x-cached-at, and serve-stale regardless of age when the
origin errors - the demo now keeps answering while the disposable project is
destroyed between engagements. x-pggraph-cache: HIT/MISS/STALE on every RPC
response; MISS->HIT verified on the deployed domain. seed.sh deploys with
--var ORIGIN so the project ref stays out of committed files.

## E2E suite (2026-08-14)

demo/e2e/ (Playwright, serial, against the live deployment): landing,
bridging (as-at empties and restores the table), entity (graph renders,
timeline dated, refresh persists selection, shortest path), search (entity
search -> White Rock org -> the ABN 45 153 592 173 pin appears - the closed
loop proven from a browser; document search), offline (route-abort -> the
DIAGNOSTIC panel). Loop-built on the local rung; see the loop plan and the
defect review for what the rung did and did not do.

## G12 - cost per document (2026-08-14)

All inputs measured this engagement; list rates dated 2026-08-10.

- AU council corpus: 103 docs, 44,317,522 source bytes -> 1,134,495 extracted
  bytes (aggregate 0.0256; 0.4893 after TOAST, measured on the loaded rows).
- Per document, this genre: ~430 KB source, ~11 KB logical, ~5.4 KB on disk.
  Disk: 5.4 KB x $0.125/GB/mo = $0.0000007/doc/mo. Raw PDF in Storage:
  430 KB x $0.0213/GB/mo = $0.0000092/doc/mo. Call it a cent per thousand
  documents per month, Supabase side, plus compute (not priced here).
- Their 4 TB at the minutes-like ratio: ~102 GB logical -> ~50 GB disk ->
  ~$6/mo gp3 + $85/mo raw storage = ~$92/mo. At the US federal corpus's
  0.7633 aggregate ratio the same 4 TB was ~$239/mo. Genre swings the cost
  projection 2.6x between two measured corpora - the per-PDF conversation is
  unanswerable until their own genres are sampled, which is exactly the
  100-document run argument.
