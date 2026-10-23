# advisor-coverage

Which schema problems the built-in advisors (`GET /v1/projects/{ref}/advisors/security`
and `/performance`) report, against a community single-file audit that runs
in the SQL Editor: supabase-audit, `audit.sql` at
https://github.com/EstasDespedido/supabase-audit/blob/f8d15fa4f51a131c1250fb8de32300a7f9f6b22a/audit.sql
(MIT; the repository was first published as `Concepto505/supabase-audit` and
GitHub redirects the old name). The file is one `WITH ... SELECT` over the
system catalogs. Its first commit (983ac92, 2026-09-20) has eleven checks;
f8d15fa, the last commit that touched the file, adds a twelfth (an INSERT
policy with no SELECT policy) and leaves checks 1-11 byte-identical. The run
uses f8d15fa.

The file is not vendored. `lib/audit.ts` fetches it from
raw.githubusercontent.com at that commit and refuses to run it unless its
SHA-256 matches the pinned value.

One fresh project. Seed one deliberate issue per fixture, each on an object
with a unique name, run both, and classify each fixture: caught by both, the
audit only, the advisors only, or neither. Where the two disagree on an
exposure, an anon request through the Data API settles which one is right.

Self-provisioning: AV01-AV03 share one Pro-org project (ap-southeast-1)
created on first use through `data-api-defaults/lib/project.ts`; AV99
deletes it. No OpenTofu state.

## Modules

| id | what it measures |
|---|---|
| AV01 | the fresh project before seeding: audit.sql rows (as `postgres`, inside `BEGIN TRANSACTION READ ONLY` over a session-mode pooler connection), advisor lints, Postgres version, `pgrst.db_schemas` as `postgres` and on `authenticator`, the function default ACL in `public` |
| AV02 | 36 fixtures from `lib/fixtures.ts` seeded, `av_api` added to the Data API's exposed schemas, audit.sql re-run read-only, the advisors polled every 30 s until two answers match; one row per fixture with the observed and predicted cell, the findings that decided it and any incidental ones |
| AV03 | anon through the Data API on the disagreements: F02 table readable only through PUBLIC, F08/F09 RPC before and after the audit's REVOKE, F10 RPC into an unexposed schema, F27 insert with and without `return=representation`, F03 read in the second exposed schema |
| AV99 | teardown |

The `predicted` column was written from the two sources before the run
(audit.sql at f8d15fa, supabase/splinter lint SQL at fccca4b), so a miss is a
place where reading the SQL was not enough.

## Run

```bash
export SUPABASE_ACCESS_TOKEN=...            # Management API token
export PVLAB_ORG_PRO=<pro-org-slug> PVLAB_ORG_SLUGS=<pro-org-slug>
make run                                    # AV01-AV03 then AV99, artifacts in evidence/<ts>/
make unit                                   # matcher unit tests, offline
make clean                                  # list leftover pvlab-av- projects; DELETE=1 deletes
```
