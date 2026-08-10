-- corpus.entities / corpus.edges - the entity graph, per GUIDE.md's schema
-- contract. Idempotent. Populated by G04 (recursive-CTE traversal) and read
-- again, unmodified, by G07 (pgrouting) - both measure the SAME graph.
--
-- `entities.id` is a bigint surrogate key: pgrouting's algorithms require
-- bigint node ids, so a uuid-only entity table could not be handed to them
-- without a join table (see G07).
--
-- `edges` columns are named source_id/target_id/cost, not source/target/cost.
-- That is deliberate, not an oversight: pgrouting's functions require exactly
-- `id`, `source`, `target`, `cost` in the inner edge SQL they are handed, and
-- this table's own primary key already satisfies the `id` half of that. The
-- source_id/target_id naming is the ordinary relational convention for this
-- table on its own; G07 supplies the required aliasing subquery
-- (`source_id as source, target_id as target`) at the call site rather than
-- renaming the columns here, so the cost of the mismatch is visible exactly
-- where it is paid.
--
-- No index is created here on purpose. G04 measures traversal with and
-- without an index on edges(source_id)/edges(target_id) - baking one in here
-- would make "the same query with and without an index" impossible to
-- reproduce cleanly on every run.
create schema if not exists corpus;

create table if not exists corpus.entities (
  id bigserial primary key,
  name text not null,
  kind text not null default 'synthetic'
);

create table if not exists corpus.edges (
  id bigserial primary key,
  source_id bigint not null references corpus.entities (id),
  target_id bigint not null references corpus.entities (id),
  cost double precision not null default 1,
  reverse_cost double precision
);
