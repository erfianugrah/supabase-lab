# GUIDE.md - binding conventions for experiments/pdf-corpus-graph

Read this before writing any test in this experiment. Every loop iteration is a
fresh context; this file is the only thing that carries conventions between
them, so it is binding rather than advisory. `tests/g01-graph-engine-inventory.ts`
is the worked reference - copy its shape.

## The question this experiment exists to answer

A large archive of unstructured public PDFs (order of terabytes, spanning
decades: legislation, regulation, budget and financial filings, standards) has
to become a structured, queryable database - entities and the relationships
between them - so that tooling built on top can ask "who is connected to whom".

The division of labour being evaluated is: the extraction pipeline (PDF -> text
-> named entities -> edges) is CUSTOMER-OWNED code, and the database is the
destination and the query layer. This experiment measures what the platform
side of that line can actually do, and what it costs.

It is deliberately generic. No customer, account, deal or individual is named
anywhere in this directory, and nothing here may reference one.

## The one rule that matters most

**A sensor, a test, or a measurement may never encode the answer it expects.**

This experiment was commissioned off a documentation search that returned zero
hits for graph and PDF capability, and the tempting thing to build is a suite
that confirms it. Two reasons not to:

1. It has already been wrong once, in this file's own authoring. A hand-written
   probe used the regex `name ~* 'age|graph|route'` against the extension
   catalogue, found nothing, and nearly produced the write-up "no graph
   capability available". `pgrouting` contains `routi`, not `route`. G01's
   exact-name check found pgrouting 3.4.1 - a full graph-algorithm library -
   immediately. The regex was one letter from correct and the conclusion drawn
   from it was completely wrong.
2. A test that asserts the expected value goes red on the day the platform
   changes, which is exactly the day someone needs to be told.

So: **assert that the probe RAN and recorded something. Never assert what it
recorded.** Put the finding in `measurements`, where `pvlab --diff` will report
the day it moves. Use `status: "info"` for anything where there is no correct
value (a catalogue, a price, a ratio, a latency). Reserve `pass`/`fail` for
genuine invariants - a shape claim, a round-trip, an assertion with a control.

A measured `fail` is data. Never retry it to green, never soften it, never
delete the measurement that produced it.

## Test module contract

- One file per test under `tests/`, default-exporting a `TestModule`. Helpers go
  in `lib/`. A helper placed under `tests/` becomes an undefined registry entry.
- Ids in this experiment use the `G` prefix (`G01`..`G07`). Every other prefix
  is taken: C, D, E, F, P, R, S, T, V and X are all in use by other experiments,
  and ONE registry spans all of them, so a colliding id makes `--only` select
  another experiment's test as well. Sub-results use the `G0na`, `G0nb` suffix
  form.
- `where: "local"` for everything here - there is no AWS runner in this
  experiment.
- `requires` must be accurate. A missing capability must produce a `skip` WITH A
  REASON in `detail`, never a silent pass and never a `fail`. A silent skip is a
  test that asserts nothing while looking fine.
- `measurements` values are `number | string` only. Coerce booleans with
  `String()`.
- Anything expensive, mutating or slow (loading fixtures, building an index,
  deploying a function) must be idempotent: the loop re-runs the suite every
  iteration, so a test that re-loads 200k rows each time turns a 4-minute gate
  into a 40-minute one. Create-if-not-exists, and record whether the work was
  done or reused.

## Vantage and connection

- `lib/pg.ts` is the only way to reach the database. `q`, `scalar`, `file` for
  statements; `medianExecMs` for anything timed.
- **Never time a query by wrapping the client call.** `medianExecMs` reads
  `EXPLAIN ANALYZE`'s own `Execution Time` and discards the first (cold) run.
  Wall-clock around psql over a cross-region pooler measures process startup and
  TLS, which is most of a fast traversal query.
- Every latency or throughput measurement must carry `instance_size:
  instanceSize()` in its `measurements`. These numbers get quoted at corpus
  sizes far larger than the one they were taken on; the compute they were taken
  on has to travel with them.
- The connection is the transaction pooler on 6543. Session-level state
  (temp tables across statements, `SET` outside a transaction, advisory locks)
  does not survive between calls.

## The corpus

`lib/fixtures.ts` holds seven public-domain US federal documents spanning
191 KB to 15 MB across five genres. Use it; do not invent fixtures.

- Fetch with the `UA` constant. `nvlpubs.nist.gov` returns 404 to a
  non-browser User-Agent, which presents as a dead link rather than a block.
- `expectBytes` is the Content-Length observed 2026-08-10. A mismatch means the
  upstream document was revised - report it, do not silently proceed, or an
  expansion ratio will move for a reason nobody can reconstruct.
- Genre matters more than size for extraction difficulty. A form is a
  positioned layout with almost no running text; a budget appendix is a wall of
  tables; an annotated constitution is prose with a citation apparatus. A ratio
  measured on one genre does not transfer, so report per-genre as well as
  aggregate.

## Schema conventions

All experiment tables live in the `corpus` schema, created idempotently.
The shape under test is the ordinary relational one:

- `corpus.documents` - one row per source PDF (slug, genre, source bytes,
  extracted text, extraction metadata).
- `corpus.entities` - one row per distinct entity. Needs a `bigint` surrogate
  key: pgrouting's algorithms require `bigint` node ids, so a uuid-only entity
  table cannot be handed to them without a join table.
- `corpus.edges` - `(source_id bigint, target_id bigint, cost double
  precision, ...)`. Those three column names are not stylistic - pgrouting's
  functions require exactly `id`, `source`, `target`, `cost` (and optionally
  `reverse_cost`) in the inner edge SQL. Naming them anything else means every
  call site needs an aliasing subquery.
- `corpus.chunks` - text chunks plus their embedding vectors.

## Embeddings without an embedding provider

Vector STORAGE cost and index behaviour are independent of the vector's values:
a 1536-dimension `vector` occupies the same bytes whether it came from a real
model or from `random()`. So this experiment generates synthetic vectors rather
than depending on an external embedding API, a key, or its rate limits.

State this explicitly in any test that does it. What synthetic vectors CANNOT
measure is recall or result quality - random vectors have no semantic
structure, so any "did it find the right neighbour" claim is invalid. Measure
storage, build time, index size and query latency. Do not measure quality.

## Anti-patterns specific to this experiment

- Do not offer `pg_graphql` as a graph-database answer. It is a GraphQL API over
  relational tables and shares nothing with the question but the word.
- Do not present `ltree` as a graph. It models hierarchies (single-parent
  trees). An entity graph is not a tree.
- Do not conflate "available in `pg_available_extensions`" with "installs and
  works". G01 records availability; anything that depends on an extension must
  install it and use it, and record what the install pulled in (pgrouting
  cascades postgis).
- Do not report the source-corpus size as the database size. The Postgres
  footprint is the extracted structure, which is a different and much smaller
  number, and conflating them is the single most common error in reading this
  use case.
- Do not oversell vector search as an answer to entity extraction. They are
  different operations; naive retrieval-augmented generation over a corpus like
  this is a known-inadequate answer to a structured-query requirement.

## Hygiene

Nothing account-specific anywhere: no project refs, org ids, tokens, AWS
account ids, public IPs, customer names, individual names, or deal context.
`evidence/` is gitignored because reports carry refs and hostnames. The
`hygiene` sensor matches by SHAPE - never interpolate a real secret value into
a check to make it pass.
