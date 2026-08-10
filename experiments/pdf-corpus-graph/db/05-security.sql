-- Security hardening for the demo + corpus schemas.
--
-- STARTING STATE, measured before writing this: RLS was OFF on all eight tables
-- in `demo` and `corpus`. Access control rested entirely on two things - grants
-- revoked from `anon`, and the API being SECURITY DEFINER functions. That does
-- work (a direct table read over PostgREST returns 42501), but it is a single
-- layer: one careless GRANT re-opens everything with nothing behind it.
--
-- WHY NO POLICIES. Enabling RLS with zero policies is deny-by-default for
-- non-owner roles, which is exactly the intent here. Adding a permissive policy
-- would only widen the surface. The seven read-only functions stay SECURITY
-- DEFINER and keep working precisely BECAUSE definer functions run as the owner
-- and bypass RLS - so RLS here is the second layer under the grants, not the
-- mechanism the API depends on.
--
-- This is deliberately not the pattern for a multi-tenant application. There,
-- RLS with real policies keyed on auth.uid() is the primary control and the
-- definer function is the exception. Here the data is a public read-only corpus
-- with no tenancy, so the curated-function surface is the primary control.

begin;

alter table corpus.documents        enable row level security;
alter table corpus.entities         enable row level security;
alter table corpus.edges            enable row level security;
alter table corpus.chunks           enable row level security;
alter table corpus.chunks_halfvec   enable row level security;
alter table demo.entities           enable row level security;
alter table demo.mentions           enable row level security;
alter table demo.edges              enable row level security;

commit;

-- Pin search_path on the extraction helpers too.
--
-- These are SECURITY INVOKER, so they run with the caller's rights and anon has
-- no EXECUTE on any of them - the escalation shape that makes a mutable
-- search_path dangerous needs DEFINER rights to exploit. They are pinned anyway:
-- it costs nothing, it silences a real advisor finding rather than suppressing
-- it, and it means a future ALTER that flips one to DEFINER does not silently
-- inherit a mutable path.
alter function demo.citation_patterns()                    set search_path = demo, corpus, public, extensions;
alter function demo.normalize_citation(text, text)         set search_path = demo, corpus, public, extensions;
alter function demo.extract_document(text)                 set search_path = demo, corpus, public, extensions;
alter function demo.extract_document_fast(text)            set search_path = demo, corpus, public, extensions;
alter function demo.build_edges(int)                       set search_path = demo, corpus, public, extensions;
alter function demo.refresh_counters()                     set search_path = demo, corpus, public, extensions;

-- NOT MOVED, deliberately:
--   postgis  - extrelocatable = f. It cannot be moved; the advisor flags it
--              regardless. It only exists here because pgrouting cascades it.
--   vector   - relocatable, but corpus.chunks and corpus.chunks_halfvec have
--              columns of that type. Relocating a type extension under live
--              columns is a real risk for a cosmetic advisor win, so it stays
--              and the reason is recorded rather than the finding suppressed.
--   public.spatial_ref_sys - a PostGIS system table, arrived via the same
--              cascade. Not ours to alter, and the remaining ERROR.
