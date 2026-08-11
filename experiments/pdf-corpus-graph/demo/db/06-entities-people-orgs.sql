-- Pinned because these files run over the transaction pooler, where there is no
-- ambient search_path - a fresh database fails with "no schema has been selected
-- to create in" otherwise.
set search_path = demo, corpus, public, extensions;

-- ============================================================================
-- 06-entities-people-orgs.sql
-- Person and organization extraction, added alongside the citation extractor.
--
-- The citation extractor (02-extract.sql, 03-extract-setbased.sql) is the
-- zero-hallucination baseline and is NOT altered here. This adds entity kinds
-- 'person' and 'org' alongside the existing 'nist_control'/'usc'/'cfr'/'publaw'.
--
-- WHY DETERMINISTIC. This corpus (US federal legal/regulatory documents)
-- contains honorific-prefixed names and organization suffixes that are
-- grammatically fixed and regex-extractable. The precision profile is worse
-- than citation extraction - deterministic name extraction produces false
-- positives - and that is recorded honestly in the README rather than tuned
-- to look good. Zero-hallucination citations and noisy names, stated plainly.
-- ============================================================================

-- Step 1: Extend the kind check constraint (idempotent).
do $$
declare
  v_name text;
begin
  select conname into v_name
    from pg_constraint
   where conrelid = 'demo.entities'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) like '%kind%'
   limit 1;
  if v_name is not null then
    execute format('alter table demo.entities drop constraint %I', v_name);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'demo.entities'::regclass and conname = 'entities_kind_check'
  ) then
    alter table demo.entities add constraint entities_kind_check
      check (kind in ('nist_control','usc','cfr','publaw','person','org'));
  end if;
end $$;

-- Step 2: Person and organization extraction patterns.
--
-- \y is the Postgres word boundary. \b is backspace and silently matches
-- nothing - it cost a round in the citation extractor (0 matches where the
-- correct pattern returned 5913), and the same trap applies here.
--
-- Each pattern produces a (kind, pattern, canon) row, same contract as
-- demo.citation_patterns(), so the same normalize_citation and extraction
-- machinery works unchanged.
--
-- BROADER THAN THE CITATION EXTRACTOR on purpose. Citations are grammatically
-- fixed and regex-exact; honorifics and org suffixes produce false positives
-- (headings, common nouns, generic references). The precision penalty is
-- recorded in the README rather than tuned away.
create or replace function demo.person_org_patterns()
returns table (kind text, pattern text, canon text) language sql immutable as $$
  values
    -- Honorific-prefixed names: "Mr. John Smith", "Senator Warren",
    -- "Justice Sotomayor", "Secretary Raimondo", "Chairman Gensler".
    -- Two-name form first (most reliable), then one-name as a broader catch.
    --
    -- ALL groups are non-capturing ((?:...)). The extraction machinery
    -- (`extract_people_orgs`) reads (t.m)[1] from regexp_matches; when a
    -- pattern has capturing groups, [1] is the FIRST CAPTURED GROUP, not the
    -- full match. A pattern like (Mr|Ms|...) would make every "person" entity
    -- label just "MR". This is the same contract demo.citation_patterns() keeps
    -- by using NO groups at all. Non-capturing groups everywhere means nothing
    -- is captured, so regexp_matches returns the whole match as [1].
    ('person',
     '\y(?:Mr|Ms|Mrs|Senator|Representative|Justice|Secretary|Commissioner|Chairman|Chairwoman|Director|Administrator)\.?\s+[A-Z][a-z]+\s+[A-Z][a-z]+\y',
     'upper'),
    ('person',
     '\y(?:Mr|Ms|Mrs|Senator|Representative|Justice|Secretary|Commissioner|Chairman|Chairwoman|Director|Administrator)\.?\s+[A-Z][a-z]+\y',
     'upper'),

    -- Organization suffixes: "Acme Inc.", "Globex LLC", "Nike Corporation".
    -- Inc\. separated from LLC|Corporation because a trailing \y after a literal
    -- dot (Inc\.) is dead: after '. ' there is no word boundary (non-word to
    -- non-word), the same failure mode \b causes elsewhere in this file.
    -- LLC and Corporation end in word characters so \y is valid.
    ('org',
     '\y[A-Z][a-zA-Z]+(?:\s+[A-Za-z][a-z]+){0,4}\s+Inc\.',
     'upper'),
    ('org',
     '\y[A-Z][a-zA-Z]+(?:\s+[A-Za-z][a-z]+){0,4}\s+(?:LLC|Corporation)\y',
     'upper'),

    -- "Department of X": "Department of Defense", "Department of Homeland Security".
    ('org',
     '\yDepartment\s+of\s+[A-Z][a-z]+(?:\s+[A-Za-z][a-z]+){0,3}\y',
     'upper'),

    -- Commission and Authority: "Securities and Exchange Commission",
    -- "Tennessee Valley Authority". Middle words may be lowercase (and, of, the).
    ('org',
     '\y[A-Z][a-z]+(?:\s+[A-Za-z][a-z]+){1,5}\s+(?:Commission|Authority|Agency|Board|Bureau|Administration)\y',
     'upper')
