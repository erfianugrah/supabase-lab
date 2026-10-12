# client-keyed-objects RUNLOG

Chronological record of what was run. Org slugs and project refs are not
recorded; the org class is (a Pro-plan organization). Published artifacts
(refs, hostnames and emails redacted) are in `out/2026-10-12/`; file names
below are those artifacts' names, and each cell cites a module id. Values in
tables are pasted from `pvlab --facts` on those artifacts or from
`out/2026-10-12/parity.md` (generated from them by `scripts/parity.ts`).
"Not measured" means no artifact holds the value.

Public sources for the behaviour under test:
https://supabase.com/docs/guides/storage/s3/authentication,
https://supabase.com/docs/guides/storage/uploads/resumable-uploads,
https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook,
https://docs.postgrest.org/en/v14/references/auth.html, and the Storage
server source at https://github.com/supabase/storage.

## 2026-10-12 - shape

| target | what | live versions (CK13) |
|---|---|---|
| onprem | supabase/supabase `docker/` at commit 8617532ae1a41571d5d557cd24c6f5f2565d9230 (the self-hosted-defaults pin), own compose project, host ports 8100 / 5532 / 6643, MinIO backend, Storage image raised to the version managed reported on 2026-10-10 | auth v2.196.0, rest 14.17, storage 1.80.2, postgres 17.6 |
| onprem-file | the same stack, file backend on a named Docker volume | same |
| region-a | managed Pro-org micro project, ap-southeast-1 | auth v2.197.0, rest 14.18, storage 1.80.2, postgres 17.11 |
| region-b | managed Pro-org micro project, eu-central-1 | auth v2.197.0, rest 14.18, storage 1.80.2, postgres 17.11 |

Every target: the same four migrations, ES256 access tokens with a 300 s
lifetime and the custom access token hook (CK02 `b_token_alg`,
`b_token_lifetime_s`), the same client build. Vantage: one laptop in
Singapore on Docker Desktop for Mac, n = 1 per target.

Runs, by artifact (all in `out/2026-10-12/`):

| artifact | target | role in this record |
|---|---|---|
| `run-2026-10-12T08-20-58-489Z` | onprem | first full run, three migrations (no multipart-parts policy); evidence for the ListParts and SigV4-host findings |
| `run-2026-10-12T08-36-46-437Z` | onprem-file (upstream bind mount) | evidence for the xattr finding |
| `run-2026-10-12T09-01-25-864Z` | onprem | first green run (11 pass, CK10 skipped); 400-read CK06, Node-stack TUS |
| `run-2026-10-12T09-11-46-574Z` | onprem-file (named volume) | first file-backend run |
| `run-2026-10-12T11-08-42-196Z`, `run-2026-10-12T11-21-36-610Z`, `run-2026-10-12T11-41-36-733Z` | onprem | client re-runs during the fixes below (fetch TUS stack, request timeouts, refresh race); `11-41-36` shows `refresh_token_already_used` |
| `run-2026-10-12T12-23-10-648Z` | onprem | final onprem run, final client: 11 pass, CK10 skipped |
| `run-2026-10-12T12-51-56-401Z` | onprem-file | final file run (CK01-CK03, CK07-CK09, CK11-CK13) |
| `run-2026-10-12T13-09-42-172Z` | onprem-file | CK01 and CK02 again (CK02 had failed in the run above, see operator notes) |
| `run-2026-10-12T12-22-19-017Z` | region-a, region-b | final managed run, CK01-CK13: 21 pass, 1 fail, 1 skip |

## Parity table

From `out/2026-10-12/parity.md` (sources: the managed run, the final onprem
run, the final onprem-file run and its CK02 re-run; a later artifact's row
supersedes an earlier one for the same target).

