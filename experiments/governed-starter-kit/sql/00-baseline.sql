-- Kit baseline: the guardrails every internal app starts from.
--
-- Tenancy is the department. A user's department and role come from
-- app_metadata, which only a server holding the secret key can set, so a user
-- cannot move themselves into another department or promote themselves.
-- Every table has RLS on, explicit grants, and policies scoped TO
-- authenticated. Helper functions live in a schema PostgREST does not expose.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table if not exists public.departments (
  id   uuid primary key default gen_random_uuid(),
  name text not null unique
);

create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  department_id uuid not null references public.departments (id),
  role          text not null default 'employee' check (role in ('employee', 'manager')),
  display_name  text not null default ''
);
create index if not exists profiles_department_id_idx on public.profiles (department_id);

alter table public.departments enable row level security;
alter table public.profiles enable row level security;

-- Explicit grants rather than relying on default privileges. A user may
-- change their display name and nothing else on their profile: the column
-- grant is what stops a self-promotion, before any policy is consulted.
revoke all on public.departments, public.profiles from anon, authenticated;
grant select on public.departments to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

-- SECURITY DEFINER so policies on profiles can read profiles without
-- recursing into their own RLS. Fixed empty search_path; not exposed.
create or replace function private.my_department() returns uuid
language sql stable security definer set search_path = '' as $$
  select department_id from public.profiles where id = (select auth.uid())
$$;

create or replace function private.is_manager() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select role = 'manager' from public.profiles where id = (select auth.uid())),
    false)
$$;

revoke execute on function private.my_department(), private.is_manager() from public;
grant execute on function private.my_department(), private.is_manager() to authenticated;

drop policy if exists "departments: own" on public.departments;
create policy "departments: own" on public.departments
  for select to authenticated
  using (id = (select private.my_department()));

drop policy if exists "profiles: same department" on public.profiles;
create policy "profiles: same department" on public.profiles
  for select to authenticated
  using (department_id = (select private.my_department()));

drop policy if exists "profiles: update self" on public.profiles;
create policy "profiles: update self" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Profiles follow app_metadata. A user whose app_metadata names no known
-- department has no profile, and with no profile every policy above returns
-- nothing - signed in, but no access - until the platform team sets one.
-- The trigger fires on update of raw_app_meta_data as well as on insert:
-- users created through the Auth admin API failed the original insert-only
-- version with department_id null even though app_metadata was in the
-- request, so the department arrives after the insert (observed 2026-10-05).
create or replace function private.sync_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  dept uuid;
begin
  select d.id into dept from public.departments d
   where d.name = new.raw_app_meta_data ->> 'department';
  if dept is null then
    return new;
  end if;
  insert into public.profiles (id, department_id, role, display_name)
  values (
    new.id,
    dept,
    coalesce(new.raw_app_meta_data ->> 'role', 'employee'),
    coalesce(new.raw_user_meta_data ->> 'display_name', '')
  )
  on conflict (id) do update
    set department_id = excluded.department_id,
        role = excluded.role;
  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists private.handle_new_user();
drop trigger if exists on_auth_user_synced on auth.users;
create trigger on_auth_user_synced
  after insert or update of raw_app_meta_data on auth.users
  for each row execute function private.sync_profile();
