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

## 2026-10-23 - region-b re-run of CK04 and CK06

Why: on 2026-10-12 CK04 failed on region-b (the resume process ended with
`data api unreachable: The operation timed out.` after `resume_process_ms`
300412, while the laptop was entering maintenance sleep) and CK06 was skipped
because it reads CK04's asset.

Shape: one new Pro-org micro project, eu-central-1, created and deleted by
`make managed MANAGED=region-b IDS=CK04,CK06` (the `MANAGED` variable is new
in this commit; before it, `make managed` always made both regions). Same
migrations, same client, same 2 GiB fixture (256 chunks, 32 parts of 64 MiB).
The whole make target ran under `caffeinate -i`. Vantage: the same laptop in
Singapore. n = 1. Artifact: `out/2026-10-23/run-2026-10-23T10-34-14-905Z`
(run 10:34:14Z to 11:05:26Z, lab commit 77cdea0 with this commit's
changes in the working tree). Regenerated parity table with this run added:
`out/2026-10-23/parity.md`. In its region-b column the CK04 and CK06 cells are
the 2026-10-23 run and the rest are 2026-10-12; CK06 byte totals cover
successful reads only (region-b `authenticated` 369099456 bytes over 24 reads,
against 385876704 over 25 on onprem and region-a).

| cell | 2026-10-12 | 2026-10-23 |
|---|---|---|
| CK04 region-b | fail (resume timed out, see above) | pass: killed at 0.4063, 13 of 32 parts kept, 13 ETags match, 0 mismatches, `chunk_rows` 256, full read SHA-256 equals the fixture, `read_all_ciphertext_marker_hits` 0 |
| CK06 region-b | skip (no CK04 asset) | fail: 99 of 100 reads equal the fixture slice and were exactly the covering chunks; 1 of 25 `authenticated` reads failed with client error code `Thrown` (`errors` `authenticated:Thrown x1`) |

CK04 region-b, from the facts (one vantage, n = 1, not throughput claims):

| key | value |
|---|---|
| first_process_ms | 101981 |
| resume_process_ms | 145149 |
| read_all_ms | 108322 |
| info_upload_mib_per_s | 8.3 |
| info_read_mib_per_s | 18.9 |
| iat_future_retries | 0 |

CK06 region-b per read path (25 reads each, 100 ranges, `plaintext_bytes_asked`
499413339):

| path | ok | equal | body = covering chunks | info_ms_p50 | info_ms_p95 | cf_cache_status |
|---|---|---|---|---|---|---|
| s3 | 25 | 25 | 25 | 2311 | 4040 | - |
| s3-presigned | 25 | 25 | 25 | 1132 | 3665 | DYNAMIC:25 |
| signed-url | 25 | 25 | 25 | 50507 | 78804 | MISS:25 |
| authenticated | 24 | 24 | 24 | 983 | 2510 | HIT:24 |

What this settles and what it does not:

- CK04 on region-b passes when the host stays awake: the same S3 multipart
  resume (13 of 32 parts kept from server state) that passed on onprem and
  region-a on 2026-10-12. One trial. It does not explain the 2026-10-12
  timeout. It fits the sleep explanation, but a platform cause on that day is
  still not excluded.
- CK06 on region-b: every read that returned had the right bytes and a body
  of exactly the covering chunks, on all four paths. The module fails on the
  one `authenticated` read that threw. The artifact keeps the error code only,
  not its message. Reading the client source (not shown by the run): the code
  `Thrown` means an exception that was not a `CkError`. In `httpRange`
  (`client/src/read.ts`) the `fetch` call is wrapped, but the body read
  (`r.arrayBuffer()`) is not. So a connection that failed while the body was
  arriving would surface this way. That is one reading. The others are the
  same path's other unwrapped steps: the body read of the Data API calls for
  chunk hashes and the access-log row (`r.text()` in `rest1`,
  `client/src/catalogue.ts`) and the WebCrypto DEK import; the session
  refresh, the key-service call and the decrypt step do throw `CkError`s. The
  run cannot separate these. CK06 now records the first message per error key
  (`error_messages`) so a repeat run can tell.
