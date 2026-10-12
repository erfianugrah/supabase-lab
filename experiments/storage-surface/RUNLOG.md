# storage-surface RUNLOG

Chronological record of what was run. Org slugs and project refs are not
recorded; the org class is (a Pro-plan organization). Published artifacts
(refs, hostnames and the vantage address redacted) are in `out/2026-10-10/`
(SS01, SS02) and `out/2026-10-12/` (SS03 to SS07);
the file names below are those artifacts' names, and each cell cites a module
id. Pin the citations to the lab commit that adds this directory.

Claims under test come from a Supabase blog post dated 2026-03-05
(https://supabase.com/blog/supabase-storage-performance-security-reliability-updates)
and the Storage docs page on deleting objects
(https://supabase.com/docs/guides/storage/management/delete-objects). In
every table below, "docs" means that text and "measured" means a value in an
artifact.

## 2026-10-10 - SS01 and SS02 (Pro org, ap-southeast-1)

Shape: n = 3 runs of each module, each run on its own freshly created
project (6 projects), created and deleted by the module. Vantage: one laptop.

| item | value | source |
|---|---|---|
| Bun and Node versions | read them from `toolVersions.bun` in each artifact, and `node --version` for the SS02 Node legs; not restated here | artifacts |
| Storage server version | the `storage_version` measurement, identical in 3 of 3 runs | SS01a |
| Postgres version | the `pg_version` measurement, identical in 3 of 3 runs | SS01a |
| Rows in `storage.migrations` | 73 in 3 of 3 runs | SS01a |
| Round trip to the project gateway | 43.7 / 45.1 / 38 (median of 15 `GET /storage/v1/version` calls, in ms, one value per SS01 run) | SS01d `rtt_baseline_get_version_median_ms` |
| Compute size | not read back; the create call gave none | - |

Runs, by artifact:

| run | SS01 | SS02 |
|---|---|---|
| 1 | `run-2026-10-10T05-10-28-032Z` | `run-2026-10-10T05-05-11-963Z` |
| 2 | `run-2026-10-10T05-18-26-459Z` | `run-2026-10-10T05-13-39-127Z` |
| 3 | `run-2026-10-10T05-28-04-936Z` | `run-2026-10-10T05-23-08-359Z` |

Operator notes (this paragraph, the scouting runs and the Cleanup section are
the operator's account; no artifact in `out/` backs them): two earlier runs are
not counted. An SS02 run started at 04:42 UTC was
discarded because `canary/matrix.ts` was edited while it was running (one key's
source text changed during the window, so the key set of its four matrices
cannot be vouched for). An SS01 run started at 04:45 UTC stalled for about 15
minutes with no CPU use and was killed; its project was deleted by hand. The
cause was not diagnosed (a pooler socket with no query timeout is the likely
candidate, not confirmed); `pgSession` now sets `query_timeout` and
`keepAlive`. Scouting runs before these (two SS01, two SS02 with an earlier
key matrix) gave the same categorical outcomes (guard, orphan, key classes) but
different latencies, so latencies here depend on when and from where they were
taken. Those runs are not artifacts and the outcome comparison is unverified
from this directory.

### SS01a-b - the delete guard

| finding | measured | module |
|---|---|---|
| `storage.prefixes` | absent (`to_regclass` null) in 3 of 3 runs | SS01a |
| Tables in schema `storage` | buckets, buckets_analytics, buckets_vectors, migrations, objects, s3_multipart_uploads, s3_multipart_uploads_parts, vector_indexes | SS01a |
| Delete triggers | `protect_objects_delete` on `storage.objects` and `protect_buckets_delete` on `storage.buckets`, both statement-level, before, delete | SS01a |
| `DELETE FROM storage.objects WHERE false` as `postgres` through a session-mode pooler connection | refused, SQLSTATE 42501, "Direct deletion from storage tables is not allowed. Use the Storage API instead." The statement matches zero rows, so the trigger fires per statement, not per row | SS01b |
| `DELETE FROM storage.buckets WHERE false` | refused, same message | SS01b |
| A `DELETE` on `storage.objects` through the Management API query endpoint | HTTP 400 with the same SQLSTATE and message | SS01b |
| `SET storage.allow_delete_query = 'true'` then the same `DELETE` | accepted (0 rows) | SS01b |
| Other spellings: `'on'`, `'TRUE'` | refused, so the trigger compares the string `true` exactly | SS01b |
| `SET LOCAL ... = 'true'` inside a transaction | accepted inside; refused again after commit | SS01b |
| Management API query endpoint, `set ...; delete ...` in one request | HTTP 201, accepted | SS01b |
| `TRUNCATE storage.objects` as `postgres`, inside a transaction that was rolled back | no error (the trigger is on DELETE only); the statement was not committed | SS01b |

Docs: the blog post says a statement-level trigger rejects DELETE on Storage
schema tables unless the variable is `true`. The measured rows agree. That the
Storage API itself sets the variable is not stated by the post text fetched and
was not tested here. The post does not mention `TRUNCATE`; the last row is
a measurement the post makes no claim about, taken in a rolled-back
transaction. A TRUNCATE that is committed was not run.

### SS01c - does the backing file survive a SQL delete

Method: Storage's read path appears to key the backing file by bucket, name and
`storage.objects.version`; the module tests that from behaviour rather than
assuming it. Three objects per run: one uploaded through the REST API, one
through the S3 endpoint, one control. Each row was captured as JSON before
deletion.

| step | measured (3 of 3 runs identical) |
|---|---|
| Control: API `DELETE`, then re-insert the captured row with its original `version` | REST read returns HTTP 400 with body `statusCode` 404 "The resource was not found". The API delete removed the backing file, and a row alone does not serve bytes |
| SQL delete with the setting on, REST-uploaded object | 1 row deleted; REST read HTTP 400, body `statusCode` 404 "Object not found" |
| SQL delete with the setting on, S3-uploaded object | 1 row deleted; S3 GET `NoSuchKey` (HTTP 404), HEAD 404, `ListObjectsV2` on the prefix returns 0 keys |
| Re-insert the REST object's row with a new random `version` | REST read HTTP 400, body `statusCode` 404. The version is part of what the read path looks up |
| Re-insert the REST object's row with its original `version` | REST read 200 and the original bytes |
| Re-insert the S3 object's row with its original `version` | S3 GET 200 and the original bytes |

Reading: after a SQL delete the API and the S3 endpoint both report the object
absent, and the backing file is still there, because a row restored with the
original `version` serves the original bytes while a row with another `version`,
and a row restored after an API delete, do not. That is an orphan in the sense
the docs use. This is inference from controlled reads, not a view of the
backend: a project offers no listing of the underlying bucket. Not measured:
how long an orphan persists (the reads above came soon after the delete; the
delay was not timed or recorded), whether any background process reclaims it, and whether it counts
toward the project's storage size.

### SS01d - list v1 (limit/offset) against list v2 (cursor)

Setup: rows inserted with `INSERT INTO storage.objects` (5,000, 25,000 and
100,000, each under its own flat prefix), then `ANALYZE storage.objects`. No
backing files exist for these rows, so this times the listing query path only.
100 rows per page, sorted by name ascending. All latency cells are milliseconds
and give the three runs in order. Client-side cells go through the project
gateway from one laptop; v1 depth points are the median of 7 requests per run.
"DB-side" cells are the median of 5 executions of `storage.search` and
`storage.search_v2` inside a pooler session, with no network.

| prefix rows | v1 at offset 0 | v1 at last page | v2 at the cursor of the last page | v2 median page over a full walk | DB-side `search` at last page | DB-side `search_v2` at last page |
|---|---|---|---|---|---|---|
| 5,000 | 54.3 / 87 / 82.6 | 86.1 / 89.7 / 112.5 | 41.9 / 45.9 / 60.3 | 50.1 / 50.6 / 54.7 | 43.5 / 43 / 44.6 | 1.5 / 1.5 / 1.5 |
| 25,000 | 49.2 / 49 / 54.6 | 272.9 / 260.4 / 268.9 | 50.4 / 74 / 88.1 | 50.7 / 56 / 55.4 | 217 / 212 / 219.2 | 1.3 / 1.2 / 1.3 |
| 100,000 | 61.5 / 76.6 / 59.1 | 931.5 / 913.9 / 944.8 | 50.8 / 50.6 / 65.6 | 52.4 / 56.4 / 63.2 | 864.2 / 845.9 / 869.2 | 1.5 / 1.3 / 1.3 |

Whole-prefix walks, total seconds for all pages. v1 was walked only on the two
smaller prefixes (50 and 250 requests); the 100,000-row v2 walk is 1,000
requests.

| prefix rows | v1 offset walk | v2 cursor walk |
|---|---|---|
| 5,000 | 5.2 / 4.5 / 4.2 | 3.3 / 3.5 / 2.9 |
| 25,000 | 49.6 / 46.9 / 44.8 | 14.5 / 15.5 / 15.7 |
| 100,000 | not run | 60.9 / 70.6 / 78.0 |

Median page cost over the whole 25,000-row walk, in milliseconds, three runs in
order: v1 179.3 / 171.9 / 170, v2 50.7 / 56 / 55.4.

The v1 and v2 walks returned the same names in the same order on both prefixes
where both ran (yes in 3 of 3 runs, at 5,000 and 25,000 rows). v1 returns names
relative to the prefix and v2 returns full keys, so the module compares the last
path segment.

Derived from the cells above (arithmetic on the last-page columns, not
measured):

| prefix rows | client-side v1 / v2 at the last page, per run | DB-side `search` / `search_v2`, order of magnitude |
|---|---|---|
| 25,000 | 5.4 / 3.5 / 3.1 | about 165 to 180 |
| 100,000 | 18.3 / 18.1 / 14.4 | about 580 to 670 |

The round trip (first table of this log) and a page cost of about 50
milliseconds on the client hide most of the DB-side gap.

Docs: "up to 14.8 times faster" for deep pagination, measured by the post on a
60-million-row table, and "constant time regardless of how deep you page". What
these runs show: client-side v2 latency shows no depth trend beyond run-to-run
noise of roughly 40 to 130 ms on single samples. Within a run the v2 depth
points (first page, mid pages, last page) sit above and below each other with
no consistent direction, but single-sample pages are noisy: the first page of
the 100,000-row walk in run 3 took 131.4 ms against 50.6 to 65.6 ms in the
columns above, the last page of the 5,000-row walk in run 3 took 69.5 ms
against 41.9 to 60.3, and page 249 of the 25,000-row walk in run 3 took 88.1
against a 55.4 median. The v2 median page also differs between runs (100,000
rows: 52.4 / 56.4 / 63.2), so run 3 was slower throughout; that is a
time-of-run effect, not evidence about depth. The flat claim is kept for the
DB-side `search_v2` column only (1.2 to 1.5 ms at every size and run). v1
latency grows about linearly with offset (the DB-side column: 43 at 5,000 rows,
217 at 25,000, 864 at 100,000). The client-side ratio at 100,000 rows is the
same order as the post's figure, on a table 600 times smaller than the post's,
with a different layout (one flat prefix) and a client one round trip away; it
is not a reproduction of the post's number.

Not measured: layouts with many sub-prefixes, delimiter behaviour on mixed
folders, `sortBy` on columns other than name, listings with a `search` string,
concurrent load, tables of millions of rows, and the 30-second
`DB_STATEMENT_TIMEOUT` the post describes.

### SS02 - special-character keys on the S3 endpoint (AWS SDK for JavaScript v3)

Credentials: the session-token form (access key id = project ref, secret = the
anon key, session token = the service_role JWT), per
https://supabase.com/docs/guides/storage/s3/authentication. No run here used
dashboard-generated S3 access keys: I found no API route that creates them (the
Management API OpenAPI paths read on 2026-10-10 list none, and the Storage
routes tried with a service_role call answered 403 `Missing signature` or
404; operator note, no artifact), which is a negative from a search, not a
confirmation. Whether those keys
behave the same is reasoned (the same SigV4 verification), not measured. The
SDK package versions that were installed are in `canary/bun.lock`.

Each run is four matrices: gateway host `<ref>.supabase.co` and direct host
`<ref>.storage.supabase.co`, each with the SDK on Bun and on Node. A matrix is
40 keys, each put through PutObject, HeadObject, GetObject, ListObjectsV2
(`Prefix` = the key), a presigned GET fetched separately, CopyObject (the key as
source), a one-part multipart upload, DeleteObject and a HEAD after the delete.
All four matrices gave the same split in 3 of 3 runs (SS02a-d):

| outcome | keys | which |
|---|---|---|
| Accepted, and every S3 operation succeeded (18 of 18) | 18 | plain, space, `+`, `=`, `&`, `,`, `;`, `@`, `:`, `$`, `!`, `'`, `(` `)`, `*`, `?`, a nested path with spaces, a leading space, a trailing space |
| `400 InvalidKey` on PutObject | 19 | `%` (alone, as a literal `%20`, as a literal `%2B`, and in a nested path), `~`, `[` `]`, `{` `}`, `#`, `^` and `\|`, backtick, `<` `>`, `"`, `\`, tab, and every non-ASCII key tried: NFC and NFD "cafe", CJK, an emoji, and a 204-character multibyte key |
| `403 SignatureDoesNotMatch` | 3 | `a//b.txt`, `dot/./seg.txt`, `dot/../seg2.txt` |

No other failure class appeared (`other_failing_key_ids` was `none` in all 12
matrices, SS02a-d). The REST API GET on those keys returned the
same `InvalidKey` body (the first failing operation recorded for each key; the
REST upload status for them was not recorded), which suggests the
key-character restriction sits in Storage's key validation on both protocols;
the REST upload path for the 19 keys is not evidenced (SS02e). Docs: the error-codes
page lists `InvalidKey` as "Verify the key name and ensure it follows the
naming conventions" (https://supabase.com/docs/guides/storage/debugging/error-codes);
it does not list the accepted characters, so the 18/19 split above is the only
statement of them here, for this Storage server and the 40 keys tried.

The three 403 keys, with a local control (SS02h: a TCP listener on loopback
receives the SDK's request, records the request line and recomputes the SigV4
signature over the path as sent and over the key encoded per segment):

| key | SDK on Bun | SDK on Node | endpoint result |
|---|---|---|---|
| `a//b.txt` | sends `a//b.txt`, signature covers it | same | 403 on both hosts, both runtimes |
| `dot/./seg.txt` | sends `dot/seg.txt` (path resolved after signing; the signature covers the original) | sends `dot/./seg.txt`, signature covers it | 403 on both hosts, both runtimes |
| `dot/../seg2.txt` | sends `seg2.txt`, same pattern | sends `dot/../seg2.txt`, signature covers it | 403 on both hosts, both runtimes |

Reading, scoped to these runs. On Bun the dot-segment mismatch is the client's:
the request line was changed after signing. On Node the request line equals
what was signed, and the endpoint still answered 403, as it did for `//` on
both runtimes, so those three cases are refused by the endpoint (the gateway
host and the direct storage host alike). Which layer in front of or inside
Storage normalises the path before verifying the signature was not
determined; the runs cannot tell a gateway from the Storage server. An Amazon S3
control with the same SDK and keys would show whether real S3 accepts them; it
was not run (no valid AWS credentials were available; `make aws-control` is the
script to run it). REST behaviour for these three keys was not isolated: the
REST legs for them failed at the S3 GET step or because the S3 PUT had
failed.

REST legs on the 18 accepted keys (SS02e): raw `fetch` with each path segment
passed through `encodeURIComponent` round-tripped all 18 (REST GET of the
S3-created object, REST POST then S3 GET). supabase-js (the version pinned in
`canary/bun.lock`; `upload` and `download` with the key as a plain string)
round-tripped 17 of 18; the exception was `a?b.txt`, where the upload returned
no error but a later S3 GET of `sbjs/a?b.txt` answered 404 `NoSuchKey`. The
likely cause is an unencoded `?` starting a query string in the client's request
URL; the request URL was not captured, so this is inference.

Stored names (SS02f): the 18 `rest/<key>` rows in `storage.objects` equalled
the requested keys exactly (18 of 18, 3 of 3 runs).

Latency baseline (SS02g): 20 sequential 64-byte requests per operation per
matrix. Cells are the range of the three per-run medians across the three runs,
in milliseconds; the Node rows follow. Per run, Node and Bun medians differ by up to about 9
ms.

| host, SDK on Bun | PUT | GET | HEAD |
|---|---|---|---|
| direct (`<ref>.storage.supabase.co`) | 106.9 to 115.8 | 67.2 to 81.6 | 43 to 53.4 |
| gateway (`<ref>.supabase.co`) | 110.4 to 119.8 | 73.5 to 85.4 | 49.3 to 55.3 |

| host, SDK on Node | PUT | GET | HEAD |
|---|---|---|---|
| direct (`<ref>.storage.supabase.co`) | 111 to 118.5 | 71.4 to 72.7 | 42.1 to 48.6 |
| gateway (`<ref>.supabase.co`) | 109.8 to 122 | 76.3 to 80.4 | 50.3 to 57 |

The p95 of 20 samples is the largest or second-largest sample, so it is not a
stable figure and is left to the artifact. This is a canary baseline from one
vantage, not a measurement of any past incident; no status-page incident was
reproduced.

Not measured in SS02: dashboard-generated access keys; user-JWT sessions under
RLS; keys longer than the one 204-character multibyte key; objects larger than
a few bytes; multipart with more than one part; `DeleteObjects` (batch) and
`CopyObject` with a special-character destination; any region other than
ap-southeast-1; any client other than the AWS SDK for JavaScript v3 and
supabase-js.

### Cleanup

Operator notes, not artifact-backed (no teardown log or sweep output is in
`out/`): every project was created with the prefix `ss-` and deleted by
the module (DELETE returned 200 each time); the stalled SS01 project and a
scouting project were deleted by hand. `GET /v1/projects` after the last run
listed no project with the prefix; that sweep output is not attached here. One
AWS control attempt used a credential pair that Amazon S3 answered with
`InvalidAccessKeyId`; no AWS resource was created.

## 2026-10-12 - SS03 to SS07 (managed Pro project in ap-southeast-1; local self-hosted stack)

Claims under test come from public sources only:
https://supabase.com/docs/guides/storage/s3/compatibility (the S3 feature
table), https://supabase.com/docs/guides/storage/uploads/resumable-uploads,
https://supabase.com/docs/guides/storage/uploads/file-limits and the Storage
server source at https://github.com/supabase/storage. "Docs" below means
those pages as fetched on 2026-10-12.

One module, `SS03`, runs the SS03, SS04 and SS05 rows of PLAN.md on one target
per run, with the same row ids and measurement keys on every target. SS06 is
the row-by-row diff of those runs; SS07 is read only. Published artifacts are
in `out/2026-10-12/`:

| artifact | target | storage server | module |
|---|---|---|---|
| `run-2026-10-12T08-47-30-825Z` | managed, run 2 (primary) | 1.80.2 | SS03 |
| `run-2026-10-12T08-01-48-370Z` | managed, run 1: SUPERSEDED by run 2 (harness bug, see below); kept, not cited | 1.80.2 | SS03 |
| `run-2026-10-12T07-49-15-587Z` | self-hosted, file backend, default bind mount (preflight only) | 1.74.0 | SS03 |
| `run-2026-10-12T08-46-52-828Z` | `sh-file@v1.74.0` | 1.74.0 | SS03 |
| `run-2026-10-12T09-03-10-608Z` | `sh-s3@v1.74.0` | 1.74.0 | SS03 |
| `run-2026-10-12T08-57-25-340Z` | `sh-file@v1.80.2` | 1.80.2 | SS03 |
| `run-2026-10-12T08-52-50-926Z` | `sh-s3@v1.80.2` | 1.80.2 | SS03 |
| `run-2026-10-12T09-28-56-937Z` | diff of managed run 2, `sh-file@v1.74.0`, `sh-s3@v1.74.0`, `sh-file@v1.80.2`, `sh-s3@v1.80.2` | - | SS06 |
| `run-2026-10-12T07-49-33-833Z` | Management API, Pro org | - | SS07 |
| `run-2026-10-12T10-15-37-476Z` | managed, run 4: SS03d and SS03k only, fresh key per path and host (primary for those rows) | 1.80.2 | SS03 |
| `run-2026-10-12T09-35-13-830Z` | managed, run 3: same rows, partial (lost DNS near the end) | 1.80.2 | SS03 |
| `run-2026-10-12T09-36-10-805Z` | `sh-s3@v1.80.2`, same rows, control for run 4 | 1.80.2 | SS03 |

Shape: managed - one project per run, `ss-ss03-<epoch>`, created and deleted
by the module (teardown DELETE 200 in runs 1, 2 and 4; run 3 see Cleanup);
two hosts, the gateway `<ref>.supabase.co` and the direct storage host
`<ref>.storage.supabase.co`; S3 auth in the session-token form with the
service_role JWT. Self-hosted - the self-hosted-defaults rig at its pinned
supabase/supabase commit, one fresh stack per run, one host (the Envoy
gateway, addressed as `localhost:8000`), S3 auth with the stack's
`S3_PROTOCOL_ACCESS_KEY_ID` / `_SECRET`. The kind label is
`sh-<STORAGE_BACKEND>@<storage image tag>`, read from the running container;
the v1.80.2 variants use the rig's `storage-image` layer, so the version
effect can be told from the backend effect. Client: the AWS SDK for
JavaScript v3 and tus-js-client 4.3.1 (versions in `canary/bun.lock`), under
Node, from one laptop vantage. Fixtures from fixed seeds: `big` 2 GiB (128
parts of 16 MiB), `mid` 64 MiB, a gzip stream of 256 MiB of random bytes, and a
64x64 PNG.

Operator notes (not artifact-backed). Development runs between 07:45 and 09:03
UTC are not cited; they found the harness bugs fixed before the cited runs (a
2 GiB body hashed in one call, TUS dispatch, the error-cell format). Managed
run 1 (`run-2026-10-12T08-01-48-370Z`) is superseded: it started before the
first of those fixes reached `canary/battery.ts`, and the harness hashed a whole
2 GiB response in one buffer, so its SS03c stops after `big_rest_multi` with
`battery_error` (RangeError); its SS03i and SS05d cells use the older format.
Every managed figure below is from run 2 (`run-2026-10-12T08-47-30-825Z`),
except the cache-state and timing cells of SS03d and SS03k, which are from the
fresh-key re-run (run 4, `run-2026-10-12T10-15-37-476Z`).
Run 1 is kept in `out/` unchanged except for one local path in that stack
trace, redacted to `<lab>/`. One `sh-file@v1.74.0`
development run answered the 64 MiB PutObject at the default limit with 413
`EntityTooLarge`; the cited run got a 503 from Envoy for the same request (see
SS03i), so that cell is not stable.

### Self-hosted rig: what had to change to run the battery at all

| finding | measured | where |
|---|---|---|
| File backend on the default `./volumes/storage` bind mount, Docker Desktop for macOS | 1 KiB upload: S3 `500 InternalError`, REST `500 ... "The file system does not support extended attributes or has the feature disabled."` | SS03_target in `run-2026-10-12T07-49-15-587Z` (`preflight_s3_put_1KiB`, `preflight_rest_post_1KiB`) |
| S3 ListBuckets at `http://127.0.0.1:8000` vs at the host of `SUPABASE_PUBLIC_URL` (`localhost:8000`) | `403 SignatureDoesNotMatch` vs `200 ok` | SS03_target, every self-hosted run |

The file backend stores object metadata in extended attributes (the stack
trace names `fs-xattr`), so the cited `sh-file` runs put the data directory on
a named Docker volume (the rig's `storage-volume` layer). The Storage server
verifies SigV4 against the host of `STORAGE_PUBLIC_URL` when one is set
(https://github.com/supabase/storage/blob/v1.74.0/src/storage/protocols/s3/signature-v4.ts,
the `publicUrl` branch), so a client must use exactly that host. The
`sh-s3` runs keep MinIO's data on a bind mount (`minio-hostdir` layer): on the
default named volume, MinIO answered 507 `XMinioStorageFull` ("minimum free
drive threshold") partway through a run on this machine's Docker disk
(operator note; a development run). The upload limit is hard-coded in the
pinned `docker-compose.yml` (`FILE_SIZE_LIMIT: 52428800`), so the module
raises it with the `storage-limit` layer rather than an `.env` entry.

### SS03_target and SS03i - default limit, then raised

| item | managed | self-hosted |
|---|---|---|
| default limit | `default_file_size_limit` 52428800 (Management API storage config) | 52428800 (container env) |
| S3 protocol default | `default_s3_protocol_enabled` true | - |
| raise | `PATCH 200; fileSizeLimit now 10737418240`; a 64 MiB PutObject succeeded after `8s` (run 2) | `compose exit 0; FILE_SIZE_LIMIT now 10737418240`, `1s` |

At the default limit, a 64 MiB upload (SS03i, managed run 2 then `sh-s3@v1.80.2`):

| request | managed | self-hosted |
|---|---|---|
| S3 PutObject | `413 ct=text/plain code=EntityTooLarge` | `413 ct=application/xml code=EntityTooLarge` (`sh-file@v1.74.0`: `503 ct=text/plain code=- message=upstream connect error or disconnect/reset before headers`) |
| REST POST | `400 ct=application/json code=EntityTooLarge body.statusCode=413` | same |
| multipart, four 16 MiB parts | `part 4: 413 EntityTooLarge`: parts are refused once the running total passes the limit | same on every self-hosted run except `sh-file@v1.74.0` (`part 4: 503`) |

### SS03a, SS03b, SS03j - multipart of `big`

| row | managed | self-hosted (all four) |
|---|---|---|
| per-part ETag equals the local part MD5 | `128/128` | `128/128` |
| ListParts after 40 parts | `200 count=40 etags_match=40` | same |
| client process exits after 40 parts; a new process | ListMultipartUploads finds it (`true`), ListParts `40`, uploads `88` more, CompleteMultipartUpload `200 ok` | same |
| SHA-256 of a full GET equals the fixture | `true`, `get_bytes` 2147483648 | `true` |
| final ETag | `aws-multipart (md5 of part md5s, -128)` | `sh-s3@*`: the same; `sh-file@*`: `md5-of-object` |
| AbortMultipartUpload | ListParts after: `404 NoSuchUpload`; not in ListMultipartUploads | same |
| wall time (SS03j, info) | upload `208.3` s to the direct host, download `58.1` s from the gateway | local, not comparable |

The ETag form follows the backend, not the version. The same split shows on
single uploads: `mid_put_etag` (one 64 MiB PutObject with a known length) is
`"b5d87668321e5b89a5adfed51e705c60-4"` on managed and `sh-s3`, the object MD5
on `sh-file`, and an unknown-length PutObject (chunked transfer encoding,
SS03g `put_unknown_length_etag`) gives `md5-dash-4` on managed and `sh-s3`.
Docs make no statement about ETag form.

### SS03c, SS03d - range reads

Single ranges (first 1 KiB, a 4 KiB middle range, suffix `-1024`, open
`N-`) returned 206 with the right `Content-Range` and bytes (`hash=ok`) on
`mid` and `big`, on S3 and REST, on every target. The rows that differ (SS06-SS03c):

| request | managed | sh-file 1.74.0 / 1.80.2 | sh-s3 1.74.0 / 1.80.2 |
|---|---|---|---|
| `Accept-Ranges` on S3 HeadObject and GetObject | `absent` | `absent` | `absent` |
| `Accept-Ranges` on REST 206 | `ar=-` | `ar=bytes` | `ar=bytes` |
| past EOF, S3 | `416 InvalidRange` | `416 InvalidRange` | `416 S3Error` / `416 InvalidRange` |
| past EOF, REST | `416 cr=bytes */67108864 cl=0` | `416` JSON | `500` JSON / `416` JSON |
| `bytes=0-9,20-29`, S3 | `200` whole object | `416 InvalidRange` | `200` whole object |
| `bytes=0-9,20-29`, REST | `206 ct=multipart/byteranges` | `416` | `200` whole object |
| `Bytes=0-9` (mixed-case unit), S3 | `200` whole object | `416` / `206 cr=bytes 0-9` | `200` whole object |
| `Bytes=0-9`, REST | `206 cr=bytes 0-9` | `416` / `206 cr=bytes 0-9` | `200` whole object |

On managed the REST answer to a multi-range or a mixed-case unit differs from
the S3 answer on the same object; the origin answers both like `sh-s3`, so the
multipart/byteranges body and the case-insensitive unit come from the layer in
front (inference: the CDN serves REST reads, not S3; see SS03d). A client that
sends a multi-range request to S3 GetObject on managed or `sh-s3` receives the
whole object with status 200, 2 GiB in the `big` case.

SS03d, one 1 KiB range at offset 1 MiB through every read path and host. The
first design (runs 1 and 2) read objects that SS03c had already read through
`/object/authenticated`, so its "first" reads were not cold (`HIT` on several);
those SS03d cells are superseded for cache state. The re-run gives every path
and host its own server-side copy of the object (`CopyObject` to a fresh key,
deleted after its two reads), so the first read is the first request for that
key anywhere: managed `run-2026-10-12T10-15-37-476Z` (rows SS03d and SS03k
only, fresh project), with `run-2026-10-12T09-35-13-830Z` as a partial repeat
(it lost DNS late in the run; two warming probes and six SS03k cells say
`copy 0 TimeoutError` / `copy 0 Error`), and `sh-s3@v1.80.2` as the control
(`run-2026-10-12T09-36-10-805Z`).

Every read returned `206` with the right bytes on every target and host. Cache
state on managed, run 4, `mid` and `big` alike:

| path | first read (fresh key) | repeat read |
|---|---|---|
| S3 presigned GET | `cf=DYNAMIC` | `cf=DYNAMIC` |
| signed URL | `cf=MISS` | `cf=REVALIDATED` |
| `/object/public` | `cf=MISS` | `cf=HIT` |
| `/object/authenticated` | `cf=MISS` | `cf=HIT`, except `big_direct_auth_repeat` `cf=MISS` |

Time for the 1 KiB range of `big` (`big_<host>_<path>_<read>_timing_ms`, time to
the response headers and total, ms, run 4):

| path | gateway, cold | gateway, repeat | direct, cold | direct, repeat |
|---|---|---|---|---|
| presigned | `ttfb=185 total=186` | `ttfb=160 total=160` | `ttfb=197 total=197` | `ttfb=158 total=159` |
| signed URL | `ttfb=272 total=283` | `ttfb=111 total=111` | `ttfb=282 total=312` | `ttfb=109 total=110` |
| public | `ttfb=389 total=395` | `ttfb=87 total=87` | `ttfb=319 total=330` | `ttfb=86 total=86` |
| authenticated | `ttfb=1718 total=1728` | `ttfb=102 total=102` | `ttfb=337 total=363` | `ttfb=31521 total=31527` (`cf=MISS`) |

A cold ranged read of the 2 GiB object answered within `ttfb=1718` ms on every
path, while whole 2 GiB reads in SS03k took `ms=53064` to `ms=155110` from this
vantage, so on a MISS the edge did not wait for the whole object before serving
the range. One repeat read (`/object/authenticated` on the direct host) was a
MISS that took `ttfb=31521` ms for 1 KiB; in run 3 the same cell was `cf=HIT`
(`ttfb=116`).
A wait of that size fits a request queued behind the edge filling the whole
object into cache after the first MISS; that is inference from one sample, not
a measured mechanism. The self-hosted control has no cache: every cold and
repeat timing is 4 to 105 ms locally.

Does a read through one path or host warm another (`warms_*`, fresh key per
probe, `mid`, a public bucket):

| first read, then | run 4 | run 3 |
|---|---|---|
| authenticated, then public, same host | `cf=MISS -> pub@gateway 206 cf=HIT` | not measured (copy timed out) |
| public, then authenticated, same host | `cf=MISS -> auth@gateway 206 cf=HIT` | same |
| authenticated, then signed URL, same host | `cf=MISS -> sign@gateway 206 cf=MISS` | not measured |
| authenticated on the gateway, then on the direct host | `cf=MISS -> auth@direct 206 cf=MISS` | same |
| public on the gateway, then on the direct host | `cf=MISS -> pub@direct 206 cf=MISS` | same |

So `/object/public` and `/object/authenticated` share one cache entry per host
for an object in a public bucket; signed URLs have their own entries, and the
gateway and the direct storage host do not share. Not measured: the same
probes on a private bucket. The S3 SDK cells do not record the header; the
presigned S3 GET shows `DYNAMIC`. Docs list Range and PartNumber as supported
on GetObject; Range is measured here, PartNumber in SS03g.

### SS03e - conditional reads

| request (1 MiB object) | managed S3 / presigned | managed signed, public, authenticated | self-hosted 1.74.0 (file, s3) | self-hosted 1.80.2 (file, s3) |
|---|---|---|---|---|
| GET `If-None-Match` = ETag | `304` | `304 cf=HIT` | `304` | `304` |
| GET `If-Match` wrong | `412 PreconditionFailed` | `200 ... cf=HIT` | `200` | `412 PreconditionFailed` |
| GET `If-Modified-Since` = Last-Modified | `304` | `304 cf=HIT` | file `200`, s3 `304` | `304` |
| GET `If-Unmodified-Since` yesterday | `412 PreconditionFailed` | `200 ... cf=HIT` | `200` | `412 PreconditionFailed` |
| GET other ETag + `If-Modified-Since` = Last-Modified | `200` | `200` | file `200`, s3 `304` | file `200`, s3 `304` |
| HEAD, any of the above, S3 | `200` | - | `200` | `200` |
| HEAD on the signed URL | - | `304` for If-None-Match and If-Modified-Since, `200` for If-Match wrong and If-Unmodified-Since, `cf=REVALIDATED` | If-None-Match `304`, If-Match and If-Unmodified-Since `200`; If-Modified-Since file `200`, s3 `304` | as GET: `412` for If-Match wrong and If-Unmodified-Since, `304` for If-None-Match and If-Modified-Since |
| HEAD on public and authenticated | - | as the signed URL, `cf=REVALIDATED` | `200` for every condition | `200` for every condition |

Cache state on managed when these were sent (run 2, quoted from the cells):
the GET controls read signed URL `cf=MISS`, public `cf=MISS`, authenticated
`cf=HIT` (the module reads the paths in the order S3, presigned, signed, public,
authenticated, so the signed-URL and public reads of the same object came
first; see the SS03d warming probes); every conditional GET after the control on those three paths shows
`cf=HIT`, and every HEAD on them `cf=REVALIDATED`. So the managed column for
the CDN paths is the CDN's answer for a cached object; S3 and presigned reads
are `cf=DYNAMIC` (not cached), the origin's answer. The cold-cache case of a
conditional read was not measured.

RFC 9110 has If-None-Match override If-Modified-Since, so "other ETag +
If-Modified-Since" should be 200; managed and the file backend give 200, the
`sh-s3` targets 304. The `sh-s3` targets store objects in MinIO, and the
Storage server passes conditional reads to its S3 backend, so `sh-s3` answers
like this one (and If-Modified-Since `304` at 1.74.0) may be MinIO's behaviour
rather than the Storage server's; read them as "self-hosted with MinIO", not as
"self-hosted". Managed also uses an S3 backend and answers 200 here. S3 HeadObject ignored every conditional header on every
target (docs list all four as supported on HeadObject).

Ranged reads with a wrong `If-Match`, after two warming reads of the same range:

| path | managed (run 2) | self-hosted 1.74.0 | self-hosted 1.80.2 |
|---|---|---|---|
| presigned S3 | `412 cf=DYNAMIC` | `206` | `412` |
| signed URL, public, authenticated | `206 cf=HIT bytes=1024` | `206` | `412` |

The overwrite case: read `cond-overwrite.bin` twice through
`/object/authenticated` with a range, overwrite it through S3, then ask for the
same range with `If-Match` set to the first version's ETag:

| path | managed | self-hosted 1.74.0 | self-hosted 1.80.2 |
|---|---|---|---|
| `/object/authenticated` | `206 cf=HIT bytes=100 v1-bytes` | `206 ... v2-bytes` | `412` |
| S3 GetObject | `412 PreconditionFailed` | `206 bytes=100 v2-bytes` | `412 PreconditionFailed` |
| `/object/public` | `206 cf=MISS bytes=100 v2-bytes` | `206 ... v2-bytes` | `412` |

On managed, `/object/authenticated` served the pre-overwrite bytes from the
cache after the overwrite (the If-Match matched the cached copy), and the
public URL, on a MISS, returned the new bytes with status 206 although they no
longer match the If-Match ETag. The Storage server at 1.80.2 enforces If-Match
on every path when reached directly (`sh-*@v1.80.2`); on managed only the S3
paths, which the CDN does not cache (`DYNAMIC`), give the origin's answer. Same
in run 1. Not measured: how long the stale copy stays served, and whether a
different `Range` or a fresh signed URL avoids it.

### SS03f - conditional writes

Identical on every target (SS06-SS03f, 0 keys differ):

| request on an existing key | measured |
|---|---|
| PutObject `If-None-Match: *` | `200 ok -> overwritten` |
| PutObject `If-Match` stale ETag | `200 ok -> overwritten` |
| CompleteMultipartUpload `If-None-Match: *` | `200 ok -> overwritten` |
| CreateMultipartUpload `If-None-Match: *` | `200 upload id returned` |
| UploadPartCopy `x-amz-copy-source-if-match` wrong | `200 ok etag=returned` |

Docs mark UploadPartCopy's copy-source conditions unsupported and do not list
conditional writes. Measured: the conditions are accepted and ignored, so an
"only create if absent" or "only replace this version" PUT overwrites.

### SS03g - checksums

Identical on every target (SS06-SS03g, only `put_unknown_length_etag`
differs):

| request | measured |
|---|---|
| PutObject with `x-amz-checksum-sha256` correct / wrong | `200 ok ... -> stored` both; no checksum echoed |
| PutObject `Content-MD5` correct / wrong | `200 ok ... -> stored` both |
| PutObject `x-amz-checksum-crc32` wrong (header) | `200 ok ... -> stored` |
| aws-chunked body with a trailing `x-amz-checksum-crc32`, correct / wrong | `200 ok -> stored` both |
| SDK default (`x-amz-checksum-crc32` sent as a header for a buffer body) and `requestChecksumCalculation: WHEN_REQUIRED` | `200` both |
| HeadObject / GetObject `ChecksumMode: ENABLED` | `200 sha256=absent crc32=absent` |
| GetObjectAttributes | `200 ct=application/octet-stream bytes=262144 body=the object bytes (fell through to GetObject)` |
| UploadPart with SHA-256 correct / wrong | `200 ok` both |
| HEAD `?partNumber=1` on the 128-part object | `200 cl=2147483648` (the whole object, not part 1) |

Docs mark Content-MD5 and the `x-amz-checksum-*` headers unsupported; measured,
"unsupported" means accepted and not checked: a corrupted body with a correct
client checksum would be stored. Docs list PartNumber as supported on GetObject;
on HeadObject it returned the whole object's length.

### SS03h - CORS

| response | managed | self-hosted (Envoy) |
|---|---|---|
| preflight on S3, signed, public, authenticated paths | `200 allow-origin=*`, methods listed, requested headers echoed, `max-age=3600`, no expose list | `200 allow-origin=https://cors-probe.example`, `expose-headers=*` |
| actual GET (S3, signed, public, authenticated) | `allow-origin=*`, `expose-headers=-`: ETag, Content-Range and x-amz-checksum not exposed | `expose-headers=*` |
| S3 UploadPart response | `expose-headers=etag` | `expose-headers=*` |
| PutBucketCors on a bucket name that does not exist | `200 ok; bucket exists afterwards: yes` (deleted again, 204) | same |
| GetBucketCors, raw | `200 ListBucketResult body (routed to ListObjects)` | same |

A browser on managed can read the ETag of an UploadPart response (what a
browser multipart upload needs) but not the ETag or Content-Range of a GET.
Docs mark PutBucketCors and GetBucketCors unsupported; measured, PutBucketCors
creates a bucket and GetBucketCors lists objects. A wildcard
`Access-Control-Expose-Headers` is not honoured by browsers on credentialed
requests (Fetch standard), so the self-hosted `*` does not cover requests sent
with cookies.

### SS03i - error bodies (managed run 2; self-hosted in SS06-SS03i)

| case | S3 | REST |
|---|---|---|
| missing key | `404 ct=text/plain code=NoSuchKey` | `400 ct=application/json code=NoSuchKey body.statusCode=404` |
| missing bucket | `404 ct=text/plain code=NoSuchKey` | `400 ... code=NoSuchBucket body.statusCode=404` |
| wrong secret / forged JWT | `403 ... code=SignatureDoesNotMatch` | `400 ... code=AccessDenied body.statusCode=403` |
| key `100%.txt` | `400 ... code=InvalidKey` | `400 ... code=InvalidKey` |
| range past EOF | `416 ... code=InvalidRange` | `416 ct=- code=-` (empty body) |

S3 error bodies are XML served as `text/plain` on managed and as
`application/xml` on every self-hosted target; a missing bucket answers
`NoSuchKey` on S3 everywhere. REST errors carry HTTP 400 with the real status
in the JSON body. `sh-s3@v1.74.0` answers a REST range past EOF with
`500 ... code=InternalError` and an S3 one with `code=S3Error`; 1.80.2 gives 416
`InvalidRange` on both.

### SS03k - whole reads of a gzip-encoded object and of `big`

The cited managed cells are from the fresh-key re-run
(`run-2026-10-12T10-15-37-476Z`): each path and host reads its own server-side
copy, first (cold) and repeat. Runs 1 and 2 read shared, already-warm keys; their
SS03k cells agree on bytes and headers and are superseded for cache state.

Every read of both objects, through presigned S3, signed URL, public URL and
`/object/authenticated`, on both hosts, first and repeat, returned the stored
bytes with the full length (`hash=stored-bytes`, `cl=268517089` for the gzip
object, `cl=2147483648` for `big`) and no `transfer-encoding`: 16 of 16 cells per
object in run 4, and the same on every self-hosted target (8 of 8). The
requests sent `Accept-Encoding: gzip, deflate, br`. Cache state of the repeat
whole read on managed, run 4:

| path | gzip object, gateway / direct | `big`, gateway / direct |
|---|---|---|
| presigned | `DYNAMIC` / `DYNAMIC` | `DYNAMIC` / `DYNAMIC` |
| signed URL | `MISS` / `MISS` | `MISS` / `HIT` |
| public | `HIT` / `HIT` | `HIT` / `HIT` |
| authenticated | `HIT` / `HIT` | `HIT` / `HIT` |

The edge cached and served the 2 GiB object intact. Signed URLs re-fetched the
whole object on three of four repeat reads; their ranged repeats in SS03d were
`REVALIDATED`. The difference between targets is the header on the gzip object
(stored through S3 PutObject with `ContentEncoding: gzip`):

| target | `Content-Encoding` on every read of the gzip object |
|---|---|
| managed (1.80.2) | `ce=gzip` |
| `sh-file@v1.80.2`, `sh-s3@v1.80.2` | `ce=gzip` |
| `sh-file@v1.74.0`, `sh-s3@v1.74.0` | `ce=-` (absent) |

So at 1.74.0 a gzip object is served as opaque bytes with no encoding header,
and a browser would not decode it; at 1.80.2 the header comes back. Neither the
edge nor the origin re-encoded or truncated anything. Not measured: objects
past 2 GiB, CDN eviction, and a client that decodes (fetch, browsers), which
would see the decompressed body as a client property.

### SS03l - server-side encryption headers

Identical on every target (SS06-SS03l, 0 keys differ):

| request | measured |
|---|---|
| PutObject with SSE-C headers | `200 accepted sse_response_headers=none`; GET without the key `200 plaintext bytes returned` |
| PutObject `x-amz-server-side-encryption: AES256` | `200 accepted`, GET returns the plaintext, no SSE header on HEAD |
| PutObject `aws:kms` with a key id | `200 accepted`, same |
| CreateMultipartUpload with each of the three | `200` (an upload id) |
| GetBucketEncryption | `200 ListBucketResult body (routed to ListObjects)` |

Docs mark SSE unsupported. Measured: the headers are accepted and silently
ignored. A client that sets SSE-C believes the object needs its key; the object
is readable without it. Nothing here says how the platform encrypts data at
rest; that is not observable from the API.

### SS04 - TUS

| row | managed | self-hosted |
|---|---|---|
| `big`, 6 MiB chunks, SHA-256 of a GET (SS04a) | `true` (direct host) | `true` |
| `mid` with 5, 6 and 8 MiB chunks | `completed, sha256 ok` all three | same |
| SIGKILL after `20` chunks, resume from the stored URL in a new process (SS04b) | HEAD `200 upload-offset=125829120`, `completed, 322 more chunks` | same |
| kill on the gateway after 2 chunks, resume on the direct host | `HEAD 200 offset=12582912; completed`, SHA-256 `true` | n/a (one host) |
| TUS object through S3 (SS04c) | range `206`; ETag `md5-dash-342` | `sh-s3@*` `md5-dash-342`; `sh-file@*` `md5-of-object` |
| `Upload-Expires` on the creation response (SS04d) | `present`, `24` hours | `sh-s3@*` `present`, `1` hour; `sh-file@*` `absent` |
| TUS to an existing key without `x-upsert` | `refused: 409 The resource already exists` | same |

Docs: chunk size "must be set to 6MB (for now) do not change it"; measured, 5
and 8 MiB chunks completed with the right bytes on every target, n = 1 each.
Docs: the upload URL is "valid for up to 24 hours"; managed reports 24 hours,
self-hosted 1 hour with the s3 backend and no header with the file backend.
Docs: an existing path gives "400 Asset Already Exists"; measured 409. The ETag
of a TUS object counts the backend's parts (342, one per 6 MiB TUS chunk of the
2 GiB object), so it does not match a multipart upload of the same bytes.

### SS05 - a client-side encrypted object

| row | measured (every target) |
|---|---|
| `mid` as AES-256-GCM, 4 MiB chunks (+16-byte tag), uploaded as `application/octet-stream` (SS05a) | chunk-aligned ranges 0, 7 and 15 via S3 and REST: `decrypts to the plaintext slice` |
| `storage.objects.metadata` (SS05b) | keys `cacheControl,contentLength,eTag,httpStatusCode,lastModified,mimetype,size`; `user_metadata` `{}`; `cacheControl` `no-cache` |
| image render on the ciphertext (SS05c) | managed `400 ... "The source image file is too large to process"`; self-hosted `400 ... "The source image is invalid or unsupported for rendering"`; PNG control `200 ct=image/png` everywhere |
| upload with no content type, REST and S3, ciphertext and a PNG | stored mimetype `application/octet-stream` for all four: no sniffing |
| owner-only RLS select policy (SS05d) | before the policy every user gets `400 ... NoSuchKey`; after it, the owner `206` (REST, managed `cf=MISS`) and S3 session token `206 ok`; the other user `400 cf=BYPASS` and S3 `404 NoSuchKey`; anon `400` |

The server records size, type, ETag and cache settings only; nothing beyond
what the client sent. The metadata ETag is `md5-dash-N` on managed and `sh-s3`,
`32-hex` on `sh-file`. SS05d read the owner first; the other user's read right
after it was not served from the cache (`BYPASS`). The residency-facts finding
that a cached private object reaches a second user was a read of the same URL
with no Range; this row used a 16-byte range and does not test that case.

### SS06 - managed against self-hosted

The `sh-s3` columns are the Storage server on MinIO. Where `sh-s3` differs
from both managed and `sh-file` (If-Modified-Since precedence, a REST range
past EOF at 1.74.0, whole-object answers to multi-range requests, the
`S3Error` code), MinIO as the backing store is a candidate cause that these
runs do not separate from the Storage server's own code; none of those rows is
a statement about self-hosting in general.

Versions: managed 1.80.2 (both runs); the pinned self-hosted compose file
1.74.0; the image override 1.80.2. From `run-2026-10-12T09-28-56-937Z`, rows
with a difference:

| row | what differs | follows |
|---|---|---|
| SS03a, SS04c, SS05b, SS03g `put_unknown_length_etag` | ETag form | backend: managed = `sh-s3` |
| SS03c | Accept-Ranges on REST, multi-range, mixed-case unit, past EOF | CDN on managed; backend and version on self-hosted |
| SS03e | If-Match and If-Unmodified-Since | version (1.74.0 ignores them) and, on managed REST paths, the CDN |
| SS03e | If-Modified-Since alone, and its precedence | backend (file 200, s3 304 at 1.74.0); the s3 rows may be MinIO's answers |
| SS03e | HEAD conditionals on public and authenticated (managed answers 304 via the CDN; self-hosted 200 for every condition) | CDN |
| SS03k | `Content-Encoding: gzip` returned or dropped | version (absent at 1.74.0) |
| SS03h | ACAO `*` vs the Origin echoed, no expose list vs `*` | gateway (Cloudflare vs Envoy) |
| SS03i | XML error content type; 500 on a REST range past EOF | gateway; `sh-s3@v1.74.0` |
| SS04d | `Upload-Expires` 24 h / 1 h / absent | deployment configuration and backend |
| SS05c | image render error text on the ciphertext | image service configuration |

Same on every target: SS03b, SS03d (statuses and bytes), SS03f, SS03g
(checksums), SS03k (bytes and Content-Length), SS03l, SS04a, SS04b, SS05a,
SS05d.

### SS07 - region catalogue and key-management API surface (read only)

| item | measured |
|---|---|
| `GET /v1/projects/available-regions` for the Pro org | `200`; `specific_count` 17 (17 on 2026-08-20; that run did not record the codes); smart groups `americas,apac,emea`; provider `AWS` |
| specific region codes | `ap-northeast-1,ap-northeast-2,ap-south-1,ap-southeast-1,ap-southeast-2,ca-central-1,eu-central-1,eu-central-2,eu-north-1,eu-west-1,eu-west-2,eu-west-3,sa-east-1,us-east-1,us-east-2,us-west-1,us-west-2` |
| operations in the published OpenAPI document | `169` |
| operations mentioning encryption, KMS, customer-managed or BYO keys | `1`: `PUT /v1/projects/{ref}/pgsodium` |
| operations with "key" in the path | `14`: API keys and auth signing keys only |

No published Management API operation configures storage or database
encryption keys. That is "no published API surface", not "no such option".

### Not measured (SS03 to SS07)

- Repeat runs on self-hosted (n = 1 per variant) and more than two on managed.
- Any region other than ap-southeast-1, any vantage other than one laptop;
  SS03j and the SS03k `ms=` fields are single samples, not throughput.
- Dashboard-generated S3 access keys on managed (no API creates them).
- Objects past 2 GiB; parallel part uploads; TUS with concurrent clients on one URL.
- How long a stale cached copy is served after an overwrite (SS03e), and
  whether purge or a fresh signed URL changes it.
- Self-hosted on Linux amd64; any gateway other than Envoy; the RustFS override.
- Self-hosted file backend on the default bind mount past the failed preflight.
- Whether deleted objects free MinIO space (the MinIO data directory still held
  several GB after the module's deletes; operator note, not measured).
- Contract and certification questions (encryption at rest, BAA, SLA).

### Cleanup

Four managed projects were created (runs 1 to 4). Runs 1, 2 and 4 deleted
theirs in `finally` (teardown DELETE 200, `teardown_delete_status`). Run 3 lost
DNS resolution for api.supabase.com at the end and its teardown returned -1;
`make sweep` printed nothing at that point because the sweep's own request had
failed silently, and a direct `GET /v1/projects` then listed the run 3 project,
which was deleted by hand (DELETE 200). Two fixes followed: `teardown` in
`lib.ts` retries thrown errors for about 10 minutes, and `make sweep` fails
when the API call fails and prints a count. After run 4: `sweep: 0 ss-
projects` (10:58 UTC). Operator notes; the sweep output is not an artifact. Each self-hosted stack was removed with `make clean` in
self-hosted-defaults before the next variant and after the last. The fixtures
in `evidence/fixtures/` were deleted with `make clean-fixtures`.
