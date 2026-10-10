# storage-surface RUNLOG

Chronological record of what was run. Org slugs and project refs are not
recorded; the org class is (a Pro-plan organization). Published artifacts
(refs, hostnames and the vantage address redacted) are in `out/2026-10-10/`;
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