- Signed-URL reads were slow again, as on region-a on 2026-10-12: `MISS:25`,
  p50 50507 ms on region-b (region-a 2026-10-12: `MISS:25`, p50 30479 ms).
  `/object/authenticated` answered `HIT:24` with p50 983 ms (region-a
  2026-10-12: `MISS:1 HIT:24`). Not shown: the cache status of the read that
  threw (region-b's 24 successful authenticated reads were all HIT; region-a's
  one MISS was on 2026-10-12).

Not run, with the reason:

| item | reason |
|---|---|
| A second 2 GiB run (n = 2) | the harness run took 31 minutes (10:34:14Z to 11:05:26Z; CK06 alone about 20 minutes by the make log, mostly the signed-url reads), past the time box for this re-run |
| An object past 2 GiB | the code now supports it (`CK_BIG_MIB=2250`: 2250 MiB, 282 chunks with a 2 MiB last chunk, offsets past 2^31; layout unit test added). Not run: same time box |
| CK04-CK06 on onprem-file | the Docker VM disk had 6.9 GB free with other experiments' data on it (operator check with `docker run --rm alpine df -h /` just before this run; no artifact). A completed 2 GiB multipart upload on the file backend may need the parts and the assembled object at once; that is reasoned, not measured |

Cleanup: `delete region-b: HTTP 200` at the end of the make target, then
`no ck- projects (HTTP 200)` from its sweep, and again from `make sweep` and a
direct `GET /v1/projects` at 11:06Z (the run's ref absent). Key service
container removed and the per-run KEKs deleted (`keysvc removed, KEKs
deleted`); no `ck-` containers left.

## 2026-10-26 - region-b: a 2.2 GiB object, a second 2 GiB run, and where signed-URL read time goes

Why: the 2026-10-23 region-b run left three things open. CK06 failed on one
`authenticated` read whose exception was not recorded; no object past 2 GiB
had been stored or read; and signed-URL reads took p50 50507 ms against about
1 s on the other HTTP paths, with only `cf-cache-status` recorded to explain it.

Changes before the runs (this commit):

- `httpRange` (`client/src/read.ts`) now times the response headers and the
  body separately, and keeps an allowlist of response header values (`age`,
  `cache-control`, `cf-cache-status`, `content-length`, `etag`,
  `last-modified`, `server-timing`, `via`, `x-cache`, `x-served-by`), the
  `cf-ray` colo and every header name. The signed-url path also times its `POST /object/sign`.
- A failed body read is now a `StorageError` with code `BodyRead`, the elapsed
  time, the status and the cache headers. Before this commit that step was
  outside the `try`, so a failure there surfaced as `Thrown` (one candidate
  for the 2026-10-23 read, not shown to be it).
- CK06 reports per HTTP path: time to headers (`info_ttfb_ms_p50/p95`), body
  time (`info_body_ms_p50`), sign time, colo, Age, header names, Spearman
  correlations of time to headers with the range start and with its length,
  and a `<path>.reads` string with one token per read
  (`<start MiB>+<len KiB>=<ttfb>/<total ms>,<cache>[,age<n>]`, start rounded
  to whole MiB, total from the ranged GET to its last body byte, sign call and
  decrypt excluded). `body_vs_start_spearman` was added after these runs; for
  them, `scripts/ck06-reads.ts` computes it from the tokens.

Shape: two runs of `make managed MANAGED=region-b IDS=CK04,CK06`, each on a
new Pro-org micro project in eu-central-1 that the same make target created
and deleted. Each make target ran under `caffeinate -i`. Vantage: the same
laptop in Singapore, with other lab agents running live work from it at the
same time. Lab commit adc597c, with this commit's client and CK06 changes in
the working tree (`body_vs_start_spearman` and `scripts/ck06-reads.ts` came
after the runs).

| run | fixture | artifact (`out/2026-10-26/`) | window (UTC) |
|---|---|---|---|
| 1 | `CK_BIG_MIB=2250` (2359296000 bytes, 282 chunks) | `run-2026-10-26T06-09-39-694Z` | 06:09:39Z to 06:35:21Z |
| 2 | 2 GiB (2147483648 bytes, 256 chunks) | `run-2026-10-26T06-36-08-256Z` | 06:36:08Z to 06:59:13Z |

Both runs passed CK04 and CK06.

| cell | run 1 (2.2 GiB) | run 2 (2 GiB) |
|---|---|---|
| CK04 | pass: killed at 0.4267, 15 of 36 parts kept, 15 ETags match, `chunk_rows` 282, full read SHA-256 equals the fixture, `read_all_ciphertext_marker_hits` 0 | pass: killed at 0.4063, 13 of 32 parts kept, 13 ETags match, `chunk_rows` 256, full read SHA-256 equals the fixture, `read_all_ciphertext_marker_hits` 0 |
| CK06 | pass: 100 of 100 reads equal the fixture slice, every body exactly the covering chunks | pass: the same |

In run 1, 17 of the 100 ranges start past 2^31 bytes and 19 end past it. That
count comes from `ranges()` with the 2250 MiB size (fixed seed), not from the
artifact. All 100 reads equal the fixture slice; the object they read is
CK04's (`ciphertext_size` 2359300512).

CK04 from the facts (one vantage, not throughput claims):

| key | run 1 | run 2 |
|---|---|---|
| first_process_ms | 62328 | 50618 |
| resume_process_ms | 85848 | 75821 |
| read_all_ms | 90968 | 80273 |
| info_upload_mib_per_s | 15.2 | 16.2 |
| info_read_mib_per_s | 24.7 | 25.5 |

CK06 per HTTP read path (25 reads each; `ms` is the whole decrypting read,
`ttfb` is from the ranged GET to its response headers, `body` is from the
headers to the last body byte):

| path | run | info_ms_p50 | info_ttfb_ms_p50 | info_body_ms_p50 | cf_cache_status | colo |
|---|---|---|---|---|---|---|
| s3-presigned | 1 | 910 | 315 | 379 | DYNAMIC:25 | SIN:25 |
| s3-presigned | 2 | 896 | 318 | 365 | DYNAMIC:25 | SIN:25 |
| signed-url | 1 | 51207 | 700 | 49679 | MISS:25 | SIN:25 |
| signed-url | 2 | 45408 | 725 | 44296 | MISS:25 | SIN:25 |
| authenticated | 1 | 722 | 219 | 243 | MISS:1 HIT:24 | SIN:25 |
| authenticated | 2 | 661 | 210 | 157 | MISS:1 HIT:24 | SIN:25 |

`s3` (SDK GetObject, no headers recorded) had `info_ms_p50` 2629 and 2306.
The signed-url sign call had `info_sign_ms_p50` 238 and 358. No response on
the three HTTP paths carried an `Age` header (`age_present` 0 on each, both
runs).

Where the signed-URL time goes. `bun scripts/ck06-reads.ts` on the two
artifacts gives:

| path | run | body_vs_start_spearman | body_vs_len_spearman | max ttfb ms | start MiB per body second, starts past 64 MiB: median (min-max) |
|---|---|---|---|---|---|
| signed-url | 1 | 0.97 | 0.17 | 1109 | 34.1 (18.7-36.6), n = 24 |
| signed-url | 2 | 0.92 | 0.04 | 1209 | 33.4 (22.5-36.3), n = 24 |
| authenticated | 1 | 0.14 | 0.55 | 1217 | - |
| authenticated | 2 | 0.31 | 0.64 | 1325 | - |

The medians are midpoint medians (mean of the 12th and 13th of 24); the
Spearman values carry no tie correction, and the tokens round start to whole
MiB and length to whole KiB, so a few lengths tie.

What this settles and what it does not:

- Measured: on every signed-URL read the headers came back within 1209 ms
  (max 1109 in run 1, 1209 in run 2, from the tokens; `info_ttfb_ms_p95` 1036
  and 919). Almost all of the read time was body time, and that time followed
  where the range starts in the object, not how long it is. The read starting
  in the first MiB took 1649 ms and 1368 ms of body time (tokens
  `0+2=317/1966` and `0+2=645/2013`). Apart from one run-1 read at 2121 MiB
  (113602 ms, `2121+509=697/114299`), the reads starting past 2000 MiB took
  57095 to 65489 ms of body time across both runs (run 1
  `2030+5107=687/57782` and `2191+6=1109/66598`; run 2 57153 to 63624, for
  example `2008+34=688/57873`). The median rate was 34.1 and 33.4 MiB of start
  offset per second of body time (24 reads past 64 MiB each; lowest 18.7 and
  22.5, highest 36.6 and 36.3). Every signed-URL read was a Cloudflare `MISS`
  answered from the Singapore colo.
- From the client source, not the artifact: each read minted a fresh signed
  URL (`fetchCipher` POSTs `/object/sign` per read; `info_sign_ms_p50` 238 and
  358 is that call).
- The first `authenticated` read in each run was also a `MISS`, and also
  slow: `2030+8904=1217/65125,MISS` in run 1 and `1847+8904=1325/53225,MISS`
  in run 2. That is 32 and 36 MiB of start offset per body second, about the
  same rate. The other 24 reads were `HIT`: a median 237 and 155 ms of body
  over the 24 HITs (`scripts/ck06-reads.ts`); `info_body_ms_p50` over all 25
  reads, the MISS included, was 243 and 157.
- Inference, not measured: on a cache MISS for a ranged GET, something reads
  the object from byte 0 and the requested bytes go out when that read
  reaches them. One reading: the edge fetches the whole object from the
  origin in eu-central-1 (its fill request drops the Range). The other: the
  origin's Storage REST path itself reads from byte 0 on these paths, while
  `s3-presigned` (`DYNAMIC`, body time flat at any offset) takes another
  route. Both predict body time linear in offset on a MISS and fast HITs;
  this run cannot tell the edge from the origin. A signed URL with a fresh
  token is a new cache key each time, so every such read is a MISS and pays
  that read up to its offset; storage-surface SS08a/SS08b measured the cache
  status half on small objects (a new signed URL for every read: 12 of 12
  `MISS`; one URL reused: `MISS` again on its second read in 3 of 4 pairs),
  not timed at large offsets. `/object/authenticated` keeps one URL, so after
  the first MISS later reads hit; in run 1 they hit at offsets past the first
  MISS's range (for example `2153+43053=63/767,HIT` after a first read at
  2030 MiB), so the fill went on after that read's bytes were sent.
