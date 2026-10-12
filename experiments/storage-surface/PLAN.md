# storage-surface - plan for SS03-SS07 (large objects, S3 contract, managed vs self-hosted)

Status: run 2026-10-12 - SS03 to SS05 on one managed Pro project per run
(one full run plus a SS03d and SS03k re-run; four projects created in all) and on four self-hosted variants (file and s3 backends, storage
1.74.0 and 1.80.2), SS06 diff and SS07 read; results in RUNLOG.md
("2026-10-12 - SS03 to SS07"). SS03k and SS03l were added to the battery during
the run. The battery is one module, `SS03`, emitting the SS03, SS04 and SS05
row ids.

SS02 covered object-key handling only, on objects of a few bytes with
one-part multipart uploads (see RUNLOG.md, "Not measured in SS02"). The
questions below are the S3-contract and large-object behaviours an existing
S3 client depends on, plus whether the self-hosted stack gives the same
answers as the managed platform. Every claim under test comes from public
sources: https://supabase.com/docs/guides/storage/s3/compatibility,
https://supabase.com/docs/guides/storage/uploads/resumable-uploads,
https://supabase.com/docs/guides/storage/uploads/file-limits, and the
storage server source at https://github.com/supabase/storage.

## Targets

| role | what | how |
|---|---|---|
| managed | one throwaway Pro-org project, `ss-<tag>-<epoch>`, created and deleted by the module | Management API, as SS01/SS02 |
| sh-file | self-hosted stack, default `STORAGE_BACKEND=file` | self-hosted-defaults rig (`make stack up`), pinned supabase/supabase commit |
| sh-s3 | self-hosted stack with `docker-compose.s3.yml` (MinIO backend) | same rig plus the override |

Managed objects sit behind the Storage CDN (residency-facts: REST and Storage
front Cloudflare), so every read row is taken twice where the path is
cacheable: first read and repeat read, with `cf-cache-status` recorded.

Preconditions: the managed project's global file size limit is raised through
the Management API storage config before upload (the row records the refusal
at the default first); the self-hosted `FILE_SIZE_LIMIT` (52428800 in the
pinned compose file) is raised in the rig's `.env` override.

## Fixtures

- `big`: 2 GiB of seeded random bytes, generated locally, SHA-256 and
  per-16 MiB-part MD5s computed before upload. Used for multipart, TUS,
  and range reads past any CDN object-size cache ceiling.
- `mid`: 64 MiB, same treatment. Used for the header matrices, so a full
  matrix does not move gigabytes.
- `enc`: `mid` encrypted client-side as AES-256-GCM in 4 MiB chunks with a
  fixed nonce schedule; the key never leaves the test process.

## Modules

### SS03 - S3 contract on large objects (AWS SDK v3 + raw SigV4 via `canary/wire.ts`)

| id | question | rows |
|---|---|---|
| SS03a | Multipart upload of `big` (16 MiB parts) | completes; final ETag compared with the AWS convention (MD5 of concatenated part MD5s, `-N` suffix); per-part ETags vs local MD5; `ListParts` mid-upload; `AbortMultipartUpload` frees the upload |
| SS03b | Resume a multipart upload after the client stops | stop after k parts, new client process, `ListMultipartUploads` + `ListParts`, upload the remaining parts, complete; SHA-256 of the GET equals the fixture |
| SS03c | Single-range GET | `bytes=0-1023`, a mid-object range, suffix `bytes=-1024`, open `bytes=N-`, a range past EOF (416 expected), a multi-range header; status, `Content-Range`, `Content-Length`, `Accept-Ranges`, body hash equals the local slice; on `mid` and on `big` |
| SS03d | Range through every read path | S3 GetObject, S3 presigned GET (query SigV4) with a `Range` header, `/object/sign` signed URL, `/object/public`, `/object/authenticated`; direct storage host and gateway host; first and repeat read |
| SS03e | Conditional reads | GET and HEAD with `If-None-Match` (matching: 304?), `If-Match` (mismatch: 412?), `If-Modified-Since`, `If-Unmodified-Since`; same set on the signed and public URLs |
| SS03f | Conditional writes | PutObject with `If-None-Match: *` on an existing key (412 or overwrite?), `If-Match` with a stale ETag; CompleteMultipartUpload with `If-None-Match: *` |
| SS03g | Checksums | PutObject with `ChecksumAlgorithm: SHA256`, correct and deliberately wrong value; UploadPart with per-part SHA-256; HeadObject/GetObject with `ChecksumMode: ENABLED` (is `x-amz-checksum-sha256` returned?); GetObjectAttributes; wrong `Content-MD5`; the SDK's default flexible checksum (CRC32) left on, and with `requestChecksumCalculation: WHEN_REQUIRED` |
| SS03h | CORS | OPTIONS preflight from an arbitrary Origin on the S3 endpoint, a signed URL, a public URL and `/object/authenticated`; `Access-Control-Allow-*`; `Access-Control-Expose-Headers` contains `ETag`, `Content-Range`, `x-amz-checksum-*`? (a browser multipart upload needs `ETag` exposed); `PutBucketCors` / `GetBucketCors` supported or `NotImplemented` |
| SS03i | Error bodies | NoSuchKey, NoSuchBucket, AccessDenied (wrong key), InvalidKey, EntityTooLarge at the default limit, InvalidRange: status, content-type, body shape, on S3 and REST |
| SS03j | Timing (info) | wall time of the `big` upload and download from the one vantage; not a throughput claim |
| SS03k | Large-object integrity through the CDN (added during the run) | a gzip stream of 256 MiB stored with `Content-Encoding: gzip`, and `big`, read whole through every path and host, first and repeat: `Content-Length`, `Content-Encoding`, `cf-cache-status`, bytes received, hash |
| SS03l | SSE headers (added during the run; the compatibility page marks SSE unsupported) | PutObject and CreateMultipartUpload with SSE-C, `AES256` and `aws:kms`; rejected, or accepted and ignored (GET without the SSE-C key); GetBucketEncryption |

