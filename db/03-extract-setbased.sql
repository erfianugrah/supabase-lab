-- Set-based extraction. Replaces the plpgsql per-match loop.
--
-- WHY. The loop version called regexp_instr once per match against a 1.5 MB
-- text and issued one INSERT per mention: 3m31s for a single document, and that
-- was AFTER fixing a quadratic Nth-occurrence walk (4m12s before). The residual
-- cost was 5935 separate statement executions over a large TOASTed value, not
-- the regex. One statement per (document, pattern) removes both.
--
-- HOW OFFSETS SURVIVE. regexp_matches(..., 'g') yields matches in order but not
-- their positions, and provenance needs positions. regexp_split_to_table yields
-- the text BETWEEN matches. Together they reconstruct exact offsets: split into
-- N+1 parts around N matches, then
--
--   offset(match n) = sum(len(part_i), i <= n) + sum(len(match_j), j < n) + 1
--
-- which is two window sums.
--
-- TWO TRAPS, BOTH MEASURED HERE.
--
-- 1. `row_number() over ()` alongside a set-returning function in the SELECT
--    list assigns 1 to EVERY row. Window functions are evaluated before SRF
--    expansion, so all 5913 matches shared n = 1
--    (count(*) = 5913, count(distinct n) = 1). A GROUP BY on that silently
--    collapsed the result to 323 distinct values and the mention count came out
--    equal to the entity count - which looks like a plausible number, not a bug.
--    The SRF therefore goes in FROM with WITH ORDINALITY, which numbers rows
--    deterministically.
--
-- 2. Accumulating preceding match lengths with a self-join (`left join matches
--    m2 on m2.n < m.n`) is O(N^2) - 35M intermediate rows at this size. A window
--    frame does it in one pass.

create or replace function demo.extract_document_fast(p_slug text)
returns table (citation_kind text, entities_new int, mentions_new int)
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

  for v_pat in select * from demo.citation_patterns() loop

    create temporary table _hits as
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

    -- DISTINCT ON (norm), not DISTINCT on the whole row.
    --
    -- The unique key is (kind, norm) but the projected row also carries `label`,
    -- and several surface forms deliberately share one norm - "5 U.S.C. 552",
    -- "5 USC 552" and "5 U. S. C. 552" are the same statute. A plain DISTINCT
    -- keeps them as separate rows, so a single INSERT proposes two rows for one
    -- constrained key and Postgres refuses: "ON CONFLICT DO UPDATE command
    -- cannot affect row a second time".
    --
    -- This is the entity-resolution problem arriving as a constraint violation:
    -- collapsing variants requires CHOOSING a canonical label, so the longest
    -- surface form wins (the fully punctuated one, which reads best in the UI).
    with ins as (
      insert into demo.entities (kind, label, norm)
      select distinct on (h.norm) v_pat.kind, trim(h.raw), h.norm
        from _hits h
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
      from _hits h
      join demo.entities e
        on e.kind = v_pat.kind and e.norm = h.norm;

    v_ments := (select count(*) from _hits);
    drop table _hits;

    return query select v_pat.kind::text, coalesce(v_ents, 0), coalesce(v_ments, 0);
  end loop;
end
$$;
