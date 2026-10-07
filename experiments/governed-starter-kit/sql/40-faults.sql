-- Observability faults for the troubleshooting segment (docs/OBSERVABILITY.md).
-- Applied ONLY by `make fault-inject` (scripts/faults.ts) to the ready project
-- and removed by `make fault-clear`. Never part of `make schema`.
--
-- Everything here lives in objects of its own - one table, one function - so
-- the example app, the in-app agent and the K01/K02 tests do not depend on it.
-- The script splits this file on the `-- fault:` markers and applies one
-- section per fault.

-- fault: slow-activity
-- An activity feed for the dashboard: 100,000 events, read
-- newest-first. Two mistakes, both common in generated code:
--   * the select policy calls auth.uid() and the private helpers bare, so
--     Postgres evaluates them once per row instead of once per statement
--     (performance advisor: auth_rls_initplan);
--   * no index on the foreign keys or on created_at, so every read is a
--     sequential scan plus a sort (performance advisor: unindexed_foreign_keys).
create table public.activity_events (
  id            bigint generated always as identity primary key,
  department_id uuid not null references public.departments (id),
  actor_id      uuid not null references public.profiles (id),
  kind          text not null,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

alter table public.activity_events enable row level security;
revoke all on public.activity_events from anon, authenticated;
grant select on public.activity_events to authenticated;

create policy "activity: own or manager of department" on public.activity_events
  for select to authenticated
  using (
    actor_id = auth.uid()
    or (private.is_manager() and department_id = private.my_department())
  );

insert into public.activity_events (department_id, actor_id, kind, detail, created_at)
select p.deps[1 + g % p.n], p.ids[1 + g % p.n],
       (array['request.viewed', 'request.created', 'comment.added', 'kb.searched'])[1 + (g / 7) % 4],
       jsonb_build_object('n', g),
       now() - (g * 37 % 15552000) * interval '1 second'
  from generate_series(1, 100000) g,
       (select array_agg(id order by id) as ids, array_agg(department_id order by id) as deps,
               count(*)::int as n
          from public.profiles) p
 where p.n > 0;

analyze public.activity_events;

-- fault: summary-error
-- The approval-rate widget. Divides by the number of decisions in the last
-- seven days, which is zero for any department without recent decisions, so
-- every call fails with 22012 division_by_zero (PostgREST answers 400).
create function public.activity_summary()
returns table (department text, requests bigint, decisions bigint, approval_rate numeric)
language sql stable security invoker set search_path = '' as $$
  select d.name,
         count(*) filter (where e.kind = 'request.created'),
         count(*) filter (where e.kind = 'request.decided' and e.created_at > now() - interval '7 days'),
         round(100.0 * count(*) filter (where e.kind = 'request.approved')
               / count(*) filter (where e.kind = 'request.decided' and e.created_at > now() - interval '7 days'), 1)
    from public.departments d
    join public.activity_events e on e.department_id = d.id
   where d.id = (select private.my_department())
   group by d.name
$$;

revoke execute on function public.activity_summary() from public, anon;
grant execute on function public.activity_summary() to authenticated;
