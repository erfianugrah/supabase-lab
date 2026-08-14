-- Pinned because these files run over the transaction pooler, where there is no
-- ambient search_path - a fresh database fails with "no schema has been selected
-- to create in" otherwise.
set search_path = demo, corpus, public, extensions;

-- Editorial graph layer: AU council patterns, ABN registry keys, the time axis.
--
-- Implements docs/plans/2026-08-14-editorial-graph-layer.md. The story this
-- layer makes demonstrable: an organisation appears in a 2015 committee paper
-- WITH its ABN printed, and in 2022 minutes by name, appointed to by a
-- councillor. The graph holds all three facts; this layer makes the identity
-- pin (checksum), the people (AU honorifics) and the time axis (as-at
-- queries) first-class.

-- Step 1: extend the kind constraint with 'abn'. Same idiom as 06.
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
      check (kind in ('nist_control','usc','cfr','publaw','person','org','abn'));
  end if;
end $$;

-- Step 2: person_org_patterns() gains the AU forms. The US patterns are kept
-- verbatim - the seven US federal documents remain in the corpus, and
-- altering their extraction behaviour is a silent regression, not an edit.
-- Every group is non-capturing (the (t.m)[1] trap is documented in 06).
create or replace function demo.person_org_patterns()
returns table (kind text, pattern text, canon text) language sql immutable as $$
  values
    -- US federal forms (verbatim from 06-entities-people-orgs.sql).
    ('person', '\y(?:Mr|Ms|Mrs|Senator|Representative|Justice|Secretary|Commissioner|Chairman|Chairwoman|Director|Administrator)\.?\s+[A-Z][a-z]+\s+[A-Z][a-z]+\y', 'upper'),
    ('person', '\y(?:Mr|Ms|Mrs|Senator|Representative|Justice|Secretary|Commissioner|Chairman|Chairwoman|Director|Administrator)\.?\s+[A-Z][a-z]+\y', 'upper'),
    ('org', '\y[A-Z][a-zA-Z]+(?:\s+[A-Za-z][a-z]+){0,4}\s+Inc\.', 'upper'),
    ('org', '\y[A-Z][a-zA-Z]+(?:\s+[A-Za-z][a-z]+){0,4}\s+(?:LLC|Corporation)\y', 'upper'),
    ('org', '\yDepartment\s+of\s+[A-Z][a-z]+(?:\s+[A-Za-z][a-z]+){0,3}\y', 'upper'),
    ('org', '\y[A-Z][a-z]+(?:\s+[A-Za-z][a-z]+){1,5}\s+(?:Commission|Authority|Agency|Board|Bureau|Administration)\y', 'upper'),
    -- AU council honorifics. "Cr Fiona Brown", "Cr Harmon", "Councillor X",
    -- "Mayor X" / "Deputy Mayor X". Lord Mayor first: alternation is ordered.
    ('person', '\yCr\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\y', 'upper'),
    ('person', '\yCouncillor\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\y', 'upper'),
    ('person', '\y(?:Lord Mayor|Deputy Mayor|Mayor)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\y', 'upper'),
    -- AU company suffix. [Pp][Tt][Yy] / [Ll][Tt][Dd] rather than Pty/Ltd:
    -- council RESOLUTIONS are set in all caps ("...AWARDED TO NSW SPRAY SEAL
    -- PTY LTD") and the name columns of tender tables likewise; 3 of 103 AU
    -- documents carry the all-caps suffix and would extract nothing. NO
    -- trailing \y after the optional final dot - a word boundary after a
    -- literal dot is dead (documented in 06).
    ('org', '\y[A-Z][A-Za-z0-9&'']+(?:\s+[A-Za-z0-9&''.]+){0,5}\s+[Pp][Tt][Yy]\.?\s+[Ll][Tt][Dd]\.?', 'upper')
$$;

-- Step 3: ABN extraction with checksum validation.
--
-- The Australian Business Number is eleven digits with a published check:
-- subtract 1 from the first digit, weight by 10,1,3,5,7,9,11,13,15,17,19,
-- and the sum must divide by 89. That makes the registry identifier the one
-- entity kind where RESOLUTION IS ARITHMETIC, not similarity: shape proposes
-- the candidate, the checksum disposes. Verified against the two ABNs the
-- corpus actually prints (45 153 592 173 sums to 445 = 5 x 89; 89 001 288 400
-- sums to 356 = 4 x 89).
create or replace function demo.valid_abn(d text)
returns boolean language sql immutable as $$
  with digits as (
    select regexp_replace(d, '[^0-9]', '', 'g') as v
  ),
  w as (select array[10,1,3,5,7,9,11,13,15,17,19] as weights)
  select case when length(v) = 11 then
           ( (substring(v from 1 for 1)::int - 1) * weights[1]
           + (select sum(substring(v from i + 1 for 1)::int * weights[i + 1])
                from generate_series(1, 10) as i) ) % 89 = 0
         else false end
    from digits, w
$$;

-- The CASE is load-bearing: for non-11-digit input the sum would cast empty
-- substrings to int. CASE evaluates only the branch it needs, so the casts
-- exist only when the length is right.
--
-- Extraction mirrors 03's set-based machinery (WITH ORDINALITY plus window
-- sums for offsets; the two traps are documented there), with one added
-- stage: candidates are filtered through valid_abn BEFORE insert, and the
-- rejection count comes back so the caller can see the checksum working.
-- Two shapes: the spaced "45 153 592 173" and the compact "45153592173".
--
-- The temp tables are dropped BEFORE creation, not only after: the
-- transaction pooler hands back dirty backends, and a crashed run's _hits_abn
-- would otherwise collide with the next session on the same backend.
create or replace function demo.extract_abn(p_slug text)
returns table (extracted_kind text, entities_new int, mentions_new int, candidates_rejected int)
language plpgsql as $$
declare
  v_text  text;
  v_pat   record;
  v_ents  int;
  v_ments int;
  v_rej   int;
