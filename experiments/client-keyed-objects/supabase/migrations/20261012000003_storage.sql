-- Private bucket for ciphertext, and storage RLS keyed on the tenant id as the
-- first path segment (`<tenant_id>/<asset_id>/data`): a leaked object key does
-- not grant access without a membership.

insert into storage.buckets (id, name, public)
values ('assets', 'assets', false)
on conflict (id) do nothing;

create policy ck_objects_read on storage.objects for select to authenticated
  using (bucket_id = 'assets' and app.my_role(app.key_tenant(name)) is not null);

create policy ck_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'assets' and app.my_role(app.key_tenant(name)) in ('owner', 'editor'));

create policy ck_objects_update on storage.objects for update to authenticated
  using (bucket_id = 'assets' and app.my_role(app.key_tenant(name)) in ('owner', 'editor'))
  with check (bucket_id = 'assets' and app.my_role(app.key_tenant(name)) in ('owner', 'editor'));

create policy ck_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'assets' and app.my_role(app.key_tenant(name)) in ('owner', 'editor'));

notify pgrst, 'reload schema';
