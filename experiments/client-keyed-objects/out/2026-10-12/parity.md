# client-keyed-objects - parity table

Sources: run-2026-10-12T12-22-19-017Z.json (started 2026-10-12T12:22:19.017Z); run-2026-10-12T12-23-10-648Z.json (started 2026-10-12T12:23:10.648Z); run-2026-10-12T12-51-56-401Z.json (started 2026-10-12T12:51:56.401Z); run-2026-10-12T13-09-42-172Z.json (started 2026-10-12T13:09:42.172Z).

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

## Versions (CK13)

| service | onprem | onprem-file | region-a | region-b |
|---|---|---|---|---|
| auth (live) | v2.196.0 | v2.196.0 | v2.197.0 | v2.197.0 |
| rest (live) | 14.17 | 14.17 | 14.18 | 14.18 |
| storage (live) | 1.80.2 | 1.80.2 | 1.80.2 | 1.80.2 |
| postgres (live) | 17.6 | 17.6 | 17.11 | 17.11 |
| auth (image tag) | supabase/gotrue:v2.196.0 | supabase/gotrue:v2.196.0 | - | - |
| rest (image tag) | postgrest/postgrest:v14.17 | postgrest/postgrest:v14.17 | - | - |
| storage (image tag) | public.ecr.aws/supabase/storage-api:v1.80.2 | public.ecr.aws/supabase/storage-api:v1.80.2 | - | - |
| postgres (image tag) | supabase/postgres:17.6.1.136 | supabase/postgres:17.6.1.136 | - | - |

## Error shapes that differ (CK12), with the version gap

Cell: `status media-type body-keys code`.

| request | onprem | onprem-file | region-a | region-b | version gap |
|---|---|---|---|---|---|
| auth.user_no_bearer | 403 application/json code,error_code,msg bad_jwt | 403 application/json code,error_code,msg bad_jwt | 401 application/json code,error_code,msg no_authorization | 401 application/json code,error_code,msg no_authorization | auth: onprem v2.196.0 / onprem-file v2.196.0 / region-a v2.197.0 / region-b v2.197.0 |
| rest.no_apikey | 401 text/plain text Unauthorized | 401 text/plain text Unauthorized | 401 application/json hint,message | 401 application/json hint,message | rest: onprem 14.17 / onprem-file 14.17 / region-a 14.18 / region-b 14.18 |
| storage.no_auth | 400 application/json code,error,message,statusCode NoSuchKey | 400 application/json code,error,message,statusCode NoSuchKey | 400 application/json code,error,message,statusCode InvalidRequest | 400 application/json code,error,message,statusCode InvalidRequest | storage: onprem 1.80.2 / onprem-file 1.80.2 / region-a 1.80.2 / region-b 1.80.2 |
| s3.no_such_key | 404 application/xml xml:Resource,Code,Message NoSuchKey | 404 application/xml xml:Resource,Code,Message NoSuchKey | 404 text/plain xml:Resource,Code,Message NoSuchKey | 404 text/plain xml:Resource,Code,Message NoSuchKey | storage: onprem 1.80.2 / onprem-file 1.80.2 / region-a 1.80.2 / region-b 1.80.2 |
| s3.no_such_bucket | 404 application/xml xml:Resource,Code,Message NoSuchKey | 404 application/xml xml:Resource,Code,Message NoSuchKey | 404 text/plain xml:Resource,Code,Message NoSuchKey | 404 text/plain xml:Resource,Code,Message NoSuchKey | storage: onprem 1.80.2 / onprem-file 1.80.2 / region-a 1.80.2 / region-b 1.80.2 |
| s3.bad_signature | 403 application/xml xml:Resource,Code,Message SignatureDoesNotMatch | 403 application/xml xml:Resource,Code,Message SignatureDoesNotMatch | 403 text/plain xml:Resource,Code,Message SignatureDoesNotMatch | 403 text/plain xml:Resource,Code,Message SignatureDoesNotMatch | storage: onprem 1.80.2 / onprem-file 1.80.2 / region-a 1.80.2 / region-b 1.80.2 |
| s3.range_past_eof | 416 application/xml xml:Resource,Code,Message InvalidRange | 416 application/xml xml:Resource,Code,Message InvalidRange | 416 text/plain xml:Resource,Code,Message InvalidRange | 416 text/plain xml:Resource,Code,Message InvalidRange | storage: onprem 1.80.2 / onprem-file 1.80.2 / region-a 1.80.2 / region-b 1.80.2 |
| s3.put_rls_denied | 403 application/xml xml:Resource,Code,Message AccessDenied | 403 application/xml xml:Resource,Code,Message AccessDenied | 403 text/plain xml:Resource,Code,Message AccessDenied | 403 text/plain xml:Resource,Code,Message AccessDenied | storage: onprem 1.80.2 / onprem-file 1.80.2 / region-a 1.80.2 / region-b 1.80.2 |

