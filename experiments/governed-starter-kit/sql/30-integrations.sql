-- Integration: tell an external system when a purchase request is decided.
--
-- Mechanism: pg_net from an AFTER UPDATE trigger, which is what a Supabase
-- Database Webhook is under the hood
-- (https://supabase.com/docs/guides/database/webhooks). Written by hand rather
-- than through the dashboard's webhook form for three reasons:
--   * the form's trigger (supabase_functions.http_request) takes its headers
--     as trigger arguments, so a shared secret would sit in plain text in
--     pg_trigger; here it is read from Vault at fire time;
--   * the form sends the whole row (record + old_record); here the payload is
--     an explicit list of fields from the decided row only;
--   * the trigger function can swallow its own errors, so a misconfigured
--     integration can never fail the user's decision.
--
-- Why it cannot break the decision (https://supabase.com/docs/guides/database/extensions/pg_net):
-- net.http_post only queues a row; the HTTP request starts after the
-- transaction commits, in a background worker. A down or slow receiver is
-- never seen by the user's transaction, and a rolled-back transaction (an
-- RLS refusal, a rolled-back probe) sends nothing.
--
-- Delivery is at most once: pg_net does not retry and keeps its queue and
-- responses in unlogged tables (6 h retention). Good enough for a
-- notification; for at-least-once, enqueue with Supabase Queues (pgmq) and
-- have a consumer call the receiver (https://supabase.com/docs/guides/queues).
--
-- Configuration lives in Vault, set by `make integrations` (never in this
-- file): webhook_sink_url and webhook_sink_secret. Without both, the trigger
-- logs a warning and the decision goes through un-notified.

create extension if not exists pg_net with schema extensions;

-- pg_net grants USAGE on schema net and EXECUTE on net.http_* to PUBLIC, and
-- its objects belong to supabase_admin, so `postgres` cannot revoke those
-- grants (tried 2026-10-07: the REVOKE is a no-op warning; anon and
-- authenticated still hold EXECUTE on net.http_post). What keeps users off it
-- is that anon and authenticated cannot log in and net is not exposed through
-- the Data API - so do not add a SECURITY DEFINER function that passes user
-- input to net.*, and do not expose the net schema. The same applies to
-- net.http_request_queue, which holds the x-webhook-secret header until the
-- worker sends the request.

-- Receipts recorded by the webhook-sink Edge Function: the receiving side of
-- the demo, in the schema the Data API does not expose. No user role can read
-- or write it; only service_role (the function's secret key), through
-- public.record_webhook_receipt below.
create table if not exists private.webhook_receipts (
  id               bigint generated always as identity primary key,
  event_id         text not null unique,
  request_id       uuid not null,
  status           text not null,
  department       text not null,
  payload          jsonb not null,
  deliveries       int not null default 1,
  forwarded        text not null default 'not configured',
  received_at      timestamptz not null default now(),
  last_received_at timestamptz not null default now()
);
create index if not exists webhook_receipts_request_id_idx on private.webhook_receipts (request_id);
alter table private.webhook_receipts enable row level security;
revoke all on private.webhook_receipts from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update on private.webhook_receipts to service_role;

-- The sink's only write path. SECURITY INVOKER: it works because the caller
-- is service_role, and EXECUTE is granted to nobody else. Idempotent on
-- event_id: a redelivery bumps `deliveries` instead of adding a row.
create or replace function public.record_webhook_receipt(p_payload jsonb, p_forwarded text default 'not configured')
returns table (id bigint, deliveries int)
language sql security invoker set search_path = '' as $$
  insert into private.webhook_receipts as w (event_id, request_id, status, department, payload, forwarded)
  values (
    p_payload ->> 'event_id',
    (p_payload ->> 'request_id')::uuid,
    p_payload ->> 'status',
    p_payload ->> 'department',
    p_payload,
    p_forwarded
  )
  on conflict (event_id) do update
    set deliveries = w.deliveries + 1, last_received_at = now()
  returning w.id, w.deliveries
$$;
revoke execute on function public.record_webhook_receipt(jsonb, text) from public, anon, authenticated;
grant execute on function public.record_webhook_receipt(jsonb, text) to service_role;

create or replace function public.note_webhook_forward(p_id bigint, p_forwarded text)
returns void
language sql security invoker set search_path = '' as $$
  update private.webhook_receipts set forwarded = p_forwarded where id = p_id
$$;
revoke execute on function public.note_webhook_forward(bigint, text) from public, anon, authenticated;
grant execute on function public.note_webhook_forward(bigint, text) to service_role;

-- The sender. Fires once per decision (pending -> approved/rejected), after
-- RLS and the decide policy have already allowed the update. SECURITY
-- DEFINER so it can read Vault and call pg_net without granting either to
-- users; it reads only the decided row and that row's own department and
-- decider, so the payload cannot carry another department's data.
create or replace function private.notify_purchase_decision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_url    text;
  v_secret text;
  v_dept   text;
  v_by     text;
begin
  begin
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'webhook_sink_url';
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'webhook_sink_secret';
    if v_url is null or v_secret is null then
      raise warning 'purchase decision % not sent: webhook_sink_url / webhook_sink_secret not in vault', new.id;
      return null;
    end if;
    select d.name into v_dept from public.departments d where d.id = new.department_id;
    select p.display_name into v_by from public.profiles p where p.id = new.decided_by;
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
      body := jsonb_build_object(
        'event', 'purchase_request.decided',
        'event_id', new.id::text || ':' || new.status,
        'request_id', new.id,
        'status', new.status,
        'item', new.item,
        'vendor', new.vendor,
        'amount', new.amount,
        'department', v_dept,
        'decided_by', new.decided_by,
        'decided_by_name', v_by,
        'decided_at', new.decided_at,
        'decision_note', new.decision_note
      ),
      timeout_milliseconds := 5000
    );
  exception when others then
    -- Never fail the user's decision because the integration is broken.
    raise warning 'purchase decision % not sent: %', new.id, sqlerrm;
  end;
  return null;
end
$$;
revoke execute on function private.notify_purchase_decision() from public, anon, authenticated;

drop trigger if exists on_purchase_request_decided on public.purchase_requests;
create trigger on_purchase_request_decided
  after update of status on public.purchase_requests
  for each row
  when (old.status = 'pending' and new.status in ('approved', 'rejected'))
  execute function private.notify_purchase_decision();

-- Used by `make integrations` to store the receiver's URL and shared secret
-- without either value appearing in a tracked file. postgres only.
create or replace function private.put_integration_secret(p_name text, p_value text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  select s.id into v_id from vault.secrets s where s.name = p_name;
  if v_id is null then
    perform vault.create_secret(p_value, p_name);
  else
    perform vault.update_secret(v_id, p_value);
  end if;
end
$$;
revoke execute on function private.put_integration_secret(text, text) from public, anon, authenticated;