| assertion | onprem | onprem-file | region-a | region-b |
|---|---|---|---|---|
| CK01 catalogue after migrations | pass (de77a73c2298ee14) | pass (de77a73c2298ee14) | pass (de77a73c2298ee14) | pass (de77a73c2298ee14) |
| CK02 auth flows, hook claim | pass (alg ES256) | pass (alg ES256) | pass (alg ES256) | pass (alg ES256) |
| CK03 RLS matrix (catalogue + objects) | pass | pass | pass | pass |
| CK04 2 GiB S3 multipart, kill, resume, verify | pass (killed at 0.4063, 13 parts kept) | not measured | pass (killed at 0.4063, 13 parts kept) | fail (killed at 0.4063, ? parts kept) |
| CK05 2 GiB TUS, kill, resume, verify | pass (killed at 0.4014, offset 861929472) | not measured | pass (killed at 0.4014, offset 861929472) | pass (killed at 0.4014, offset 861929472) |
| CK06 100 ranged reads across 4 paths | pass | not measured | pass | skip |
| CK07 tamper fails closed | pass | pass | pass | pass |
| CK08 ciphertext only | pass | pass | pass | pass |
| CK09 key service down | pass | pass | pass | pass |
| CK10 region isolation | skip | not measured | pass | pass |
| CK11 browser | pass (ETags via upload-part-header) | pass (ETags via upload-part-header) | pass (ETags via upload-part-header) | pass (ETags via upload-part-header) |
| CK12 error shapes (recorded) | info | info | info | info |
| CK13 versions (recorded) | info (storage 1.80.2) | info (storage 1.80.2) | info (storage 1.80.2) | info (storage 1.80.2) |
| CK01 no target branch in client/migrations (once per run) | pass, 4 runs: pass/pass/pass/pass |

Partial and not-measured cells, with the reason:

| cell | reason |
|---|---|
| CK04 region-b fail | the resume process ended with `data api unreachable: The operation timed out.` after `resume_process_ms` 300412; it overlapped a stretch where the laptop entered maintenance sleep every few minutes (operator notes). Not re-run (time box). A platform cause is not excluded and not shown |
| CK06 region-b skip | depends on CK04's asset (`no 2 GiB asset from CK04 on this target`) |
| CK04-CK06 onprem-file not measured | the file backend's named volume lives on the Docker VM disk, which had about 4 GB free; two 2 GiB objects would have filled it and the stack running beside this one |
| CK10 onprem / onprem-file | needs two regions in one run; the self-hosted runs have one |
| CK12, CK13 | recorded (`info`), compared below |

### Differences between managed and self-hosted (CK12), with the version gap

Cell: `status media-type body-keys code`; identical rows omitted (14 of 22
requests matched on all four targets).

| request | onprem / onprem-file | region-a / region-b | version gap | attribution |
|---|---|---|---|---|
| auth.user_no_bearer | `403 application/json code,error_code,msg bad_jwt` | `401 application/json code,error_code,msg no_authorization` | auth v2.196.0 vs v2.197.0 | not separated: Auth version or the gateway in front of it |
| rest.no_apikey | `401 text/plain text Unauthorized` | `401 application/json hint,message` | rest 14.17 vs 14.18 | the gateway answers (Envoy's own 401 on self-hosted; self-hosted-defaults SD02), not PostgREST |
| storage.no_auth | `400 ... NoSuchKey` | `400 ... InvalidRequest` | storage 1.80.2 on both (no gap) | configuration or gateway, not the Storage version |
| s3.no_such_key, s3.no_such_bucket, s3.bad_signature, s3.range_past_eof, s3.put_rls_denied | `application/xml` | `text/plain` with the same XML body elements and codes | storage 1.80.2 on both (no gap) | the managed edge sets the media type; body and code match |

`s3.no_such_bucket` answers `NoSuchKey` (not `NoSuchBucket`) on every target.
CK02's refusal shapes (wrong password `invalid_credentials`, disabled user
`user_banned`, expired token Auth `403 ... bad_jwt` and Data API
`401 ... PGRST303`) were identical on all four targets.

### Version gap (CK13)

