-- Fan-out API cache: cacheable upstream responses for the fanout-api Edge
-- Function (the backend-for-frontend demo), keyed by user and endpoint.
-- Needs 00-baseline.sql (the private schema and authenticated's USAGE on it).
--
-- Why Postgres and not an in-memory map in the function: hosted Edge
-- Functions run many isolates, started and stopped on demand, so a per-isolate
-- map is a best-effort cache whose hit rate nobody can predict - the second
-- request of a demo may land on a fresh isolate and miss. A row here is shared
-- by every isolate and survives a cold start. The cost is one PostgREST round
-- trip per screen request for the read, and one more on a miss for the write.
-- What the cache holds (which endpoints, for how long) is decided by the
-- upstream's own Cache-Control header, not by this file.
--
-- Access: the table lives in `private`, which the Data API does not expose.
-- Users read their own unexpired rows through public.fanout_cache_get, a
-- SECURITY INVOKER function, so RLS on this table decides what comes back.
-- Only service_role (the function's secret key) writes, through
-- public.fanout_cache_put: a user cannot plant data in the cache, even
-- their own. One row per (user, endpoint), overwritten on refresh, so the
-- table is bounded by users x 4 and needs no purge job; expired rows are
-- just ignored until the next write replaces them.

create table if not exists private.fanout_cache (
  user_id    uuid not null references auth.users (id) on delete cascade,
  endpoint   text not null check (endpoint in ('profile', 'feed', 'inbox', 'stats')),
  body       jsonb not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, endpoint)
);
alter table private.fanout_cache enable row level security;

-- Explicit grants rather than relying on default privileges.
revoke all on private.fanout_cache from public, anon, authenticated, service_role;
grant select on private.fanout_cache to authenticated;
grant usage on schema private to service_role;
grant select, insert, update on private.fanout_cache to service_role;

drop policy if exists "fanout_cache: own rows" on private.fanout_cache;
create policy "fanout_cache: own rows" on private.fanout_cache
  for select to authenticated
  using (user_id = (select auth.uid()));

-- The read path. SECURITY INVOKER: it runs as the calling user, and the
-- policy above returns only that user's rows; the expiry filter is here.
create or replace function public.fanout_cache_get(p_endpoints text[])
returns table (endpoint text, body jsonb, age_s int)
language sql stable security invoker set search_path = '' as $$
  select c.endpoint, c.body, floor(extract(epoch from (now() - c.fetched_at)))::int
    from private.fanout_cache c
   where c.endpoint = any (p_endpoints)
     and c.expires_at > now()
$$;
revoke execute on function public.fanout_cache_get(text[]) from public, anon;
grant execute on function public.fanout_cache_get(text[]) to authenticated;

-- The write path, service_role only. p_entries is
-- [{"endpoint": "...", "body": {...}, "ttl_s": n}, ...]; TTL capped at an hour.
create or replace function public.fanout_cache_put(p_user uuid, p_entries jsonb)
returns int
language sql security invoker set search_path = '' as $$
  with w as (
    insert into private.fanout_cache as c (user_id, endpoint, body, fetched_at, expires_at)
    select p_user, e ->> 'endpoint', e -> 'body', now(),
           now() + make_interval(secs => least(greatest((e ->> 'ttl_s')::int, 0), 3600))
      from jsonb_array_elements(p_entries) e
    on conflict (user_id, endpoint) do update
      set body = excluded.body, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
    returning 1
  )
  select count(*)::int from w
$$;
revoke execute on function public.fanout_cache_put(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fanout_cache_put(uuid, jsonb) to service_role;
