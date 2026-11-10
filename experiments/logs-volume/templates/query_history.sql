-- Query history without a log drain: every 30 seconds pg_cron copies
-- pg_stat_statements and the running statements in pg_stat_activity into the
-- rca schema and keeps 3 hours. rca.top(window) ranks statements by execution
-- time inside that window. Safe to re-run. Remove with query_history_uninstall.sql.
--
-- Apply to one project:  supabase db query --remote=<ref> -f query_history.sql --yes
-- During an incident:    select * from rca.top('1 hour');
create extension if not exists pg_cron;

create schema if not exists rca;

create table if not exists rca.stmt_snap (
  ts timestamptz not null, userid oid, dbid oid, queryid bigint,
  calls bigint, total_exec_time double precision, rows bigint, shared_blks_read bigint
);
create index if not exists stmt_snap_ts_idx on rca.stmt_snap (ts);

create table if not exists rca.stmt_text (queryid bigint primary key, query text);

create table if not exists rca.act_snap (
  ts timestamptz not null, pid int, usename name, state text,
  wait_event_type text, wait_event text, query_start timestamptz, query text
);
create index if not exists act_snap_ts_idx on rca.act_snap (ts);

create or replace function rca.take() returns void language plpgsql as $f$
declare t timestamptz := now();
begin
  insert into rca.stmt_snap
    select t, userid, dbid, queryid, calls, total_exec_time, rows, shared_blks_read
    from extensions.pg_stat_statements where dbid = (select oid from pg_database where datname = current_database());
  insert into rca.stmt_text
    select queryid, left(query, 1000) from extensions.pg_stat_statements
    where dbid = (select oid from pg_database where datname = current_database()) on conflict (queryid) do nothing;
  insert into rca.act_snap
    select t, pid, usename, state, wait_event_type, wait_event, query_start, left(query, 1000)
    from pg_stat_activity where backend_type = 'client backend' and state <> 'idle' and pid <> pg_backend_pid();
  delete from rca.stmt_snap where ts < t - interval '3 hours';
  delete from rca.act_snap where ts < t - interval '3 hours';
end $f$;

-- Difference between the last snapshot at or before now() - win and the latest
-- one. With no snapshot that old (first hour after setup, or after a gap) it
-- returns totals since the last pg_stat_statements reset.
create or replace function rca.top(win interval default interval '1 hour', n int default 10)
returns table (calls bigint, exec_ms numeric, query text)
language sql stable as $f$
  with b as (select max(ts) t from rca.stmt_snap where ts <= now() - win),
       e as (select max(ts) t from rca.stmt_snap),
       s0 as (select * from rca.stmt_snap where ts = (select t from b)),
       s1 as (select * from rca.stmt_snap where ts = (select t from e))
  select s1.calls - coalesce(s0.calls, 0),
         round((s1.total_exec_time - coalesce(s0.total_exec_time, 0))::numeric, 1),
         left(t.query, 200)
  from s1 left join s0 using (userid, dbid, queryid) left join rca.stmt_text t using (queryid)
  order by 2 desc nulls last
  limit n
$f$;

-- Keep it off the Data API roles even if the schema is exposed later.
revoke all on schema rca from public, anon, authenticated;
revoke all on all tables in schema rca from public, anon, authenticated;
revoke all on all functions in schema rca from public, anon, authenticated;

-- Let `supabase db query --read-only` call rca.top() where that role exists.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_read_only_user') then
    grant usage on schema rca to supabase_read_only_user;
    grant select on all tables in schema rca to supabase_read_only_user;
    grant execute on function rca.top(interval, int) to supabase_read_only_user;
  end if;
end $$;

-- Same name updates the existing job, so re-running does not add a second one.
select cron.schedule('rca-snap', '30 seconds', 'select rca.take()');
