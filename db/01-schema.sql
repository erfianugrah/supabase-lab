-- Demo schema: a real citation graph over the loaded public-document corpus.
--
-- WHY DETERMINISTIC EXTRACTION RATHER THAN AN LLM. The general case for
-- document -> entity graph is LLM triple extraction, and every serious pipeline
-- in the field does it that way. This corpus is the special case where that is
-- unnecessary: US federal legal and regulatory documents carry their
-- cross-references as EXPLICIT, grammatically fixed citations - a NIST control
-- id (AC-1), a statute (5 U.S.C. 552), a regulation (17 CFR 240), a Public Law
-- number. Those are regex-exact, so every entity and every edge in this demo is
-- verifiable against the source text with zero hallucination and exact
-- provenance. An LLM would add recall on implicit relationships and would also
-- add a review burden this demo does not need to show anything.
--
-- The tradeoff is stated rather than hidden: this extracts CITATIONS, not
-- arbitrary entities. It does not demonstrate open-domain entity extraction.
--
-- SEPARATE SCHEMA. corpus.* holds the benchmark tables (a synthetic 100k-entity
-- graph used to measure traversal latency). Mixing the demo's real-but-small
-- graph into those would corrupt the benchmark and make both unreadable.

create schema if not exists demo;

create extension if not exists pg_trgm;

-- One row per distinct cited thing.
--
-- `norm` is the dedup key and `label` is what a human reads. They differ because
-- the same statute appears as "5 U.S.C. 552", "5 USC 552" and "5 U. S. C. 552"
-- in the same corpus; collapsing on a normalized form is the cheap half of the
-- entity-resolution problem that every pipeline in this space has to solve.
create table if not exists demo.entities (
  id      bigserial primary key,
  kind    text not null check (kind in ('nist_control','usc','cfr','publaw')),
  label   text not null,
  norm    text not null,
  mentions_count int not null default 0,
  docs_count     int not null default 0,
  unique (kind, norm)
);

-- Provenance. Every claim the graph makes has to be traceable to a byte offset
-- in a named source document, which is the one requirement the literature is
-- unanimous about. Without it you cannot explain why an edge exists.
create table if not exists demo.mentions (
  id          bigserial primary key,
  entity_id   bigint not null references demo.entities(id) on delete cascade,
  doc_slug    text   not null,
  char_offset integer not null,
  snippet     text   not null
);

-- Column names are `source`, `target`, `cost`, `reverse_cost` on purpose.
-- pgrouting's Edges SQL contract requires exactly those (ANY-INTEGER for the
-- first three, ANY-NUMERICAL for the costs), verified against the pgRouting
-- manual. Naming them source_id/target_id - the natural relational choice -
-- forces an aliasing subquery at every single pgr_* call site.
create table if not exists demo.edges (
  id           bigserial primary key,
  source       bigint not null references demo.entities(id) on delete cascade,
  target       bigint not null references demo.entities(id) on delete cascade,
  cost         double precision not null default 1,
  reverse_cost double precision not null default 1,
  kind         text   not null default 'co_citation',
  doc_slug     text   not null,
  weight       integer not null default 1,
  unique (source, target, doc_slug)
);

-- G04 measured this exact decision: depth-3 recursive-CTE traversal over
-- 100k/400k was 167.82ms unindexed and 0.26ms with these two indexes present,
-- on a 1.5s build. Not optional.
create index if not exists edges_source_idx on demo.edges (source);
create index if not exists edges_target_idx on demo.edges (target);
create index if not exists mentions_entity_idx on demo.mentions (entity_id);
create index if not exists mentions_doc_idx on demo.mentions (doc_slug);

-- Fuzzy label search. pg_trgm is the deterministic half of entity resolution
-- and it is also what makes the UI's search box tolerant of a typo.
create index if not exists entities_label_trgm on demo.entities using gin (label gin_trgm_ops);