| service | self-hosted (pinned tag, live) | managed (live) |
|---|---|---|
| Auth | `supabase/gotrue:v2.196.0`, v2.196.0 | v2.197.0 |
| PostgREST | `postgrest/postgrest:v14.17`, 14.17 | 14.18 |
| Storage | `public.ecr.aws/supabase/storage-api:v1.80.2`, 1.80.2 (the pinned compose file names v1.74.0; raised by this experiment's override) | 1.80.2 |
| Postgres | `supabase/postgres:17.6.1.136`, 17.6 | 17.11 |

## Findings

| finding | measured | module |
|---|---|---|
| The four migrations leave the same catalogue on every target: 22 policies, 6 functions, 4 triggers, 6 tables, the same grants, the hook executable by `supabase_auth_admin` only | catalogue fingerprint `de77a73c2298ee14` on onprem, onprem-file, region-a and region-b | CK01 |
| No branch on target identity in the client or the migrations | 15 files scanned, 0 hits | CK01-code |
| Resume of an S3 multipart upload with a user session token re-sent every part until a SELECT policy existed on `storage.s3_multipart_uploads_parts` | first onprem run: `parts_skipped` 0 of 32 (bytes and SHA-256 still right, so a content check alone passes a resume that is not one); with migration 0004: `parts_skipped` 13, `resumed_etag_matches` 13 on onprem and region-a | CK04 |
| Cause (source read, not measured): UploadPart writes the part row as the storage superuser; ListParts reads that table as the caller's role; RLS is on, `authenticated` has SELECT, no policy ships (`migrations/tenant/0021-s3-multipart-uploads.sql`, `listParts` in `src/storage/protocols/s3/s3-handler.ts`). `supabase db push` created the policy on managed as `postgres` | - | CK01 |
| The S3 part ETag is the MD5 of the part on MinIO and on managed | `resumed_etag_matches` 13, `resumed_etag_mismatches` 0 | CK04 |
| PostgREST accepts an expired access token for a short window, Auth does not; same on every target | at exp + 5 s: Auth 403, Data API 200 (`f5_*`); at exp + 45 s both refuse. PostgREST documents a 30-second clock skew allowance | CK02 |
| Region isolation holds both ways | a region-a token on region-b: Auth `403 bad_jwt`, Data API `401 PGRST301`, Storage REST `400 AccessDenied`, S3 `403 AccessDenied`, object `404 NotFound`; key service `401 invalid_token` for the other region's token; the same in reverse | CK10 |
| Tamper fails closed with both layers | flip and swap: `ChunkHashMismatch` with the catalogue hash, `ChunkAuthFailed` with AES-GCM alone; truncate: `TruncatedObject`; restored copy reads `ok`; all four targets | CK07 |
| Ciphertext only | marker hits outside the positive control: 0 (API scan, all targets; full-read scan of the 2 GiB objects); MinIO / file backend scan: only the control's file; DEK and KEK (hex and base64) found in 0 of 39 (self-hosted) / 41 (managed) readable tables while `wrapped_dek` is found in `app.assets` | CK08 |
| What Storage records for an encrypted object | `storage.objects.metadata` keys `cacheControl,contentLength,eTag,httpStatusCode,lastModified,mimetype,size`, `mimetype` `application/octet-stream`, `cacheControl` `no-cache`, `user_metadata` `{}`; identical on all targets | CK08 |
| Key service down | upload and read `KeyServiceUnavailable`; asset, chunk and object counts and the ETag unchanged; read `ok` after restart; all targets | CK09 |
| Browser: the page uploads and reads on every target; managed exposes no response headers on a ranged signed-URL GET | managed `signed_get_readable_headers` `content-length,content-type`, self-hosted `content-range,etag,content-length,content-type`; part ETags readable from UploadPart on all targets (`upload_etag_source` `upload-part-header`), so the ListParts fallback was not needed. Matches storage-surface SS03h | CK11 |
| Ranged reads honour Range on all four paths: every body was exactly the covering chunks | 25 of 25 per path on onprem and region-a | CK06 |
| On region-a, reads through fresh signed URLs were slow; `/object/authenticated` was served from the CDN after one miss | signed-url `cf_cache_status` `MISS:25`, `info_ms_p50` 30479; authenticated `MISS:1 HIT:24`, `info_ms_p50` 548; S3 GetObject 419 (one vantage, n = 1 run). Inference, not shown: each signed URL is its own cache key (residency-facts), and each miss waits on the origin (object size alone does not explain 30 s: storage-surface run 4 answered a cold 1 KiB signed-URL range of a 2 GiB object in 272 ms) | CK06 |
| Self-hosted Storage signs S3 requests against the host of `STORAGE_PUBLIC_URL` | first onprem run: the page reached the stack under another host name and CreateMultipartUpload got `SignatureDoesNotMatch`; with the same URL as every other client: ok. Source: `getHostHeader` in `src/storage/protocols/s3/signature-v4.ts` | CK11 |
| The upstream file backend (`./volumes/storage` bind mount) fails every upload on Docker Desktop for Mac | REST upload `500 ... "The file system does not support extended attributes or has the feature d...`, S3 UploadPart and TUS create `500`; the file backend keeps metadata in xattrs (`fs-xattr` in the v1.74.0 and v1.80.2 images, source read). On a named volume every module passed | CK03-CK05 `08-36-46-437Z`; `12-51-56-401Z` |
| PostgREST 14.17 (self-hosted) refused a just-issued token with `401 PGRST303 JWT issued at future`; the client now retries once after 2 s and counts it | `iat_future_retries` 1 in CK05 and 1 in CK06 of the final onprem run, 0 on managed | CK05, CK06 |

Transfer and timing (single vantage, n = 1, not throughput claims; from
`parity.md`):

| measurement | onprem | region-a | region-b |
|---|---|---|---|
| CK04 upload MiB/s (2 GiB, kill and resume) | 133.2 | 13 | not measured |
| CK04 full read MiB/s | 161.8 | 43.9 | not measured |
| CK05 upload MiB/s | 33.9 | 10.2 | 6.4 |
| CK05 full read MiB/s | 123.1 | 36.9 | 23.3 |
| CK06 plaintext bytes asked (100 ranges) | 499413339 | 499413339 | not measured |

### Client-side lessons (this application's code, not platform behaviour)

- tus-js-client's Node HTTP stack under Bun stalled twice (Buffer body:
  server `408 stream timeout`; Readable body: one PATCH to region-b hung with
  no bytes moving). `client/src/tus-fetch.ts` replaces it with fetch and a
  120 s per-request timeout.
