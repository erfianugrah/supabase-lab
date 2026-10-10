-- CL01-CL03 fixture: the object kinds a Supabase app schema actually carries.
-- Applied to a local database that already has the platform schemas, so it
-- only touches `app` and `public`.

-- extension (installed into the `extensions` schema, as the dashboard does)
create extension if not exists pg_trgm with schema extensions;

-- types, sequences
create schema app;
create type app.status as enum ('draft', 'live', 'archived');
create sequence app.ticket_seq start 1000;

-- tables: identity, generated column, check, fk, defaults
create table app.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table app.docs (
  id bigint generated always as identity primary key,
  org_id uuid not null references app.orgs (id) on delete cascade,
  owner_id uuid not null,
  title text not null check (length(title) > 0),
  body text,
  status app.status not null default 'draft',
  title_lower text generated always as (lower(title)) stored,
  ticket int default nextval('app.ticket_seq'),
  updated_at timestamptz not null default now()
);
comment on table app.docs is 'documents; RLS by owner';
comment on column app.docs.status is 'lifecycle state';

create index docs_title_trgm on app.docs using gin (title extensions.gin_trgm_ops);
create index docs_live_idx on app.docs (org_id, updated_at desc) where status = 'live';

-- view with security_invoker
create view app.live_docs with (security_invoker = true) as
  select id, org_id, title from app.docs where status = 'live';

-- functions: invoker, definer with pinned search_path, a trigger function
create function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create function app.doc_count(p_org uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select count(*) from app.docs where org_id = p_org
$$;
revoke all on function app.doc_count(uuid) from public;
grant execute on function app.doc_count(uuid) to authenticated;

-- trigger
create trigger docs_touch before update on app.docs
  for each row execute function app.touch_updated_at();

-- RLS: enabled + forced on docs, enabled on orgs; policies per command and role
alter table app.docs enable row level security;
alter table app.docs force row level security;
alter table app.orgs enable row level security;

create policy docs_select on app.docs for select to authenticated
  using (owner_id = (select auth.uid()));
create policy docs_insert on app.docs for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy docs_update on app.docs for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy docs_anon_live on app.docs as restrictive for select to anon
  using (status = 'live');
create policy orgs_read on app.orgs for select using (true);

-- grants (table, column, sequence, schema) and default privileges
grant usage on schema app to anon, authenticated, service_role;
grant select on app.orgs to anon, authenticated;
grant select, insert, update on app.docs to authenticated;
grant select on app.live_docs to anon;
grant update (title) on app.docs to anon;
grant usage on sequence app.ticket_seq to authenticated;
alter default privileges in schema app grant select on tables to authenticated;
alter default privileges in schema app grant usage, select on sequences to authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon;

-- something in public too, so the default schema set has content
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  handle text unique
);
alter table public.profiles enable row level security;
create policy profiles_self on public.profiles for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
grant select, insert, update, delete on public.profiles to authenticated;