begin
  select extracted_text into v_text from corpus.documents where slug = p_slug;
  if v_text is null then
    raise exception 'no document % (or it has no extracted_text)', p_slug;
  end if;

  for v_pat in select * from (
    values
      ('\y[0-9]{2}\s[0-9]{3}\s[0-9]{3}\s[0-9]{3}\y'),
      ('\y[0-9]{11}\y')
  ) as t(pattern) loop

    drop table if exists pg_temp._hits_abn;
    drop table if exists pg_temp._valid_abn;
    create temporary table _hits_abn as
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
           demo.normalize_citation('abn', mc.raw) as norm
      from match_cum mc
      join part_cum pc on pc.n = mc.n;

    create temporary table _valid_abn as
    select * from _hits_abn where demo.valid_abn(raw);

    with ins as (
      insert into demo.entities (kind, label, norm)
      select distinct on (h.norm) 'abn', trim(h.raw), h.norm
        from _valid_abn h
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
      from _valid_abn h
      join demo.entities e
        on e.kind = 'abn' and e.norm = h.norm;

    v_ments := (select count(*) from _valid_abn);
    v_rej   := (select count(*) from _hits_abn) - v_ments;

    drop table _hits_abn;
    drop table _valid_abn;

    return query select 'abn'::text, coalesce(v_ents, 0), coalesce(v_ments, 0), coalesce(v_rej, 0);
  end loop;
end
$$;

-- Step 4: the time axis. The editorial question is temporal ("dealt with,
-- five years ago"), and the corpus documents are dated - so every mention
-- and every edge carries its document's date. US federal seed documents have
-- no date and stay null; as-at queries exclude undated edges by construction,
-- which is the honest reading of "as at": only what was known by then.
alter table demo.mentions add column if not exists doc_date date;
alter table demo.edges add column if not exists doc_date date;

update demo.mentions m set doc_date = d.doc_date
  from corpus.documents d where m.doc_slug = d.slug and m.doc_date is null;
update demo.edges e set doc_date = d.doc_date
  from corpus.documents d where e.doc_slug = d.slug and e.doc_date is null;

-- One shared guard instead of editing every extractor and build_edges: any
-- insert that arrives without a date inherits its document's. The insert
-- paths stay untouched.
create or replace function demo.fill_doc_date()
returns trigger language plpgsql as $$
begin
  if NEW.doc_date is null then
    select doc_date into NEW.doc_date
      from corpus.documents
     where slug = NEW.doc_slug;
  end if;
  return NEW;
end
$$;

drop trigger if exists trg_fill_doc_date_mentions on demo.mentions;
create trigger trg_fill_doc_date_mentions
  before insert on demo.mentions
  for each row execute function demo.fill_doc_date();

drop trigger if exists trg_fill_doc_date_edges on demo.edges;
create trigger trg_fill_doc_date_edges
  before insert on demo.edges
  for each row execute function demo.fill_doc_date();

-- Step 5: the read RPCs. Same contract as 04/07: stable, security definer,
-- pinned search_path, execute to anon+authenticated, no table grants.
-- The pre-drops are not optional: an earlier revision returned different row
-- types, and CREATE OR REPLACE cannot change a return type.
drop function if exists demo.entity_timeline(bigint, int);
drop function if exists demo.neighbourhood_as_at(bigint, date, int, int);
drop function if exists demo.bridges_as_at(date, int);
drop function if exists demo.entity_registry_ids(bigint);

-- The "when" answer: one entity's mentions in chronological order.
create or replace function demo.entity_timeline(p_entity bigint, p_lim int default 100)
returns table (doc_date date, doc_slug text, genre text, char_offset int, snippet text)
language sql stable security definer
set search_path = demo, corpus, public, extensions as $$
  select d.doc_date, m.doc_slug, d.genre, m.char_offset, m.snippet
    from demo.mentions m
    join corpus.documents d on d.slug = m.doc_slug
   where m.entity_id = p_entity
   order by d.doc_date asc nulls last, m.doc_slug, m.char_offset
   limit least(p_lim, 500)
$$;

-- neighbourhood() with a knowledge cutoff: the walk only traverses edges
-- whose document existed by p_as_of. Mirrors 04-api.sql's set-semantics walk
-- (level-set UNION - the path-set version explodes on hub nodes; see there),
-- plus the date predicate; undated edges (US docs) are excluded.
create or replace function demo.neighbourhood_as_at(p_root bigint, p_as_of date, p_max_depth int default 2, p_lim int default 200)
returns table (id bigint, kind text, label text, depth int, via_doc text, weight int)
language sql stable security definer
set search_path = demo, corpus, public, extensions as $$
  with recursive walk as (
    select e.id, 0 as depth
      from demo.entities e where e.id = p_root
    union
    select case when g.source = w.id then g.target else g.source end,
           w.depth + 1
      from walk w
      join demo.edges g on (g.source = w.id or g.target = w.id)
     where w.depth < least(p_max_depth, 4)
       and g.doc_date is not null and g.doc_date <= p_as_of
  ),
  best as (
    select id, min(depth) as depth from walk group by id
  )
  select b.id, e.kind, e.label, b.depth,
         case when b.depth = 0 then null
              else (array_agg(g.doc_slug order by g.weight desc))[1] end,
         case when b.depth = 0 then 0 else max(g.weight) end
    from best b
    join demo.entities e on e.id = b.id
    left join demo.edges g on (g.source = b.id or g.target = b.id)
   group by b.id, e.kind, e.label, b.depth
   order by b.depth, max(g.weight) desc nulls last
   limit least(p_lim, 500)
$$;

-- cross_document_entities as at a date: bridging entities recomputed WITHIN
-- the window (not the denormalized counters, which count all time).
create or replace function demo.bridges_as_at(p_as_of date, p_lim int default 50)
returns table (id bigint, kind text, label text, mentions_count int, docs_count int, docs text[])
language sql stable security definer
set search_path = demo, corpus, public, extensions as $$
  select e.id, e.kind, e.label,
         count(*)::int as mentions_count,
         count(distinct m.doc_slug)::int as docs_count,
         array_agg(distinct m.doc_slug order by m.doc_slug) as docs
    from demo.entities e
    join demo.mentions m on m.entity_id = e.id
    join corpus.documents d on d.slug = m.doc_slug
   where d.doc_date is not null and d.doc_date <= p_as_of
   group by e.id, e.kind, e.label
  having count(distinct m.doc_slug) >= 2
   order by docs_count desc, mentions_count desc
   limit least(p_lim, 200)
$$;

-- The identity pin: which registry identifiers does this entity co-occur
-- with? Uses the EXISTING co-proximity edges - an organisation and the ABN it
-- printed within 400 characters are already linked; this surfaces the link.
create or replace function demo.entity_registry_ids(p_entity bigint)
returns table (id bigint, label text, norm text, docs text[])
language sql stable security definer
set search_path = demo, corpus, public, extensions as $$
  select a.id, a.label, a.norm,
         array_agg(distinct g.doc_slug order by g.doc_slug) as docs
    from demo.edges g
    join demo.entities a
      on a.id = case when g.source = p_entity then g.target else g.source end
   where (g.source = p_entity or g.target = p_entity)
     and a.kind = 'abn'
   group by a.id, a.label, a.norm
$$;

-- Grants: the four read RPCs join the existing nine. Mutating extractors and
-- normalizers are pipeline functions and are deliberately NOT granted - anon
-- reads through read-only RPCs or not at all.
grant execute on function demo.entity_timeline(bigint, int) to anon, authenticated;
grant execute on function demo.neighbourhood_as_at(bigint, date, int, int) to anon, authenticated;
grant execute on function demo.bridges_as_at(date, int) to anon, authenticated;
grant execute on function demo.entity_registry_ids(bigint) to anon, authenticated;
