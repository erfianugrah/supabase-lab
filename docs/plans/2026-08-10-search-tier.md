# search tier: document search + cross-document discovery

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.
> Built by hand (Anthropic API is usage-limited until 2026-09-01, so no loop).
> `experiments/pdf-corpus-graph/GUIDE.md` is binding: a probe asserts that it
> ran, never what it found.

**Goal:** Close the two cheap search gaps so the demo stops requiring the user
to already know what to search for: keyword search over document text, and a
cross-document discovery surface.

**Architecture:** Two new read-only Postgres functions exposed by PostgREST,
following the established contract (SECURITY DEFINER, pinned search_path, zod
parsing at the client boundary). One new UI panel. No new services.

**Tech stack:** Postgres 17.6 (`websearch_to_tsquery`, tsvector, GIN),
PostgREST, the existing Astro/React demo.

---

## Verified before planning (not assumptions)

- **Cross-document entities exist**: `docs_count` distribution is 1501 @ 1 doc,
  **18 @ 2 docs, 2 @ 3 docs**. The discovery panel will have real content.
- `websearch_to_tsquery('english', ...)` is available and parses raw user input
  safely (verified 2026-08-10 on the live project).
- The seven-function RPC contract is proven end to end: definer functions with
  pinned search_path, RLS deny-by-default on tables, anon cannot read any table
  (42501).

---

## File structure

| File | Responsibility |
|---|---|
| `demo/db/07-search.sql` | New. Both RPCs, the tsvector column and index, grants. |
| `demo/src/lib/api.ts` | Modify. Client functions + zod schemas for the two RPCs. |
| `demo/src/components/Explorer.tsx` | Modify. Cross-document panel + document search box/results. |
| `demo/README.md` | Modify. Document the two new endpoints in the API table. |
| `scripts/seed.sh` | Modify. Add 07-search.sql to the rebuild (one-command rebuild must cover it). |
| `RUNLOG.md` | Modify. Record query costs measured after build. |

---

## Task 1: `search_documents` - keyword search over document text

**Why a generated column + GIN rather than on-the-fly `to_tsvector`:** seven
documents would survive a seq scan, but the demo exists to show the pattern that
scales. On-the-fly tsvector against a real corpus is the classic
"works in the demo, seq-scans in production" mistake.

**Files:** Create `demo/db/07-search.sql`

- [ ] **Step 1: failing check.** Assert `demo.search_documents` does not exist:
      `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='demo' and proname='search_documents'` -> expect 0.

- [ ] **Step 2: write the SQL.**

```sql
-- Generated, not on-the-fly: the index is the pattern that scales.
alter table corpus.documents
  add column if not exists search_tsv tsvector
  generated always as (to_tsvector('english', coalesce(extracted_text,''))) stored;
create index if not exists documents_search_gin
  on corpus.documents using gin (search_tsv);

-- websearch_to_tsquery, not plainto_tsquery: it tolerates raw user input
-- (quotes, stray operators) instead of erroring.
create or replace function demo.search_documents(q text, lim int default 10)
returns table (slug text, genre text, source_bytes bigint,
               rank real, headline text)
language sql stable security definer
set search_path = demo, corpus, public, extensions as $$
  select d.slug, d.genre, d.source_bytes,
         ts_rank(d.search_tsv, websearch_to_tsquery('english', q))::real,
         ts_headline('english', left(d.extracted_text, 100000),
                     websearch_to_tsquery('english', q),
                     'MaxWords=40, MinWords=20')
    from corpus.documents d
   where d.search_tsv @@ websearch_to_tsquery('english', q)
   order by 4 desc
   limit least(lim, 50)
$$;
grant execute on function demo.search_documents(text, int) to anon, authenticated;
```

Note: `ts_headline` against a 31 MB column is why the `left(..., 100000)` bound
is there - headline generation over the full text of a 14 MB document is the
slow part, and the bound keeps the RPC responsive. That truncation is a
simplification with a known ceiling; record it in a comment.

- [ ] **Step 3: apply and verify by hand.**
      `demo.search_documents('access control', 5)` returns rows with non-empty
      headlines; `demo.search_documents('xyzzy nothing matches this', 5)` returns
      zero rows (not an error).
- [ ] **Step 4: measure.** EXPLAIN ANALYZE the query; confirm the GIN index is
      used (`Bitmap Index Scan on documents_search_gin`), record median exec ms.
- [ ] **Step 5: verify RLS still holds.** `anon` direct read of
      `corpus.documents` must still 42501; the generated column must not change
      that.

