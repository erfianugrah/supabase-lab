-- Pinned because these files run over the transaction pooler, where there is no
-- ambient search_path - a fresh database fails with "no schema has been selected
-- to create in" otherwise.
set search_path = demo, corpus, public, extensions;

-- Keyword search over extracted document text.
--
-- Generated, not on-the-fly: the index is the pattern that scales. On-the-fly
-- to_tsvector against extracted_text is the classic "works in the demo,
-- seq-scans in production" mistake.
-- simplify: left(extracted_text, 100000) bounds ts_headline against a 31 MB
-- column. Headline generation over full text of a 14 MB document would time out;
-- the bound keeps the RPC responsive. Lift it when faster hardware arrives.
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

-- The two new functions join the existing seven. Same contract: security definer,
-- pinned search_path, execute granted to anon+authenticated, no table grants.
grant execute on function demo.search_documents(text, int) to anon, authenticated;
grant execute on function demo.cross_document_entities(int) to anon, authenticated;