### SS04 - TUS resumable upload

| id | question | rows |
|---|---|---|
| SS04a | `big` through `/storage/v1/upload/resumable` with tus-js-client, 6 MiB chunks | completes; SHA-256 of a GET equals the fixture; chunk sizes other than 6 MiB (accepted or refused?) |
| SS04b | Resume | kill the client after n chunks, resume from the stored upload URL in a new process; resume on the other host (direct vs gateway) |
| SS04c | Overlap with S3 | object uploaded by TUS read back by S3 GetObject with `Range`; its ETag form |
| SS04d | Limits | upload URL lifetime as reported in the creation response (24 h per docs is not waited out); behaviour with `x-upsert` absent on an existing key |

### SS05 - client-side encrypted objects

| id | question | rows |
|---|---|---|
| SS05a | Round trip | `enc` uploaded as `application/octet-stream`, chunk-aligned range reads decrypt to the matching plaintext slices |
| SS05b | What the server records | the `storage.objects.metadata` keys and values for `enc` (size, mimetype, eTag, cacheControl); nothing beyond what the client sent |
| SS05c | Features that need plaintext | `/render/image/*` on `enc` (error shape); content-type sniffing on upload without a content type |
| SS05d | Access control still applies | RLS select policy deny/allow on `/object/authenticated` and on S3 with a user JWT session token, negative control included |

### SS06 - the same battery on self-hosted

SS03c-i, SS04a-c and SS05a-c against `sh-file` and `sh-s3`, through the
self-hosted gateway, with the S3 protocol keys from the stack's `.env`.
Output: one diff table, row by row, managed vs `sh-file` vs `sh-s3`, plus
the storage server version on each side (managed from SS01a's version read,
self-hosted from the image tag).

### SS07 - region catalogue and key-management surface (read only, no project)

- SS07a: `GET /v1/projects/available-regions` for the Pro org; list the
  `specific` regions (residency-facts read 17 on 2026-08-20) and note any
  change since.
- SS07b: enumerate the published Management API OpenAPI document for any
  encryption-key or KMS operation (F05's enumeration method). An absence here
  is "no published API surface", not "the platform has no such option".

## Not settled by this plan

- Contractual or certification questions (BAA, ISO 27001, regional
  certifications, SLA terms): documents, not runtime behaviour.
- Throughput from any vantage other than one laptop; regions other than the
  one the managed project is created in.
- Self-hosted on Linux amd64, or behind a gateway other than Envoy.
- Auth and PostgREST error-shape parity between managed and self-hosted:
  candidate follow-up module, not part of this plan (done since as
  client-keyed-objects CK12).

## Cost and cleanup

One Pro-org micro project per run for about an hour (four on 2026-10-12), a few GB of egress; deleted in
`finally`, checked with `make sweep`. Self-hosted runs are local
(`make clean` in self-hosted-defaults removes volumes).
