-- client-keyed-objects: the record catalogue (schema `app`).
--
-- Supabase holds the catalogue, the wrapped DEK and ciphertext only. The
-- key-encryption key lives in an operator-run key service outside Supabase.
-- Applied unchanged to every target (managed: `supabase db push`;
-- self-hosted: psql as `postgres`). No statement here may depend on which
-- target it runs on.

create schema if not exists app;

create type app.member_role as enum ('owner', 'editor', 'viewer');

create table app.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  home_region text not null,
  created_at timestamptz not null default now()
);

create table app.memberships (
  tenant_id uuid not null references app.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role app.member_role not null,
  primary key (tenant_id, user_id)
);
create index memberships_user_idx on app.memberships (user_id);

create table app.records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants (id) on delete cascade,
  title text not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'archived'))
);
create index records_tenant_idx on app.records (tenant_id);

-- One encrypted binary per row. tenant_id is denormalised from the record so
-- RLS and the storage path agree without a join; a trigger keeps it honest.
create table app.assets (
  id uuid primary key,
  record_id uuid not null references app.records (id) on delete cascade,
  tenant_id uuid not null references app.tenants (id) on delete cascade,
  object_key text not null unique,
  plaintext_size bigint not null check (plaintext_size >= 0),
  chunk_size integer not null check (chunk_size > 0),
  chunk_count integer not null check (chunk_count >= 0),
  ciphertext_size bigint not null check (ciphertext_size >= 0),
  cipher text not null default 'aes-256-gcm' check (cipher = 'aes-256-gcm'),
  key_id text not null,
  wrapped_dek text not null,
  nonce_prefix text not null,
  plaintext_sha256 text,
  upload_state text not null default 'pending'
    check (upload_state in ('pending', 'uploading', 'complete', 'failed')),
  upload_method text check (upload_method in ('s3-multipart', 'tus')),
  s3_upload_id text,
  tus_url text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint assets_object_key_shape check (object_key = tenant_id::text || '/' || id::text || '/data')
);
create index assets_record_idx on app.assets (record_id);
create index assets_tenant_idx on app.assets (tenant_id);

-- Per-chunk ciphertext SHA-256: the S3 endpoint neither validates nor stores
-- object checksums, so integrity is the catalogue's job.
create table app.asset_chunks (
  asset_id uuid not null references app.assets (id) on delete cascade,
  idx integer not null check (idx >= 0),
  ciphertext_sha256 text not null,
  primary key (asset_id, idx)
);

create table app.access_log (
  id bigint generated always as identity primary key,
  actor uuid default auth.uid(),
  action text not null,
  tenant_id uuid,
  asset_id uuid,
  byte_range text,
  at timestamptz not null default now()
);
create index access_log_tenant_idx on app.access_log (tenant_id, at);

-- ---------------------------------------------------------------- helpers

-- The caller's role in a tenant, or null. SECURITY DEFINER so the policies
-- on memberships can call it without recursing through their own RLS.
create function app.my_role(t uuid) returns app.member_role
language sql stable security definer set search_path = '' as $$
  select m.role from app.memberships m where m.tenant_id = t and m.user_id = auth.uid()
$$;

-- Tenant id from an object key `<tenant_id>/<asset_id>/data`; null when the
-- first segment is not a uuid (no cast error inside a storage policy).
create function app.key_tenant(name text) returns uuid
language sql immutable set search_path = '' as $$
  select case when split_part(name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(name, '/', 1)::uuid end
$$;

create function app.asset_tenant(a uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select x.tenant_id from app.assets x where x.id = a
$$;

create function app.assets_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.tenant_id is distinct from (select r.tenant_id from app.records r where r.id = new.record_id) then
    raise exception 'asset tenant % does not match its record', new.tenant_id using errcode = '23514';
  end if;
  return new;
end $$;

create trigger assets_check before insert or update of tenant_id, record_id on app.assets
  for each row execute function app.assets_check();

-- Catalogue changes land in access_log whoever makes them.
create function app.log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  r := coalesce(new, old);
  insert into app.access_log (actor, action, tenant_id, asset_id)
  values (
    auth.uid(),
    tg_table_name || ':' || lower(tg_op),
    r.tenant_id,
    case when tg_table_name = 'assets' then r.id end
  );
  return null;
end $$;

create trigger records_log after insert or update or delete on app.records
  for each row execute function app.log_change();
create trigger assets_log after insert or delete on app.assets
  for each row execute function app.log_change();
create trigger assets_log_state after update of upload_state on app.assets
  for each row execute function app.log_change();

-- ---------------------------------------------------------------- RLS

alter table app.tenants enable row level security;
alter table app.memberships enable row level security;
alter table app.records enable row level security;
alter table app.assets enable row level security;
alter table app.asset_chunks enable row level security;
alter table app.access_log enable row level security;

create policy tenants_read on app.tenants for select to authenticated
  using (app.my_role(id) is not null);

create policy memberships_read on app.memberships for select to authenticated
  using (user_id = (select auth.uid()) or app.my_role(tenant_id) is not null);
create policy memberships_owner_write on app.memberships for all to authenticated
  using (app.my_role(tenant_id) = 'owner') with check (app.my_role(tenant_id) = 'owner');

create policy records_read on app.records for select to authenticated
  using (app.my_role(tenant_id) is not null);
create policy records_insert on app.records for insert to authenticated
  with check (app.my_role(tenant_id) in ('owner', 'editor'));
create policy records_update on app.records for update to authenticated
  using (app.my_role(tenant_id) in ('owner', 'editor')) with check (app.my_role(tenant_id) in ('owner', 'editor'));
create policy records_delete on app.records for delete to authenticated
  using (app.my_role(tenant_id) in ('owner', 'editor'));

create policy assets_read on app.assets for select to authenticated
  using (app.my_role(tenant_id) is not null);
create policy assets_insert on app.assets for insert to authenticated
  with check (app.my_role(tenant_id) in ('owner', 'editor'));
create policy assets_update on app.assets for update to authenticated
  using (app.my_role(tenant_id) in ('owner', 'editor')) with check (app.my_role(tenant_id) in ('owner', 'editor'));
create policy assets_delete on app.assets for delete to authenticated
  using (app.my_role(tenant_id) in ('owner', 'editor'));

create policy chunks_read on app.asset_chunks for select to authenticated
  using (app.my_role(app.asset_tenant(asset_id)) is not null);
create policy chunks_write on app.asset_chunks for insert to authenticated
  with check (app.my_role(app.asset_tenant(asset_id)) in ('owner', 'editor'));
create policy chunks_update on app.asset_chunks for update to authenticated
  using (app.my_role(app.asset_tenant(asset_id)) in ('owner', 'editor'))
  with check (app.my_role(app.asset_tenant(asset_id)) in ('owner', 'editor'));

create policy access_log_insert on app.access_log for insert to authenticated
  with check (actor = (select auth.uid()) and app.my_role(tenant_id) is not null);
create policy access_log_read on app.access_log for select to authenticated
  using (app.my_role(tenant_id) = 'owner' or actor = (select auth.uid()));

-- ---------------------------------------------------------------- grants
-- Explicit: a project's default privileges are not something to rely on.

revoke all on schema app from public, anon;
revoke all on all tables in schema app from anon;
grant usage on schema app to authenticated, service_role;
grant select, insert, update, delete on all tables in schema app to authenticated;
grant all on all tables in schema app to service_role;
grant usage, select on all sequences in schema app to authenticated, service_role;
revoke execute on all functions in schema app from public, anon;
grant execute on function app.my_role(uuid), app.key_tenant(text), app.asset_tenant(uuid) to authenticated, service_role;
