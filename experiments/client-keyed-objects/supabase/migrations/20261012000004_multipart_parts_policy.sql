-- Resume of an S3 multipart upload needs ListParts, and the Storage server
-- runs ListParts as the caller's role (UploadPart writes the part row as the
-- storage superuser). storage.s3_multipart_uploads_parts has RLS enabled and
-- a SELECT grant to authenticated but no policy, so a user-session ListParts
-- returns no parts and the client re-sends everything (first onprem run,
-- CK04: 0 of 32 parts kept). Sources: supabase/storage
-- migrations/tenant/0021-s3-multipart-uploads.sql and
-- src/storage/protocols/s3/s3-handler.ts (listParts).
--
-- Writers of the tenant may list the parts of uploads under its prefix.

create policy ck_multipart_parts_read on storage.s3_multipart_uploads_parts for select to authenticated
  using (bucket_id = 'assets' and app.my_role(app.key_tenant(key)) in ('owner', 'editor'));
