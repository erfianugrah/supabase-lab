# corpus-graph-demo

**Live: <https://pggraph.erfi.dev>**

A document corpus turned into a queryable citation graph in Postgres. Seven
public-domain US federal documents (legislation, regulation, budget, standards,
a tax form), extracted to text and indexed as entities, edges and byte-exact
provenance. Traversal is a recursive CTE; shortest path and connected components
are pgrouting over the same ordinary edge table.

No graph database. No bespoke API server. No LLM in the extraction path.

## What it demonstrates

| Question | Answered by |
|---|---|
| Who is connected to whom, and how closely? | `neighbourhood()` - recursive CTE, depth-capped |
| What is the strongest link between two things? | `shortest_path()` - `pgr_dijkstra`, cost = 1/co-citation weight |
| Does the corpus cluster? | `components()` - `pgr_connectedComponents` |
| Why does this node exist? | `provenance()` - document + exact character offset + source snippet |
| Find a thing despite a typo | `search_entities()` - tiered exact / punctuation-insensitive / prefix / trigram |
| Search document text for a keyword | `search_documents()` - websearch_to_tsquery over a generated tsvector column |
| Which entities bridge multiple documents | `cross_document_entities()` - the discovery surface for a new user |

## Numbers from the loaded corpus

4,806 entities across the four citation kinds plus person/org
(798 statutes, 359 Public Law numbers, 328 NIST control ids, 36 CFR references,
561 persons, 2,284 organizations from 06-entities-people-orgs.sql). Person and
organization extraction uses honorific-prefixed names (Mr, Ms, Senator,
Representative) and organization suffixes (Inc., LLC, Corporation, Commission,
Authority, Department of X).