$$;

-- Step 3: Person/org extraction, same shape as demo.extract_document_fast.
--
-- Uses the same set-based approach: regexp_matches + regexp_split_to_table
-- to recover exact character offsets for every match, then INSERTs into
-- demo.entities and demo.mentions. The same normalize_citation function
-- handles dedup (upper-case and trim for person/org kinds).
--
-- The temp table is named _hits_po to avoid colliding with extract_document_fast's
-- _hits when both run in the same transaction.
create or replace function demo.extract_people_orgs(p_slug text)
returns table (extracted_kind text, entities_new int, mentions_new int)
language plpgsql as $$
declare
  v_text  text;
  v_pat   record;
  v_ents  int;
  v_ments int;
begin
  select extracted_text into v_text from corpus.documents where slug = p_slug;
  if v_text is null then
    raise exception 'no document % (or it has no extracted_text)', p_slug;
  end if;

  for v_pat in select * from demo.person_org_patterns() loop

    create temporary table _hits_po as
    with matches as (
      select t.n, (t.m)[1] as raw
        from regexp_matches(v_text, v_pat.pattern, 'g') with ordinality as t(m, n)
    ),
    parts as (
      select p.n, length(p.part) as plen
        from regexp_split_to_table(v_text, v_pat.pattern) with ordinality as p(part, n)
    ),
    part_cum as (
      select n, sum(plen) over (order by n) as cum_parts from parts
    ),
    match_cum as (
      select n, raw,
             coalesce(
               sum(length(raw)) over (order by n rows between unbounded preceding and 1 preceding),
               0
             ) as pre_matches
        from matches
    )
    select mc.raw,
           (pc.cum_parts + mc.pre_matches + 1)::int as char_offset,
           demo.normalize_citation(v_pat.kind, mc.raw) as norm
      from match_cum mc
      join part_cum pc on pc.n = mc.n;

    -- DISTINCT ON (norm): several surface forms may share one normalized key
    -- (e.g. "Mr. John Smith" and "Mr John Smith"). The longest surface form
    -- wins as the label.
    with ins as (
      insert into demo.entities (kind, label, norm)
      select distinct on (h.norm) v_pat.kind, trim(h.raw), h.norm
        from _hits_po h
       order by h.norm, length(trim(h.raw)) desc, trim(h.raw)
      on conflict (kind, norm) do update set label = demo.entities.label
      returning (xmax = 0) as is_new
    )
    select count(*) filter (where is_new)::int into v_ents from ins;

    insert into demo.mentions (entity_id, doc_slug, char_offset, snippet)
    select e.id,
           p_slug,
           h.char_offset,
           regexp_replace(substr(v_text, greatest(1, h.char_offset - 50), 150), '\s+', ' ', 'g')
      from _hits_po h
      join demo.entities e
        on e.kind = v_pat.kind and e.norm = h.norm;

    v_ments := (select count(*) from _hits_po);
    drop table _hits_po;

    return query select v_pat.kind::text, coalesce(v_ents, 0), coalesce(v_ments, 0);
  end loop;
end
$$;

-- Step 4: Convenience wrapper - calls both citation extraction (unchanged) and
-- person/org extraction for one document. Returns combined results.
create or replace function demo.extract_all(p_slug text)
returns table (extracted_kind text, entities_new int, mentions_new int)
language plpgsql as $$
begin
  return query select * from demo.extract_document_fast(p_slug);
  return query select * from demo.extract_people_orgs(p_slug);
end
$$;

-- Step 5: NO grants to anon/authenticated.
--
-- These functions WRITE to demo.entities and demo.mentions. They follow the
-- same contract as extract_document_fast, build_edges and refresh_counters:
-- called by the provisioning script (seed.sh) as the postgres role, never
-- exposed through PostgREST. The seven read-only functions in 04-api.sql are
-- the entire API surface; granting execute on mutation functions to anon
-- would invert the demo's stated security model.