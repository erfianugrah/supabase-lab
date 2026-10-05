-- Example app on the kit: purchase requests. Employees submit, managers of the
-- same department approve or reject. This is what a coding agent is asked to
-- build on the live project; the ready project gets it pre-applied.
--
-- Everything runs as the calling user (SECURITY INVOKER), so the rules live in
-- grants and policies and the advisors have nothing to flag.

create table if not exists public.purchase_requests (
  id            uuid primary key default gen_random_uuid(),
  department_id uuid not null default private.my_department() references public.departments (id),
  requester_id  uuid not null default auth.uid() references public.profiles (id),
  item          text not null,
  vendor        text not null,
  amount        numeric(12, 2) not null check (amount >= 0),
  justification text not null,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by    uuid references public.profiles (id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now()
);
create index if not exists purchase_requests_department_id_idx on public.purchase_requests (department_id);
create index if not exists purchase_requests_requester_id_idx on public.purchase_requests (requester_id);
create index if not exists purchase_requests_decided_by_idx on public.purchase_requests (decided_by);

alter table public.purchase_requests enable row level security;

-- Insert only the request fields; department, requester and status come from
-- defaults. Update only the decision fields, and only through the policy below.
revoke all on public.purchase_requests from anon, authenticated;
grant select on public.purchase_requests to authenticated;
grant insert (item, vendor, amount, justification) on public.purchase_requests to authenticated;
grant update (status, decided_by, decided_at, decision_note) on public.purchase_requests to authenticated;

drop policy if exists "requests: read department" on public.purchase_requests;
create policy "requests: read department" on public.purchase_requests
  for select to authenticated
  using (department_id = (select private.my_department()));

drop policy if exists "requests: submit own" on public.purchase_requests;
create policy "requests: submit own" on public.purchase_requests
  for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and department_id = (select private.my_department())
    and status = 'pending'
  );

-- Managers decide pending requests in their own department, never their own.
drop policy if exists "requests: manager decides" on public.purchase_requests;
create policy "requests: manager decides" on public.purchase_requests
  for update to authenticated
  using (
    (select private.is_manager())
    and department_id = (select private.my_department())
    and requester_id <> (select auth.uid())
    and status = 'pending'
  )
  with check (
    department_id = (select private.my_department())
    and status in ('approved', 'rejected')
    and decided_by = (select auth.uid())
  );

-- The one write path the UI and the agent use for decisions. Zero rows
-- updated means RLS said no (or the request is not pending): report it as an
-- error rather than a silent success.
create or replace function public.decide_purchase_request(request_id uuid, decision text, note text default null)
returns public.purchase_requests
language plpgsql security invoker set search_path = '' as $$
declare
  r public.purchase_requests;
begin
  if decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected';
  end if;
  update public.purchase_requests
     set status = decision, decided_by = auth.uid(), decided_at = now(), decision_note = note
   where id = request_id
  returning * into r;
  if r.id is null then
    raise exception 'not permitted or not found';
  end if;
  return r;
end
$$;

revoke execute on function public.decide_purchase_request(uuid, text, text) from public, anon;
grant execute on function public.decide_purchase_request(uuid, text, text) to authenticated;
