-- rls-policy-cost: InitPlan hoisting, index interaction, EXISTS policies,
-- recursive RLS, client-filter conjunction, grant-target semantics.
-- Synthetic fixtures only; schema dropped at the end.
\echo '=== R1 setup'
create schema rls_cost;

create table rls_cost.items (
  id bigint generated always as identity primary key,
  owner uuid not null,
  tag text not null
);
create table rls_cost.threads (topic text primary key, user_id uuid not null);
create table rls_cost.posts (
  id bigint generated always as identity primary key,
  topic text not null,
  body text not null default ''
);

insert into rls_cost.items (owner, tag)
select case when g % 10 < 9 then '11111111-1111-1111-1111-111111111111'::uuid
            else '22222222-2222-2222-2222-222222222222'::uuid end,
       case when g % 20 = 0 then 'public' else 'private' end
from generate_series(1, 100000) g;

insert into rls_cost.threads
select 't' || g, case when g % 10 < 6 then '11111111-1111-1111-1111-111111111111'::uuid
                      else '22222222-2222-2222-2222-222222222222'::uuid end
from generate_series(1, 2000) g;

insert into rls_cost.posts (topic, body)
select 't' || ((g % 10) + 1), 'msg'
from generate_series(1, 300) g;

alter table rls_cost.items enable row level security;
alter table rls_cost.threads enable row level security;
alter table rls_cost.posts enable row level security;

grant usage on schema rls_cost to authenticated, anon;
grant select on rls_cost.items, rls_cost.threads, rls_cost.posts to authenticated, anon;

create sequence rls_cost.uid_calls;
create function rls_cost.f_uid() returns uuid language plpgsql stable as $$
begin
  perform nextval('rls_cost.uid_calls');
  return auth.uid();
end $$;
grant usage, select on sequence rls_cost.uid_calls to authenticated, anon;
grant execute on function rls_cost.f_uid() to authenticated, anon;

\echo '=== A1 bare auth.uid(), UNINDEXED'
create policy p on rls_cost.items for select to authenticated using (owner = auth.uid());
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
explain (analyze, format json) select count(*) from rls_cost.items;
reset role;
drop policy p on rls_cost.items;

\echo '=== A2 (select auth.uid()), UNINDEXED'
create policy p on rls_cost.items for select to authenticated using (owner = (select auth.uid()));
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
explain (analyze, format json) select count(*) from rls_cost.items;
reset role;
drop policy p on rls_cost.items;

\echo '=== A3 function-call count, bare'
select setval('rls_cost.uid_calls', 1, false);
create policy p on rls_cost.items for select to authenticated using (owner = rls_cost.f_uid());
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
select (select count(*) from rls_cost.items) as rows_seen,
       (select last_value from rls_cost.uid_calls) as f_uid_calls;
reset role;
drop policy p on rls_cost.items;

\echo '=== A3 function-call count, wrapped'
select setval('rls_cost.uid_calls', 1, false);
create policy p on rls_cost.items for select to authenticated using (owner = (select rls_cost.f_uid()));
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
select (select count(*) from rls_cost.items) as rows_seen,
       (select last_value from rls_cost.uid_calls) as f_uid_calls;
reset role;
drop policy p on rls_cost.items;

\echo '=== A4 set-equality digest: bare'
create policy p on rls_cost.items for select to authenticated using (owner = auth.uid());
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
select count(*) c, sum(id) s from rls_cost.items;
reset role;
drop policy p on rls_cost.items;

\echo '=== A4 set-equality digest: wrapped'
create policy p on rls_cost.items for select to authenticated using (owner = (select auth.uid()));
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
select count(*) c, sum(id) s from rls_cost.items;
reset role;
drop policy p on rls_cost.items;

\echo '=== B1 add index, bare'
create index items_owner_idx on rls_cost.items(owner);
create policy p on rls_cost.items for select to authenticated using (owner = auth.uid());
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
explain (analyze, format json) select count(*) from rls_cost.items;
reset role;
drop policy p on rls_cost.items;

\echo '=== B1 add index, wrapped'
create policy p on rls_cost.items for select to authenticated using (owner = (select auth.uid()));
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
explain (analyze, format json) select count(*) from rls_cost.items;
reset role;
drop policy p on rls_cost.items;

\echo '=== B2 call count with index, bare vs wrapped'
select setval('rls_cost.uid_calls', 1, false);
create policy p on rls_cost.items for select to authenticated using (owner = rls_cost.f_uid());
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
select (select count(*) from rls_cost.items) as rows_seen, (select last_value from rls_cost.uid_calls) as bare_calls_indexed;
reset role;
drop policy p on rls_cost.items;
select setval('rls_cost.uid_calls', 1, false);
create policy p on rls_cost.items for select to authenticated using (owner = (select rls_cost.f_uid()));
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
select (select count(*) from rls_cost.items) as rows_seen, (select last_value from rls_cost.uid_calls) as wrap_calls_indexed;
reset role;
drop policy p on rls_cost.items;