## Task 2: `cross_document_entities` - the discovery surface

- [ ] **Step 1: failing check.** Same shape as Task 1 Step 1; expect 0.

- [ ] **Step 2: write the SQL** (same file, `07-search.sql`):

```sql
-- The "who or what connects more than one document" query. This is the surface
-- a first-time user needs: the corpus answered it with 20 entities (18 in two
-- documents, 2 in three) on 2026-08-10. docs_count is the denormalized counter
-- refresh_counters() maintains, so this is one index-backed scan, not a join.
create or replace function demo.cross_document_entities(lim int default 50)
returns table (id bigint, kind text, label text,
               mentions_count int, docs_count int, docs text[])
language sql stable security definer
set search_path = demo, corpus, public, extensions as $$
  select e.id, e.kind, e.label, e.mentions_count, e.docs_count,
         array_agg(distinct m.doc_slug order by m.doc_slug)
    from demo.entities e
    join demo.mentions m on m.entity_id = e.id
   where e.docs_count >= 2
   group by e.id, e.kind, e.label, e.mentions_count, e.docs_count
   order by e.docs_count desc, e.mentions_count desc
   limit least(lim, 200)
$$;
grant execute on function demo.cross_document_entities(int) to anon, authenticated;
```

- [ ] **Step 3: verify by hand.** Expect exactly 20 rows on this corpus, each
      with a `docs` array of length >= 2. If the count is wildly different,
      stop - either the data changed or the query is wrong; do not tune until
      the number looks nice.
- [ ] **Step 4: spot-check one row** against its provenance:
      `demo.provenance(<id>, 10)` must return snippets from >= 2 distinct
      documents. This proves the panel's claim is true rather than trusting the
      counter.

## Task 3: UI - discovery panel + document search

**Files:** Modify `demo/src/lib/api.ts`, `demo/src/components/Explorer.tsx`

- [ ] **Step 1: client schemas.** zod schemas matching the RPC returns; add
      `api.searchDocuments(q, lim)` and `api.crossDocumentEntities(lim)`. Parse,
      never cast - same rule as the existing client.
- [ ] **Step 2: cross-document panel.** New `<Section>` placed ABOVE entity
      search, since it is the first thing a new user should see. Dense table:
      kind badge, label, docs count, mentions, the document slugs. Each row has
      OPEN (selects the entity, same as search results). Include the Hint
      tooltips, same house pattern.
- [ ] **Step 3: document search.** A second input (placeholder: "search document
      text") that calls `searchDocuments` and renders slug / genre / rank /
      headline. The headline contains `<b>` markers from ts_headline - render
      them with a sanitizer boundary or escape-then-replace on the `<b>` tags
      only; do NOT `dangerouslySetInnerHTML` raw.
- [ ] **Step 4: typecheck + build.** `bun run check && bun run build` must be
      clean.
- [ ] **Step 5: visual verification.** Headless screenshot at 1500px and 760px;
      read the screenshots. Confirm the cross-document panel shows 20 rows and
      the tiered search still ranks exact-first. Do not trust a green build.

## Task 4: make the rebuild cover it, then measure and document

- [ ] **Step 1:** Add `demo/db/07-search.sql` to `scripts/seed.sh` after
      `04-api.sql`, with the same fail-fast discipline.
- [ ] **Step 2:** Re-run `scripts/seed.sh` on the live project to confirm
      idempotence (it must be a no-op-safe re-run: `create or replace`,
      `if not exists`).
- [ ] **Step 3:** Deploy the UI (`wrangler deploy`), confirm the live page shows
      the new panel.
- [ ] **Step 4:** Update `demo/README.md` API table with the two new endpoints.
- [ ] **Step 5:** Update `RUNLOG.md` with the measured `search_documents` cost.
- [ ] **Step 6:** Commit.

## Out of scope (recorded so nobody assumes it is done)

- **Semantic / hybrid search.** Needs a real embedding provider and a backfill
  pass over chunks. Synthetic vectors measure index mechanics only and cannot
  support a recall claim - this stays parked.
- **Person/org entities (Track B).** The cross-document panel gets far more
  valuable once entities are people and organisations rather than citations;
  that track is still queued behind the API reset.
- **Relevance tuning.** `ts_rank` defaults are used as-is. If ranking looks
  wrong on real queries, that is a finding to record, not a knob to turn until
  it looks good.

## Teardown note

None of this changes the teardown answer: `make destroy` then `make up`
reproduces it, provided Task 4 Step 1 landed. Verify `07-search.sql` is in
seed.sh BEFORE destroying.
