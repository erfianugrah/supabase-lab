# pg-minor-17-11

What the Postgres minor release that moves hosted projects from 17.6 to 17.11
(and 15.14 to 15.19) changes for four extension behaviours the public
changelog flags as "action may be required"
(https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes),
measured on the public `supabase/postgres` images in local Docker. No managed
project, no PAT, no OpenTofu state.

Method: for each pair, the old image creates a data directory and a fixture,
is stopped, and the new image starts on the same data directory (binaries
replaced, data kept). Every claim is read off query results, with the
sequential scan or a count that does not use the code under test as the
reference. A measured `fail` is recorded, not retried.

## Modules

| id | claim measured |
|---|---|
| PG00 | image inventory: server version, default database locale provider, extension versions, extension library checksums |
| PG01 | pgcrypto `cipher-algo` bf / blowfish / cast5: plaintext in the ciphertext, wrong-key decrypt, behaviour after the minor, `ignore-cipher-failure=1`, a detection scan, re-encryption |
| PG02 | `CREATE OPERATOR ... RESTRICT / JOIN` with a non-built-in estimator as `postgres` and as `supabase_admin`; existing operators; dump and restore |
| PG03 | btree_gist float4 / float8 NaN: stale index, `REINDEX INDEX CONCURRENTLY`, fresh index |
| PG04 | ltree values over about 14,653 labels: comparison, B-tree index, amcheck |
| PG05 | ltree GiST index against the operator for case-insensitive (`@`) matches on non-ASCII labels, before and after the minor and REINDEX |

Each module produces one result per pair (`PG0N-pg17`, `PG0N-pg15`).

## Run

```
make probe                  # all modules, both pairs (about 3 minutes), writes evidence/<ts>/
make probe ONLY=PG03 PGM_PAIRS=17
make facts                  # measurements of the newest run as markdown
make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
make clean                  # remove containers left by a killed run
```

Needs Docker and the four `supabase/postgres` images (about 1.3 GB each,
pinned by digest in `lib/rig.ts`). `make probe` writes a random password to
`.env` (gitignored). Containers listen on 127.0.0.1:45461 only, one at a time.
Each module removes its containers and data volume before returning.

## Results

See RUNLOG.md. One entry of the changelog (ltree case-folding index advice,
PG05) did not reproduce on these images; the others did.