## Auth refusal shapes and claims that differ (CK02)

| field | onprem | onprem-file | region-a | region-b | version gap |
|---|---|---|---|---|---|
| (none) |  |  |  |  | |

## Transfer and timing (info: one laptop vantage, n = 1 per target; not throughput claims)

| measurement | onprem | onprem-file | region-a | region-b |
|---|---|---|---|---|
| CK04 info_upload_wall_s | 15.4 | - | 157 | - |
| CK04 info_upload_mib_per_s | 133.2 | - | 13 | - |
| CK04 info_read_mib_per_s | 161.8 | - | 43.9 | - |
| CK04 read_all_transferred | 2147487744 | - | 2147487744 | - |
| CK04 read_all_ciphertext_marker_hits | 0 | - | 0 | - |
| CK05 read_all_ciphertext_marker_hits | 0 | - | 0 | 0 |
| CK05 info_upload_wall_s | 60.5 | - | 201.8 | 321.6 |
| CK05 info_upload_mib_per_s | 33.9 | - | 10.2 | 6.4 |
| CK05 info_read_mib_per_s | 123.1 | - | 36.9 | 23.3 |
| CK06 s3.info_ms_p50 | 181 | - | 419 | - |
| CK06 s3.info_ms_p95 | 361 | - | 1472 | - |
| CK06 s3.body_bytes_total | 369099456 | - | 369099456 | - |
| CK06 s3.covering_chunk_bytes_total | 369099456 | - | 369099456 | - |
| CK06 s3.cf_cache_status | - | - | - | - |
| CK06 s3-presigned.info_ms_p50 | 182 | - | 385 | - |
| CK06 s3-presigned.info_ms_p95 | 301 | - | 946 | - |
| CK06 s3-presigned.body_bytes_total | 343933584 | - | 343933584 | - |
| CK06 s3-presigned.covering_chunk_bytes_total | 343933584 | - | 343933584 | - |
| CK06 s3-presigned.cf_cache_status | - | - | DYNAMIC:25 | - |
| CK06 signed-url.info_ms_p50 | 109 | - | 30479 | - |
| CK06 signed-url.info_ms_p95 | 187 | - | 66340 | - |
| CK06 signed-url.body_bytes_total | 310379088 | - | 310379088 | - |
| CK06 signed-url.covering_chunk_bytes_total | 310379088 | - | 310379088 | - |
| CK06 signed-url.cf_cache_status | - | - | MISS:25 | - |
| CK06 authenticated.info_ms_p50 | 116 | - | 548 | - |
| CK06 authenticated.info_ms_p95 | 226 | - | 1577 | - |
| CK06 authenticated.body_bytes_total | 385876704 | - | 385876704 | - |
| CK06 authenticated.covering_chunk_bytes_total | 385876704 | - | 385876704 | - |
| CK06 authenticated.cf_cache_status | - | - | MISS:1 HIT:24 | - |
| CK06 plaintext_bytes_asked | 499413339 | - | 499413339 | - |

## Browser surface (CK11)

| field | onprem | onprem-file | region-a | region-b |
|---|---|---|---|---|
| page.upload | ok | ok | ok | ok |
| page.upload_etag_source | upload-part-header | upload-part-header | upload-part-header | upload-part-header |
| page.read.signed-url | 3/3 ok | 3/3 ok | 3/3 ok | 3/3 ok |
| page.read.s3 | 3/3 ok | 3/3 ok | 3/3 ok | 3/3 ok |
| page.read.authenticated | 3/3 ok | 3/3 ok | 3/3 ok | 3/3 ok |
| page.signed_get_readable_headers | content-range,etag,content-length,content-type | content-range,etag,content-length,content-type | content-length,content-type | content-length,content-type |
| preflight.s3_put | 200 allow-origin=http://localhost:4173 expose=* allow-headers=authorization,x-amz-date,x-amz-content-sha256,x-amz-security | 200 allow-origin=http://localhost:4173 expose=* allow-headers=authorization,x-amz-date,x-amz-content-sha256,x-amz-security | 200 allow-origin=* expose=- allow-headers=authorization,x-amz-date,x-amz-content-sha256,x-amz-security | 200 allow-origin=* expose=- allow-headers=authorization,x-amz-date,x-amz-content-sha256,x-amz-security |
| preflight.signed_url_get | 200 allow-origin=http://localhost:4173 expose=* allow-headers=range | 200 allow-origin=http://localhost:4173 expose=* allow-headers=range | 200 allow-origin=* expose=- allow-headers=range | 200 allow-origin=* expose=- allow-headers=range |
| preflight.authenticated_get | 200 allow-origin=http://localhost:4173 expose=* allow-headers=range,authorization,apikey | 200 allow-origin=http://localhost:4173 expose=* allow-headers=range,authorization,apikey | 200 allow-origin=* expose=- allow-headers=range,authorization,apikey | 200 allow-origin=* expose=- allow-headers=range,authorization,apikey |
