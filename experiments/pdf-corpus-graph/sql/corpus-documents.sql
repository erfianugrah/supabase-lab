-- corpus.documents - one row per source PDF, per GUIDE.md's schema contract.
-- Idempotent: `create ... if not exists` throughout, safe to run every suite
-- iteration. Populated by G03 (expansion ratio). `extracted_text` is stored
-- as ordinary `text` - TOAST compresses it automatically, which is the whole
-- point of measuring `pg_column_size` rather than the logical byte count.
create schema if not exists corpus;

create table if not exists corpus.documents (
  slug text primary key,
  genre text not null,
  source_url text not null,
  source_bytes bigint not null,
  extracted_text text,
  extracted_bytes bigint,
  loaded_at timestamptz not null default now()
);
