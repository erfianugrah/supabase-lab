# editorial graph layer: AU patterns, ABN keys, and the time axis

> **STATUS 2026-08-14: IN PROGRESS.** Implements Tracks E1/E3 (extraction
> side), F2 and F3 of `2026-08-14-pdf-corpus-graph-demo-readiness.md` against
> the live rebuilt project. Companion loop plan:
> `2026-08-14-editorial-layer-loop.md`.

**Goal:** the demo's headline graph becomes people and organisations across
the AU council corpus, with dates on every mention and edge (as-at queries),
and registry identifiers (ABN) extracted with deterministic checksum
validation.

## Current state (measured, this session)

- Project rebuilt 2026-08-14 in **ap-southeast-2** (medium), 7 US federal
  docs, 4366 entities, 20421 edges, pggraph.erfi.dev live.
- AU corpus loaded: 103 Inverell Shire Council (NSW) public documents
  (`demo/seed/au-corpus.json`): 47 council minutes, 51 committee minutes,
  2 GIPA contracts registers, 3 tender notices; doc_date 2015-08-06 ..
  2026-08-01, bulk 2022-2024. `corpus.documents.doc_date` (nullable date)
  exists; US docs stay null.
- Two tender notices are image-only scans; the loader OCRs them
  (pdftoppm + tesseract) under the G09 threshold (270 chars/page). G14's OCR
  path is therefore already exercised; its output is noisier (record that).
- ABN evidence in corpus (measured by probing the loaded text):
  `ABN 45 153 592 173` (White Rock Wind Farm Pty Ltd) appears 5x in
  inv-wrwf-ccc-2015-08-06; two more ABNs in inv-tenders-panel-...-2026 as
  bare digit groups in a table column. **Zero "ACN" tokens in the corpus** -
  build `abn` only, no `acn` kind. Both known ABNs pass the mod-89 checksum
  (hand-verified this session).
- The canonical closed loop: inv-wrwf-ccc-2015-08-06 pins
  `WHITE ROCK WIND FARM PTY LTD / ABN 45 153 592 173`; the 2022-02-23
  ordinary minutes record a councillor appointment to the White Rock Wind
  Farm Community Fund. Name variants across docs: "White Rock Wind Farm",
  "White Rock Farm Community Fund".
- The organic fuzzy-resolution case: `Hines Construction Pty Ltd` vs
  `Hines Constructions Pty Ltd` (3 docs).
- Extraction has NOT yet been run for inv-* docs. demo.mentions/edges contain
  US-doc rows only. `demo.extract_*` are NOT idempotent (mentions have no
  unique constraint): run once per slug, and only for `slug like 'inv-%'`.

## Task 1: `demo/db/08-editorial.sql` (one new file)

Follow the file conventions of 06/07 exactly: `set search_path` pin at the
top, dense WHY comments, grants in-file, security definer + pinned
search_path for anything executable by anon.

1. **Extend the kind constraint** with `'abn'` (same do-block idiom as
   06-entities-people-orgs.sql step 1).
2. **Extend `demo.person_org_patterns()`** (create or replace; KEEP all
   existing US patterns - the 7 US docs remain in the corpus) with AU forms:
   - `\yCr\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\y` (Cr Harmon, Cr Fiona Brown)
   - `\yCouncillor\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\y`
   - `\y(?:Lord Mayor|Deputy Mayor|Mayor)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\y`
   - org: `\y[A-Z][A-Za-z0-9&']+(?:\s+[A-Za-z0-9&'.]+){0,5}\s+Pty\.?\s+Ltd\.?`
     (NO trailing \y after the optional final dot - the dead-boundary trap is
     documented in 06). All groups non-capturing (the `[1]`-capture trap is
     documented in 06 too).
