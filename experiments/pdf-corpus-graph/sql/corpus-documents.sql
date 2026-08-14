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
  -- The document's own date (meeting date, register snapshot date), as opposed
  -- to loaded_at (when the row landed). Nullable: the seven US federal seed
  -- documents predate the column and stay null rather than backfilled with
  -- guesses. The AU council corpus sets it; the demo's as-at queries filter
  -- on it. Added 2026-08-14 for the editorial time axis (plan Track F2).
  doc_date date,
  loaded_at timestamptz not null default now()
);

-- Rebuilds of an EXISTING database (the column was added after the first
-- projects ran) need the same shape; plain `alter ... if not exists`.
alter table corpus.documents add column if not exists doc_date date;
