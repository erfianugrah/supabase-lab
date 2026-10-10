# storage-surface

Three Storage platform behaviours, measured on throwaway Pro-org projects
(ap-southeast-1): the direct-SQL delete guard and what a SQL delete leaves
behind, cursor versus offset listing, and the S3 endpoint's handling of
special-character object keys.

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

## Run

```bash
export PVLAB_ORG_PRO=<slug of a Pro org>
sx SUPABASE_ACCESS_TOKEN -- make probe            # SS01 + SS02 (about 6 min)
sx SUPABASE_ACCESS_TOKEN -- make probe MODS=SS02
make sweep                                         # needs SUPABASE_ACCESS_TOKEN: lists leftovers
make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
```

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