- Parallel calls (a ranged read fetches ciphertext and chunk hashes at once)
  refreshed the same session twice; Auth answered the second with
  `400 refresh_token_already_used` and later calls carried an expired token
  (`11-41-36-733Z`). The session refresh is single-flight now.
- Bun's fetch reused pooled keep-alive connections the far side had closed
  (`The socket connection was closed unexpectedly`); Auth grants and the
  harness HTTP helper retry on that network error.

## Operator notes

These are the operator's account; no artifact backs them.

- The first managed attempt (projects created 09:06Z) ran under a
  background-job time limit that killed the make process after two hours,
  before the harness wrote an artifact; a second attempt on the same
  projects was stopped by hand after CK04 failed on dead sockets. Both
  attempts' data was deleted from the projects before the final run.
- The laptop entered maintenance sleep every few minutes until about 13:08Z
  (pmset log). Docker Desktop's VM clock fell about 260 s behind the host
  meanwhile, which made the host-side token arithmetic refresh on every call
  (the refresh race above) and let an expired token pass on onprem-file
  (CK02 in `12-51-56-401Z`; passed in `13-09-42-172Z` after the clock
  resynced). Long runs now go under `caffeinate`.
- The Docker VM disk was 95 % full from other work; MinIO data was moved to a
  bind mount on the host disk and 2.4 GB of unused build cache was pruned.
- PostgREST stays unhealthy after `compose up` until the migrations create the
  exposed `app` schema; setup waits for the Data API.

## Cleanup

- Managed: both projects deleted 13:41:33Z (HTTP 200 each); the last suite
  request finished 13:41:14Z. `make sweep` and a direct `GET /v1/projects`
  at 13:41:45Z: no `ck-` or `ss-` projects.
- Key service containers removed and the per-run KEKs deleted; no Playwright
  containers left; self-hosted stacks taken down with their volumes;
  `work/fixtures` deleted.