- The storage-surface reading (SS03d run 4, 2026-10-12) does not show this
  pattern. Its one slow 1 KiB read, an `/object/authenticated` repeat on the
  direct host at offset 1 MiB, was a MISS that waited `ttfb=31521
  total=31527`, in time to headers, not in the body as every MISS here did;
  storage-surface read it as a request queued behind the edge filling the
  whole object (one sample). Its cold 1 KiB signed-URL read there
  (`ttfb=272 total=283`) also asked for bytes 1 MiB into the object, which
  the byte-0 reading predicts is fast. That offset is from the module source
  (`storage-surface/canary/battery.ts`, `RANGE`), not from its artifact.
- Inference: the 2026-10-12 region-a signed-URL p50 (30479 ms) sat below
  region-b's because the origin was in the same region as the vantage. Not
  measured: region-a was not re-run with the new columns.
- The 2026-10-23 `authenticated:Thrown x1` did not recur: 0 errors in 200
  reads over these two runs (50 of them `authenticated`, 2 of those the
  first-read `MISS`). The cause is still unknown. If it recurs in the
  `httpRange` body read it now shows as `StorageError BodyRead` with timings;
  a failure in the other unwrapped steps (the `rest1` body read, the WebCrypto
  import) still shows as `Thrown`, with its message in `error_messages`. One
  reading, not shown: on 2026-10-23 the failed read was the first
  `authenticated` read, the MISS. That run's 24 successful reads were all
  `HIT`, so the MISS is the one missing. But run 2 (same 2 GiB size and seed
  as 2026-10-23, `plaintext_bytes_asked` 499413339 in both) read what is most
  likely the same first `authenticated` range (`1847+8904=1325/53225,MISS`)
  in 53225 ms, well inside the 300 s read timeout (`READ_TIMEOUT_MS`).
- CK04 passed on region-b in both runs, three passes in a row now counting
  2026-10-23. Still unexplained: the 2026-10-12 timeout.

Not run, with the reason:

| item | reason |
|---|---|
| region-a with the new columns | out of scope for this re-run; it would test the origin-distance inference above |
| a timed large-offset read of one signed URL twice | not built; it would test the cache-key half at large offsets, not the edge against the origin |
| a probe separating edge from origin on a MISS | not designed; it needs a timed ranged read of Storage that skips the edge, and this run measured offset against body time only |
| CK04-CK06 on onprem-file | same reason as 2026-10-23 (Docker VM disk) |

Cleanup: each make target ended with `keysvc removed, KEKs deleted`,
`delete region-b: HTTP 200` and `no ck- projects (HTTP 200)` from its sweep.
