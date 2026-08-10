-- Pinned because these files run over the transaction pooler, where there is no
-- ambient search_path - a fresh database fails with "no schema has been selected
-- to create in" otherwise.
set search_path = demo, corpus, public, extensions;

-- Extraction: source text -> entities + mentions + co-citation edges.
--
-- Runs entirely server-side. No API key, no external service, no network. That
-- is a property of THIS corpus (explicit citations), not a general claim about
-- document-to-graph pipelines.

-- The citation grammars. Each is anchored with \y, which is Postgres's word
-- boundary.
--
-- \b DOES NOT WORK HERE and fails silently: Postgres reads it as backspace, so
-- a pattern using it returns zero matches rather than an error. That cost a
-- round here - `\y[A-Z]{2}-[0-9]{1,2}\y` finds 5913 control references in the
-- NIST catalogue where the \b spelling of the same pattern found 0, and the
-- 0 looked like a fact about the document.
create or replace function demo.citation_patterns()
returns table (kind text, pattern text, canon text) language sql immutable as $$
  values
    -- NIST control ids: two letters, hyphen, 1-2 digits (AC-1, AU-12).
    ('nist_control', '\y[A-Z]{2}-[0-9]{1,2}\y',                 'upper'),
    -- Statute: "5 U.S.C. 552", tolerating spaced and unspaced abbreviations.
    ('usc',          '\y[0-9]{1,2} U\.?\s?S\.?\s?C\.? [0-9]+',  'usc'),
    -- Regulation: "17 CFR 240".
    ('cfr',          '\y[0-9]{1,2} CFR [0-9]+',                 'squash'),
    -- "Public Law 117-58".
    ('publaw',       'Public Law [0-9]{2,3}.[0-9]{1,4}',        'squash')
$$;

-- Normalization: the cheap, deterministic half of entity resolution. Collapses
-- whitespace and punctuation variance so "5 U.S.C. 552", "5 USC 552" and
-- "5 U. S. C. 552" become one node instead of three. It does NOT attempt
-- semantic merging - that needs embeddings, and this corpus does not need it.
create or replace function demo.normalize_citation(kind text, raw text)
returns text language sql immutable as $$
  select case kind
    when 'usc' then regexp_replace(upper(raw), '[^0-9A-Z]', '', 'g')
    when 'cfr' then regexp_replace(upper(raw), '[^0-9A-Z]', '', 'g')
    when 'publaw' then regexp_replace(upper(raw), '[^0-9]', '', 'g')
    else upper(trim(raw))
  end
$$;

-- Extract one document.
--
-- Offsets come from regexp_instr (Postgres 15+), stepping the Nth-match index
-- until it returns 0. regexp_matches would give the values but not the
-- positions, and a graph whose edges cannot point at a byte range is not
-- auditable.
-- The output column is citation_kind, not kind. A RETURNS TABLE column becomes
-- an implicit plpgsql variable, so naming it `kind` makes every reference to the
-- entities.kind COLUMN ambiguous - Postgres refuses with "It could refer to
-- either a PL/pgSQL variable or a table column".
create or replace function demo.extract_document(p_slug text)
returns table (citation_kind text, entities_found int, mentions_found int)
language plpgsql as $$
declare
  v_text  text;
  v_pat   record;
  v_from  integer;
  v_pos   integer;
  v_raw   text;
  v_norm  text;
  v_id    bigint;
  v_is_new boolean;
  v_ents  int;
  v_ments int;
