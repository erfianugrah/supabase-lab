-- ZK schema on a managed project, applied as postgres after EQL is installed.
-- Encrypted columns live in public because encryptedSupabase introspects public.

create table public.records (
  id bigint generated always as identity primary key,
  owner uuid not null default auth.uid(),
  subject public.eql_v3_text_eq,      -- equality only
  label public.eql_v3_text_ord,       -- equality, order, range (OPE)
  score public.eql_v3_integer_ord,    -- equality, order, range (OPE)
  seen public.eql_v3_date_ord,        -- equality, order, range (OPE)
  wrapped_dek public.eql_v3_text,     -- storage only
  note text                           -- plaintext
);
create index records_subject_eq on public.records using btree (eql_v3.eq_term(subject));
create index records_label_ord on public.records using btree (eql_v3.ord_term(label));
create index records_score_ord on public.records using btree (eql_v3.ord_term(score));
create index records_seen_ord on public.records using btree (eql_v3.ord_term(seen));

-- latency tables: one encrypted, one plaintext control
create table public.lat (
  id bigint generated always as identity primary key,
  owner uuid not null default auth.uid(),
  subject public.eql_v3_text_eq,
  note text
);
create index lat_subject_eq on public.lat using btree (eql_v3.eq_term(subject));
create table public.lat_plain (
  id bigint generated always as identity primary key,
  owner uuid not null default auth.uid(),
  subject text,
  note text
);
create index lat_plain_subject on public.lat_plain (subject);

do $$
declare t text;
begin
  foreach t in array array['records', 'lat', 'lat_plain'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy own_select on public.%I for select to authenticated using (owner = auth.uid())', t);
    execute format('create policy own_insert on public.%I for insert to authenticated with check (owner = auth.uid())', t);
    execute format('create policy own_update on public.%I for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid())', t);
    execute format('create policy own_delete on public.%I for delete to authenticated using (owner = auth.uid())', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- The EQL grants (the installer issues none; the plaintext-read failure in
-- CE02 is what happens without them). Same set stash init documents for the
-- three Supabase roles.
grant usage on schema eql_v3, eql_v3_internal to anon, authenticated, service_role;
grant execute on all functions in schema eql_v3 to anon, authenticated, service_role;
grant execute on all functions in schema eql_v3_internal to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;

notify pgrst, 'reload schema';