**Precision note:** Citation extraction is exact (zero hallucination). Person
and organization extraction via deterministic regex patterns is NOISY -- this is
a measured finding, not a defect to tune away. A live sample of 24 random
person/org mentions: roughly half of the person labels are truncated by the
2-word name pattern ("Justice John" for Justice John Paul Stevens), several org
labels are split across a line break ("Department of\nTransportation"), and
occasionally an entire sentence matches an org suffix ("President was precluded
from influencing the Commission"). The patterns are included to prove the
extraction machinery handles entity kinds beyond citations, NOT as a production
extractor. The extracted surface forms are usable as a candidate set for a
human or LLM pass, but are not trustworthy as canonical entities. The useful
deliverable from Track B1 is the honest measurement that deterministic regex
org/person extraction on this corpus sits well below citation-extractor
precision.

The extracted-text-to-source-PDF ratio spans **0.048** (a positioned tax form,
which yields almost no running text) to **1.0885** (dense regulation, where the
extracted text is larger than its own PDF because PDF already compresses its
content streams). Source size does not predict database size, and the aggregate
ratio of 0.7633 hides that 22x spread.

## Architecture

```
public PDF -> extracted text (corpus.documents)
           -> citation extraction, set-based SQL      (demo.extract_document_fast)
           -> entities + mentions with exact offsets  (demo.entities, demo.mentions)
           -> co-citation edges within 400 chars      (demo.build_edges)
           -> 7 read-only Postgres functions
           -> PostgREST over HTTPS
           -> Astro static + one React island
```

The API is the database. Each endpoint is a Postgres function that PostgREST
exposes; there is no API tier to deploy or scale separately.

## Why extraction is deterministic here

The general case for document-to-graph is LLM triple extraction, and every
serious pipeline in the field works that way. This corpus is the special case
where that is unnecessary: US federal legal and regulatory documents carry
cross-references as explicit, grammatically fixed citations (`AC-1`,
`5 U.S.C. 552`, `17 CFR 240`, `Public Law 118-15`). Those are regex-exact, so
every entity and every edge is verifiable against the source bytes with no
hallucination and no review step.

That is a property of this corpus, not a general claim. Open-domain entity
extraction needs a model pass, entity resolution by embedding similarity, and a
human review stage.

The edge definition is also deliberately weak and stated as such: co-occurrence
within a character window is not a typed relationship. An LLM pipeline would
produce `{subject, predicate, object}`. This demo shows the graph *layer* on real
data, and proximity is enough to produce a real topology to traverse.

## Security model

The anon key is public by design. That role can execute exactly seven read-only
functions and can select from **no table at all** - raw table access returns
`42501`. The functions are `SECURITY DEFINER` with a pinned `search_path`
specifically so anon never needs rights on the underlying document text; granting
`select` on `corpus.documents` would otherwise expose the full extracted text of
every document through PostgREST's auto-generated table endpoint.

## Running it

```bash
cp .env.example .env      # fill in PUBLIC_SUPABASE_URL + PUBLIC_SUPABASE_ANON_KEY
bun install
bun run dev               # localhost:4321
bun run check             # astro check + tsc
bun run build
```

## Deploying it

```bash
bun run build
CLOUDFLARE_ACCOUNT_ID=<account> wrangler deploy
```

An assets-only Worker - no `main` script, because every byte served is a file and
every data call goes from the browser straight to PostgREST. Putting a script in
front would add a billable invocation ahead of static bytes for no gain.

`not_found_handling` is deliberately left at its default, so an unknown path
404s. This is a single-page STATIC site, not a client-routed SPA; setting
`single-page-application` would return `index.html` with 200 for every typo and
hide broken links.

### Why not Supabase Storage

Measured on the project, not assumed. Storage **records** `index.html` as
`text/html` and **serves** it as `content-type: text/plain` with
`x-content-type-options: nosniff`, so a browser renders the source as text. JS
and CSS serve with correct types, so the downgrade is HTML-specific and
deliberate - a public bucket accepts arbitrary uploads, and serving HTML as HTML
would make it a stored-XSS surface on the project's own origin. There is no flag
to change it.

### DNS drift warning

Wrangler creates the proxied `AAAA` record for the custom domain itself. If the
zone's DNS is managed by IaC, that record will not be in its state and a plan
will show it as an extra record until it is imported or declared.

Database setup, in order, against a project that already has the corpus loaded:

```bash
psql "$PGURL" -f db/01-schema.sql
psql "$PGURL" -f db/02-extract.sql            # patterns + normalization + edges
psql "$PGURL" -f db/03-extract-setbased.sql   # the fast extractor
psql "$PGURL" -f db/06-entities-people-orgs.sql  # person/org patterns + extractor
psql "$PGURL" -f db/04-api.sql                # the endpoints + grants
psql "$PGURL" -f db/07-search.sql             # text search + cross-document
```

`demo` must be added to the project's exposed PostgREST schemas, or every call
returns `PGRST106 Invalid schema: demo`:

```
PATCH /v1/projects/{ref}/postgrest
{"db_schema": "public, graphql_public, demo"}
```

## Gotchas worth keeping

These each cost a debugging round and are recorded in comments at the site of the
fix:

- **Postgres word boundary is `\y`, not `\b`.** `\b` is read as backspace and
  matches nothing, silently. `\y[A-Z]{2}-[0-9]{1,2}\y` finds 5,913 control
  references where the `\b` spelling of the same pattern found 0 - and 0 looked
  like a fact about the document.
- **`row_number() over ()` beside a set-returning function in the SELECT list
  assigns 1 to every row.** Window functions run before SRF expansion. Use
  `WITH ORDINALITY` in `FROM`.
- **`regexp_instr` rejects the `g` flag**; the occurrence argument does that job.
  Walking the occurrence index with a fixed start is quadratic - advance the
  start offset instead.
- **`DISTINCT` on a projected row is not `DISTINCT ON` the unique key.** Several
  surface forms deliberately share one normalized key, so a plain `DISTINCT`
  makes one `INSERT` propose two rows for one key: "ON CONFLICT DO UPDATE command
  cannot affect row a second time". This is entity resolution arriving as a
  constraint violation.
- **PostgREST exposes only `public` and `graphql_public` by default.** A custom
  schema needs both the project config change and a per-request
  `Content-Profile` header.

## Theme

McMaster-Carr appliance manual, carried over from the bonkled palette: IBM Plex
Mono, cream paper and black ink (warm dark paper and warm off-white ink in dark
mode), hairline borders, no rounded corners, no shadows, no gradients. Tables
over cards, numbers over adjectives, and diagnostic voice for failure states.
