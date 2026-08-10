-- corpus.chunks - text chunks plus synthetic embedding vectors, per
-- GUIDE.md's schema contract and its "embeddings without an embedding
-- provider" section: vector STORAGE cost and index behaviour are independent
-- of the vector's values, so this experiment never calls an embedding API.
--
-- Two tables, not two columns on one table: `pg_table_size` reports whole-
-- relation size, so comparing vector vs halfvec storage needs the two types
-- in separate relations rather than two columns sharing one heap.
--
-- No ANN index here - G05 builds and drops HNSW/IVFFLAT on corpus.chunks
-- itself so it can measure build time cleanly on each run.
create extension if not exists vector;

create schema if not exists corpus;

create table if not exists corpus.chunks (
  id bigserial primary key,
  content text not null,
  embedding vector (1536)
);

create table if not exists corpus.chunks_halfvec (
  id bigserial primary key,
  content text not null,
  embedding halfvec (1536)
);
