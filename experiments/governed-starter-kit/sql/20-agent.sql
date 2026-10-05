-- Schema for an in-app agent that acts as the signed-in user.
--
-- The agent never gets more access than the user: it calls the same tables and
-- functions through the user's session, so every read and write goes through
-- the policies in 00/10. Retrieval is pgvector over knowledge-base text that
-- is company-wide or scoped to the user's department. Embeddings are 384
-- dimensions (the gte-small model available in Edge Functions); inner-product
-- ops because that model's output is normalised.

create extension if not exists vector with schema extensions;

create table if not exists public.kb_chunks (
  id            uuid primary key default gen_random_uuid(),
  department_id uuid references public.departments (id), -- null = company-wide
  title         text not null,
  content       text not null,
  embedding     extensions.vector(384)
);
create index if not exists kb_chunks_department_id_idx on public.kb_chunks (department_id);
create index if not exists kb_chunks_embedding_idx
  on public.kb_chunks using hnsw (embedding extensions.vector_ip_ops);

alter table public.kb_chunks enable row level security;
revoke all on public.kb_chunks from anon, authenticated;
grant select on public.kb_chunks to authenticated;

drop policy if exists "kb: company-wide or own department" on public.kb_chunks;
create policy "kb: company-wide or own department" on public.kb_chunks
  for select to authenticated
  using (department_id is null or department_id = (select private.my_department()));

-- Every tool call the agent makes is recorded as the user who made it.
create table if not exists public.agent_audit (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default auth.uid() references public.profiles (id),
  department_id  uuid not null default private.my_department() references public.departments (id),
  tool           text not null,
  args           jsonb not null default '{}'::jsonb,
  result_summary text,
  created_at     timestamptz not null default now()
);
create index if not exists agent_audit_user_id_idx on public.agent_audit (user_id);
create index if not exists agent_audit_department_id_idx on public.agent_audit (department_id);

alter table public.agent_audit enable row level security;
revoke all on public.agent_audit from anon, authenticated;
grant select on public.agent_audit to authenticated;
grant insert (tool, args, result_summary) on public.agent_audit to authenticated;

drop policy if exists "audit: write own" on public.agent_audit;
create policy "audit: write own" on public.agent_audit
  for insert to authenticated
  with check (user_id = (select auth.uid()) and department_id = (select private.my_department()));

drop policy if exists "audit: read own or as manager" on public.agent_audit;
create policy "audit: read own or as manager" on public.agent_audit
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or ((select private.is_manager()) and department_id = (select private.my_department()))
  );

-- Retrieval as the caller: RLS on kb_chunks decides which rows can match.
create or replace function public.match_kb_chunks(query_embedding extensions.vector(384), match_count int default 5)
returns table (id uuid, title text, content text, similarity double precision)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.title, c.content,
         -(c.embedding operator(extensions.<#>) query_embedding) as similarity
    from public.kb_chunks c
   where c.embedding is not null
   order by c.embedding operator(extensions.<#>) query_embedding
   limit least(greatest(match_count, 1), 20)
$$;

revoke execute on function public.match_kb_chunks(extensions.vector, int) from public, anon;
grant execute on function public.match_kb_chunks(extensions.vector, int) to authenticated;