\echo '=== C1 EXISTS policy plan (joined table RLS: wrapped policy on threads)'
create policy thread_select on rls_cost.threads for select to authenticated
  using (user_id = (select auth.uid()));
create policy posts_exists on rls_cost.posts for select to authenticated
  using (exists (select 1 from rls_cost.threads i
                 where i.topic = posts.topic
                 and i.user_id = auth.uid()));
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
explain (analyze, costs off, format text) select count(*) from rls_cost.posts;
reset role;

\echo '=== C2 recursive RLS matrix: A / B / none / anon'
create temp table c2(who text, entries bigint);
grant all on pg_temp.c2 to public;
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
insert into c2 select 'A-has-threads', count(*) from rls_cost.posts;
reset role;
set role authenticated;
set "request.jwt.claims" = '{"sub":"22222222-2222-2222-2222-222222222222"}';
insert into c2 select 'B-fewer-threads', count(*) from rls_cost.posts;
reset role;
set role authenticated;
set "request.jwt.claims" = '{"sub":"33333333-3333-3333-3333-333333333333"}';
insert into c2 select 'C-no-threads', count(*) from rls_cost.posts;
reset role;
set role anon;
insert into c2 select 'anon', count(*) from rls_cost.posts;
reset role;
select * from c2 order by who;
drop policy posts_exists on rls_cost.posts;

\echo '=== C3 EXISTS call count: bare vs wrapped (inside the subquery)'
select setval('rls_cost.uid_calls', 1, false);
create policy p on rls_cost.posts for select to authenticated
  using (exists (select 1 from rls_cost.threads i
                 where i.topic = posts.topic
                 and i.user_id = rls_cost.f_uid()));
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
select (select count(*) from rls_cost.posts) as entries, (select last_value from rls_cost.uid_calls) as exists_bare_calls;
reset role;
drop policy p on rls_cost.posts;
select setval('rls_cost.uid_calls', 1, false);
create policy p on rls_cost.posts for select to authenticated
  using (exists (select 1 from rls_cost.threads i
                 where i.topic = posts.topic
                 and i.user_id = (select rls_cost.f_uid())));
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
select (select count(*) from rls_cost.posts) as entries, (select last_value from rls_cost.uid_calls) as exists_wrap_calls;
reset role;
drop policy p on rls_cost.posts;

\echo '=== C4 index on joined column'
create index threads_user_idx on rls_cost.threads(user_id);
create policy p on rls_cost.posts for select to authenticated
  using (exists (select 1 from rls_cost.threads i
                 where i.topic = posts.topic
                 and i.user_id = auth.uid()));
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
explain (analyze, costs off, format text) select count(*) from rls_cost.posts;
reset role;
drop policy p on rls_cost.posts;

\echo '=== D1 client-filter conjunction (policy: owner = uid OR tag=public)'
update rls_cost.items set tag='public'
  where owner='22222222-2222-2222-2222-222222222222' and id % 400 = 9;
create policy p on rls_cost.items for select to authenticated
  using (owner = auth.uid() or tag = 'public');
create temp table d(query text, rows bigint);
grant all on pg_temp.d to public;
set role authenticated;
set "request.jwt.claims" = '{"sub":"11111111-1111-1111-1111-111111111111"}';
insert into d select 'A: no client filter', count(*) from rls_cost.items;
insert into d select 'A: filter owner=B (drifted)', count(*) from rls_cost.items
  where owner='22222222-2222-2222-2222-222222222222';
insert into d select 'A: filter owner=B and tag=private', count(*) from rls_cost.items
  where owner='22222222-2222-2222-2222-222222222222' and tag='private';
reset role;
select * from d order by query;
drop policy p on rls_cost.items;

\echo '=== E1 grant target: TO public vs TO authenticated (anon subject)'
create policy p on rls_cost.items for select to public using (tag = 'public');
create temp table e(who text, rows bigint);
grant all on pg_temp.e to public;
set role anon;
insert into e select 'anon, policy TO public', count(*) from rls_cost.items;
reset role;
drop policy p on rls_cost.items;
create policy p on rls_cost.items for select to authenticated using (tag = 'public');
set role anon;
insert into e select 'anon, policy TO authenticated', count(*) from rls_cost.items;
reset role;
select * from e order by who;
drop policy p on rls_cost.items;

\echo '=== R2 cleanup'
drop policy thread_select on rls_cost.threads;
drop schema rls_cost cascade;
\echo '=== done'
