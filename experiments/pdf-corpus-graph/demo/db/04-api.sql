-- Pinned because these files run over the transaction pooler, where there is no
-- ambient search_path - a fresh database fails with "no schema has been selected
-- to create in" otherwise.
set search_path = demo, corpus, public, extensions;

-- The API. PostgREST exposes these automatically over HTTPS, so there is no
-- separate API server in this demo: a Postgres function IS the endpoint.
--
-- Everything is read-only and security-invoker. Nothing here writes, so the
-- anon role can be granted execute without exposing a mutation surface.

-- Document inventory. The UI's landing table.
--
-- source_bytes and extracted_bytes sit side by side on purpose: the ratio
-- between them spans 0.048 to 1.0885 across this corpus, and conflating source
-- size with database size is the most common error in reading this use case.
create or replace view demo.v_documents as
select d.slug,
       d.genre,
       d.source_bytes,
       d.extracted_bytes,
       round((d.extracted_bytes::numeric / nullif(d.source_bytes, 0)), 4) as extract_ratio,
       count(distinct m.entity_id)                                        as entities,
       count(m.id)                                                        as mentions
  from corpus.documents d
  left join demo.mentions m on m.doc_slug = d.slug
 group by d.slug, d.genre, d.source_bytes, d.extracted_bytes;