3. **ABN extraction with checksum validation.**
   - `demo.valid_abn(d text) returns boolean`, immutable: strip non-digits;
     require 11 digits; subtract 1 from the first digit; weights
     10,1,3,5,7,9,11,13,15,17,19; sum mod 89 = 0. (Algorithm verified this
     session against the two corpus ABNs.)
   - Patterns (kind `abn`, canon `abn` -> digits only, add to
     `normalize_citation`'s case): `\y[0-9]{2}\s[0-9]{3}\s[0-9]{3}\s[0-9]{3}\y`
     and `\y[0-9]{11}\y`.
   - `demo.extract_abn(p_slug text)`: same set-based machinery as
     extract_document_fast (WITH ORDINALITY, window sums - copy 03's shape,
     temp table `_hits_abn`), but candidate rows are filtered through
     `demo.valid_abn(...)` BEFORE insert. The checksum is the entity
     resolution: shape proposes, arithmetic disposes. Record
     candidates-vs-valid counts in the return table (add a
     `candidates_rejected int` column).
4. **The time axis.**
   - `alter table demo.mentions add column if not exists doc_date date;`
     same for `demo.edges`. Backfill both from corpus.documents on doc_slug.
   - A BEFORE INSERT trigger `demo.fill_doc_date()` on BOTH tables: when
     NEW.doc_date is null, set it from corpus.documents by doc_slug. One
     shared guard instead of editing every extractor and build_edges - the
     insert paths stay untouched.
5. **New RPCs** (all stable, security definer, pinned search_path, granted
   to anon+authenticated in-file):
   - `demo.entity_timeline(p_entity bigint, p_lim int default 100)`:
     date-ordered (doc_date, doc_slug, genre, char_offset, snippet) for one
     entity, nulls last. The "when" answer.
   - `demo.neighbourhood_as_at(p_root bigint, p_as_of date, p_max_depth int
     default 2, p_lim int default 200)`: neighbourhood() with edge filter
     `g.doc_date <= p_as_of`. Null-dated edges (US docs) are EXCLUDED from
     as-at queries by construction - state that in a comment.
   - `demo.bridges_as_at(p_as_of date, p_lim int default 50)`:
     cross_document_entities restricted to mentions in docs with
     doc_date <= p_as_of (recompute docs_count within the window - do not
     trust the denormalized counter here).
   - `demo.entity_registry_ids(p_entity bigint)`: the entity's co-proximity
     neighbours of kind 'abn' (join demo.edges on either endpoint, filter
     kind), with the shared doc_slugs. Surfaces the "this organisation
     printed this ABN here" pin using the EXISTING edge machinery.
6. **seed.sh**: apply 08-editorial.sql after 07-search.sql; load the AU
   corpus before phase 4 (`bun scripts/load-au-corpus.ts`); phase 4 gains
   `select demo.extract_abn(slug) from corpus.documents;` after the
   person/org line. Update the phase count echoes.

## Task 2: apply + run against the live project

`PGURL=$(make --no-print-directory pgurl)` in the experiment dir. Apply
08-editorial.sql with `psql -v ON_ERROR_STOP=1 -f`. Then:

```
select demo.extract_people_orgs(slug) from corpus.documents where slug like 'inv-%';
select demo.extract_abn(slug) from corpus.documents;
select demo.build_edges(400);
select demo.refresh_counters();
```

Do NOT run extract_people_orgs over the 7 US docs (mentions are not
idempotent - a second run duplicates them).

## Task 3: record measurements

Append to experiments/pdf-corpus-graph/RUNLOG.md a dated section:
entity/mention counts by kind for the AU docs (query, don't estimate),
candidates_rejected totals from extract_abn, the extraction wall clock for
the 103 docs, and the one-line answer to "does the WRWF closed loop resolve"
(entity_registry_ids of the WRWF org entity returns ABN 45 153 592 173).

## Explicitly out of scope

The demo UI (a separate slice), G11/G12 (scale run + cost), any change to
the seven existing read RPCs' signatures, RLS/grants on tables (never),
the pvlab probes, `lib/`, `tests/`.