begin
  select extracted_text into v_text from corpus.documents where slug = p_slug;
  if v_text is null then
    raise exception 'no document % (or it has no extracted_text)', p_slug;
  end if;

  for v_pat in select * from demo.citation_patterns() loop
    v_ents := 0; v_ments := 0; v_from := 1;
    loop
      -- ADVANCE THE START OFFSET; do not walk the Nth-occurrence argument.
      --
      -- No 'g' flag: regexp_instr rejects it ('does not support the "global"
      -- option') because the occurrence argument already does that job. The
      -- obvious loop is therefore N = 1, 2, 3... with start fixed at 1 - and it
      -- is quadratic, because every call rescans from the top to find the Nth
      -- hit. On the 1.5 MB NIST catalogue with 5935 matches that is billions of
      -- characters scanned, and it measured 4m12s for ONE document.
      --
      -- Asking for occurrence 1 from a moving start is linear: each call scans
      -- only the remaining tail.
      v_pos := regexp_instr(v_text, v_pat.pattern, v_from, 1, 0);
      exit when v_pos is null or v_pos = 0;

      v_raw  := substr(v_text, v_pos, 40);
      v_raw  := (regexp_match(v_raw, v_pat.pattern))[1];
      if v_raw is null then v_from := v_pos + 1; continue; end if;

      v_norm := demo.normalize_citation(v_pat.kind, v_raw);

      -- xmax = 0 distinguishes a genuine INSERT from an ON CONFLICT UPDATE.
      -- Testing plpgsql's FOUND does not work here: ON CONFLICT DO UPDATE always
      -- reports found and always RETURNINGs a row, so the first version counted
      -- every mention as a new entity and reported 5913 distinct controls for a
      -- catalogue that has a few hundred.
      insert into demo.entities (kind, label, norm)
      values (v_pat.kind, trim(v_raw), v_norm)
      on conflict (kind, norm) do update set label = demo.entities.label
      returning id, (xmax = 0) into v_id, v_is_new;

      if v_is_new then v_ents := v_ents + 1; end if;

      -- A 120-char window centred on the hit, so the UI can show a human why
      -- this node exists without re-reading the PDF.
      insert into demo.mentions (entity_id, doc_slug, char_offset, snippet)
      values (
        v_id, p_slug, v_pos,
        regexp_replace(substr(v_text, greatest(1, v_pos - 50), 150), '\s+', ' ', 'g')
      );
      v_ments := v_ments + 1;
      v_from  := v_pos + 1;
    end loop;

    return query select v_pat.kind::text, v_ents, v_ments;
  end loop;
end
$$;

-- Edges: two citations mentioned within `p_window` characters of each other in
-- the same document are treated as related.
--
-- This edge definition is a CHOICE and a weak one - co-occurrence is not a typed
-- relationship, and an LLM pipeline would produce {subject, predicate, object}
-- instead. It is stated plainly rather than dressed up: the demo shows the graph
-- LAYER (traversal, paths, components, provenance) on real data, and proximity
-- is enough to produce a real, non-random topology to traverse.
create or replace function demo.build_edges(p_window int default 400)
returns int language plpgsql as $$
declare v_count int;
begin
  insert into demo.edges (source, target, cost, reverse_cost, kind, doc_slug, weight)
  select least(a.entity_id, b.entity_id)    as source,
         greatest(a.entity_id, b.entity_id) as target,
         1, 1, 'co_citation', a.doc_slug, count(*)::int
    from demo.mentions a
    join demo.mentions b
      on a.doc_slug = b.doc_slug
     and a.entity_id < b.entity_id
     and abs(a.char_offset - b.char_offset) <= p_window
   group by 1, 2, a.doc_slug
  on conflict (source, target, doc_slug) do update set weight = excluded.weight;

  -- Frequent co-citation reads as a SHORTER path, so pgr_dijkstra's cheapest
  -- route is the most strongly evidenced one rather than an arbitrary hop count.
  update demo.edges set cost = 1.0 / greatest(weight, 1),
                        reverse_cost = 1.0 / greatest(weight, 1);

  select count(*) into v_count from demo.edges;
  return v_count;
end
$$;

-- Denormalized counters, so the UI's list view is one seq scan rather than a
-- correlated subquery per row.
create or replace function demo.refresh_counters() returns void language sql as $$
  update demo.entities e
     set mentions_count = c.m, docs_count = c.d
    from (select entity_id, count(*) m, count(distinct doc_slug) d
            from demo.mentions group by entity_id) c
   where c.entity_id = e.id;
$$;
