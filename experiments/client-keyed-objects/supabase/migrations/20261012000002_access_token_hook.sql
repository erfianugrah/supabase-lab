-- Custom access token hook: adds `tenant_ids` (sorted uuid strings) to every
-- access token. Enabled per target (Management API auth config on managed,
-- GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_* on self-hosted) with the same URI:
--   pg-functions://postgres/app/custom_access_token_hook

create function app.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  ids jsonb;
begin
  select coalesce(jsonb_agg(m.tenant_id::text order by m.tenant_id::text), '[]'::jsonb)
    into ids
    from app.memberships m
   where m.user_id = (event ->> 'user_id')::uuid;
  return jsonb_set(event, '{claims,tenant_ids}', ids);
end $$;

grant usage on schema app to supabase_auth_admin;
grant execute on function app.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function app.custom_access_token_hook(jsonb) from authenticated, anon, public;
grant select on table app.memberships to supabase_auth_admin;

create policy memberships_auth_admin on app.memberships for select to supabase_auth_admin
  using (true);
