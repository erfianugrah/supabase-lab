# storage-surface

Storage platform behaviours, measured on throwaway Pro-org projects
(ap-southeast-1) and, for SS03 to SS06, also on the local self-hosted stack:
the direct-SQL delete guard and what a SQL delete leaves behind, cursor versus
offset listing, the S3 endpoint's handling of special-character object keys,
and the S3 / TUS contract on large and client-side encrypted objects, managed
against self-hosted.

Self-provisioning: each module creates a project named
`ss-<tag>-<epoch>` through the Management API and deletes it in
`finally`. No OpenTofu state. Sources for the claims under test are public
(https://supabase.com/blog/supabase-storage-performance-security-reliability-updates,
https://supabase.com/docs/guides/storage/management/delete-objects,
https://supabase.com/docs/guides/storage/s3/authentication).

## Modules

| id | question |
|---|---|
| SS01a | `storage.prefixes` present? Which delete triggers exist, at what level? Storage server version, migration count |
| SS01b | `DELETE` on `storage.objects` / `storage.buckets` as `postgres`: refused without `storage.allow_delete_query = 'true'`? Which spellings of the setting count; Management API versus a pooler session; `TRUNCATE` |
| SS01c | With the guard off: does the backing file survive a SQL delete (orphan)? Probe: re-insert the deleted row with its original `version`; controls: API delete, and a re-insert with a different `version` |
| SS01d | List v1 (`limit`/`offset`) versus v2 (cursor) at depth, 100 per page, on 5,000, 25,000 and 100,000 rows; whole-prefix walks; DB-side time of `storage.search` versus `storage.search_v2` |
| SS02a-d | S3 key matrix (40 keys x PUT, HEAD, GET, ListObjectsV2, presigned GET, CopyObject, multipart, DELETE) with AWS SDK v3, on both hosts and on both Bun and Node |
| SS02e | The same keys through REST and supabase-js |
| SS02f | Stored names equal the requested keys |
| SS02g | PUT/GET/HEAD latency baseline |
| SS02h | Wire control: request line the SDK sends and the path its signature covers |
| SS03a-l | S3 contract on a 2 GiB object: multipart ETags and resume across processes, range reads on every read path and host, conditional reads and writes, checksums, CORS, error bodies, gzip-encoded and large objects through the CDN, SSE headers (one module, one target per run) |
| SS04a-d | TUS resumable upload of the same object: chunk sizes, resume after SIGKILL from the stored URL (and on the other host), S3 read of the result, upload URL lifetime, `x-upsert` |
| SS05a-d | A client-side AES-256-GCM object: chunk-aligned range reads decrypt, what `storage.objects` records, image render and content-type sniffing, an RLS policy on REST and on S3 with a user JWT |
| SS06 | SS03-SS05 rows diffed across targets: managed, self-hosted `file` and `s3` (MinIO) backends, and self-hosted with the storage image at the managed version |
| SS07a-b | Read only: the region catalogue for a Pro org; key-management operations in the published Management API OpenAPI document |

## Run

```bash
export PVLAB_ORG_PRO=<slug of a Pro org>
sx SUPABASE_ACCESS_TOKEN -- make probe            # SS01 + SS02 (about 6 min)
sx SUPABASE_ACCESS_TOKEN -- make probe MODS=SS02
sx SUPABASE_ACCESS_TOKEN -- make probe MODS=SS03  # SS03-SS05 rows on a managed project (about 45 min; about 6 GB up and 40 GB down)
sx SUPABASE_ACCESS_TOKEN -- make probe MODS=SS03 ROWS=SS03d,SS03k  # only those rows (setup and the uploads they read still run)
make -C ../self-hosted-defaults clean stack up LAYERS="storage-volume storage-limit"              # sh-file
make probe-sh                                      # the same rows on the self-hosted stack
make -C ../self-hosted-defaults clean stack up LAYERS="s3 minio-hostdir storage-limit"            # sh-s3 (MinIO)
make -C ../self-hosted-defaults clean stack up LAYERS="s3 minio-hostdir storage-limit storage-image" STORAGE_IMAGE_TAG=v1.80.2
# storage-limit raises the hard-coded FILE_SIZE_LIMIT for the 64 MiB and 2 GiB fixtures;
# minio-hostdir keeps MinIO off the small Docker VM volume (RUNLOG, "Self-hosted rig findings")
make ss06 RUNS=out/<date>/run-a.json,out/<date>/run-b.json,...            # SS06 diff
sx SUPABASE_ACCESS_TOKEN -- make probe MODS=SS07  # read only
make clean-fixtures                                # the 2 GiB, 256 MiB and 64 MiB fixtures
make sweep                                         # needs SUPABASE_ACCESS_TOKEN: lists leftovers
make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
```

SS03 picks its target from the run context: with `PVLAB_ENDPOINT_STACK_DIR`
and `PVLAB_ENDPOINT_GW` set (what `make probe-sh` does) it runs against the
self-hosted rig of `experiments/self-hosted-defaults`; otherwise it creates a
project. The canary scripts (`canary/upload.ts`, `canary/battery.ts`) are
given the target on stdin and run under Node, so raw responses are read
without fetch's decompression. Fixtures are generated from fixed seeds into
the gitignored `evidence/fixtures/`.

The harness runs from source here: the AWS SDK v3 is a dependency of this
experiment only (`canary/package.json`), spawned as a child process, so the
compiled registry and the root typecheck do not need it installed.

## Not covered

- Dashboard-generated S3 access keys have no API, so every S3 call uses the
  session-token form of S3 authentication (access key id = project ref, secret
  = anon key, session token = JWT). Same SigV4 code path by reasoning, not
  measured.
- The 30 s `DB_STATEMENT_TIMEOUT` and the vector `PutVector` body limit from the
  same blog post.
- Listings were measured with rows inserted by SQL (no backing objects), from
  one laptop vantage.

Results and caveats: RUNLOG.md.