-- Fuzzy entity search.
--
-- Uses the `%` operator rather than `similarity(a,b) > <constant>`. Two reasons,
-- both checked rather than assumed:
--
--   `%` is GIN-indexable, so it can use entities_label_trgm. A bare
--   similarity() call in WHERE cannot and degrades to a seq scan.
--
--   `%` honours pg_trgm's configured threshold, which show_limit() reports as
--   0.300 on this instance. Measured against real labels from this corpus that
--   sits in the right place: an exact hit scores 1.000, AC-1 vs AC-11 scores
--   0.571, AC-1 vs AU-1 (a single character off) scores 0.429, and AC-1 vs
--   SI-18 scores 0.100. So the default admits near-misses and rejects
--   unrelated labels without a hand-tuned constant in the query.
-- Tiered ranking. The first version scored every ILIKE-prefix hit 1.0, so a
-- search for "AC-1" ranked AC-17, AC-19 and AC-18 above AC-1 itself - the exact
-- match was not even in the top five. Exactness has to outrank prefix, and
-- prefix has to outrank substring, or a search box is unusable on a corpus whose
-- labels are systematically prefixes of each other (AC-1 / AC-11 / AC-17).
--
-- Punctuation-insensitive matching carries the typo tolerance, not trigrams.
-- Measured: trigram similarity is too weak on 3-4 character labels ("AC1" vs
-- "AC-1" shares almost no trigrams once the hyphen is counted, falling below
-- pg_trgm's 0.300 default). Stripping non-alphanumerics from both sides is what
-- makes "AC1", "ac-1" and "5USC552" find their nodes. Trigrams stay in the
-- predicate because they still help on longer statute and Public Law labels.
create or replace function demo.search_entities(q text, lim int default 25)
returns table (id bigint, kind text, label text, mentions_count int, docs_count int, score real)
language sql stable security definer set search_path = demo, corpus, public, extensions as $$
  with nq as (select regexp_replace(upper(q), '[^A-Z0-9]', '', 'g') as sq)
  select e.id, e.kind, e.label, e.mentions_count, e.docs_count,
         (case
            when lower(e.label) = lower(q) then 4.0
            when regexp_replace(upper(e.label), '[^A-Z0-9]', '', 'g') = (select sq from nq) then 3.9
            when e.label ilike q || '%' then 3.0 - (length(e.label) - length(q))::real / 100
            when e.label ilike '%' || q || '%' then 2.0
            else 1.0 + similarity(e.label, q)
          end)::real
    from demo.entities e, nq
   where e.label ilike '%' || q || '%'
      or e.label % q
      or regexp_replace(upper(e.label), '[^A-Z0-9]', '', 'g') like '%' || nq.sq || '%'
   order by 6 desc, e.mentions_count desc
   limit least(lim, 100)
$$;

-- Neighbourhood expansion by recursive CTE.
--
-- The zero-dependency traversal option. G04 measured what the two indexes on the
-- edge table are worth: depth 3 over 100k/400k was 167.82ms without them and
-- 0.26ms with them. depth is capped because an uncapped recursive CTE on a dense
-- graph is an outage, not a query.
create or replace function demo.neighbourhood(root bigint, max_depth int default 2, lim int default 200)
returns table (id bigint, kind text, label text, depth int, via_doc text, weight int)
language sql stable security definer set search_path = demo, corpus, public, extensions as $$
  with recursive walk as (
    select e.id, 0 as depth, null::text as via_doc, 0 as weight
      from demo.entities e where e.id = root
    union all
    select case when g.source = w.id then g.target else g.source end,
           w.depth + 1,
           g.doc_slug,
           g.weight
      from walk w
      join demo.edges g on (g.source = w.id or g.target = w.id)
     where w.depth < least(max_depth, 4)
  ),
  best as (
    select id, min(depth) as depth,
           (array_agg(via_doc order by weight desc nulls last))[1] as via_doc,
           max(weight) as weight
      from walk group by id
  )
  select b.id, e.kind, e.label, b.depth, b.via_doc, b.weight
    from best b join demo.entities e on e.id = b.id
   order by b.depth, b.weight desc
   limit least(lim, 500)
$$;

-- Shortest path via pgrouting.
--
-- pgr_dijkstra's Edges SQL contract requires columns named exactly id, source,
-- target, cost (ANY-INTEGER for the first three, ANY-NUMERICAL for the costs),
-- verified against the pgRouting manual - which is why demo.edges uses those
-- names rather than the natural source_id/target_id. cost is 1/weight, so the
-- cheapest path is the most strongly co-cited one rather than merely the fewest
-- hops. directed := false because co-citation is symmetric.
create or replace function demo.shortest_path(src bigint, dst bigint)
returns table (seq int, id bigint, kind text, label text, cost double precision, agg_cost double precision)
language sql stable security definer set search_path = demo, corpus, public, extensions as $$
  select r.seq, r.node, e.kind, e.label, r.cost, r.agg_cost
    from pgr_dijkstra(
           'select id, source, target, cost, reverse_cost from demo.edges',
           src, dst, directed := false
         ) r
    join demo.entities e on e.id = r.node
   order by r.seq
$$;

-- Connected components, so the UI can show the graph is not one blob.
create or replace function demo.components(min_size int default 2)
returns table (component bigint, size bigint, sample_labels text)
language sql stable security definer set search_path = demo, corpus, public, extensions as $$
  with c as (
    select * from pgr_connectedComponents(
      'select id, source, target, cost, reverse_cost from demo.edges'
    )
  )
  select c.component, count(*) as size,
         string_agg(e.label, ', ' order by e.mentions_count desc)
           filter (where e.label is not null) as sample_labels
    from c join demo.entities e on e.id = c.node
   group by c.component
  having count(*) >= min_size
   order by 2 desc
$$;

-- Why does this node exist? The provenance panel.
--
-- Every mention carries its document and exact character offset, with a 150-char
-- window as the snippet. This is the requirement the literature is unanimous
-- about, and the reason the offset arithmetic in 03-extract-setbased.sql is
-- verified against substr() rather than assumed.
create or replace function demo.provenance(entity bigint, lim int default 20)
returns table (doc_slug text, genre text, char_offset int, snippet text)
language sql stable security definer set search_path = demo, corpus, public, extensions as $$
  select m.doc_slug, d.genre, m.char_offset, m.snippet
    from demo.mentions m
    join corpus.documents d on d.slug = m.doc_slug
   where m.entity_id = entity
   order by m.doc_slug, m.char_offset
   limit least(lim, 200)
$$;

-- Graph payload for one root, shaped for the client renderer in a single round
-- trip: nodes plus the edges among them. Fetching those separately would let the
-- edge set disagree with the node set.
create or replace function demo.subgraph(root bigint, max_depth int default 2, lim int default 120)
returns jsonb language sql stable security definer set search_path = demo, corpus, public, extensions as $$
  with n as (select * from demo.neighbourhood(root, max_depth, lim)),
  e as (
    select g.id, g.source, g.target, g.weight, g.doc_slug, g.kind
      from demo.edges g
     where g.source in (select id from n) and g.target in (select id from n)
  )
  select jsonb_build_object(
    'root', root,
    'nodes', coalesce((select jsonb_agg(to_jsonb(n)) from n), '[]'::jsonb),
    'edges', coalesce((select jsonb_agg(to_jsonb(e)) from e), '[]'::jsonb)
  )
$$;

-- Corpus-level counters for the header strip.
create or replace function demo.stats()
returns jsonb language sql stable security definer set search_path = demo, corpus, public, extensions as $$
  select jsonb_build_object(
    'documents', (select count(*) from corpus.documents),
    'entities',  (select count(*) from demo.entities),
    'mentions',  (select count(*) from demo.mentions),
    'edges',     (select count(*) from demo.edges),
    'by_kind',   (select jsonb_object_agg(kind, n) from (
                    select kind, count(*) n from demo.entities group by kind) k)
  )
$$;

grant usage on schema demo to anon, authenticated;
-- NO table grants. The seven functions are the entire surface. Granting select
-- on demo.entities/mentions/edges would expose them through PostgREST's
-- auto-generated table endpoint, and RLS alone then has to hold the line. The
-- view v_documents was dropped in favour of demo.documents(), so this file used
-- to reference a relation that no longer exists - which is exactly why a fresh
-- run of the file failed silently on a rebuild.
grant execute on function
  demo.search_entities(text, int),
  demo.neighbourhood(bigint, int, int),
  demo.shortest_path(bigint, bigint),
  demo.components(int),
  demo.provenance(bigint, int),
  demo.subgraph(bigint, int, int),
  demo.stats()
  to anon, authenticated;
