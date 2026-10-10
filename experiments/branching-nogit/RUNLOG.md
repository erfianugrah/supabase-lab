# branching-nogit RUNLOG

Chronological record of what was run. Vantage: a laptop on the public
internet calling the Management API (`api.supabase.com/v1`); a Pro-plan
organization, region ap-southeast-1, Postgres 17 branches. Org slugs and
project refs are not recorded (the published artifacts in `out/2026-10-10/`
are redacted by `publish-evidence`). Source files: `lib/scenario.ts` and
`tests/bn0*.ts`.

## What the docs claim (not measured by this run)

- Blog, 2026-05-04: https://supabase.com/blog/branching-without-git-is-now-the-default
  - "Every schema change you make in the SQL Editor or Table Editor is tracked."
  - Merge generates a migration diff, shows it for review, then applies the
    schema changes to production. The diff is made by pg-delta, which the
    post calls alpha software.
- Dashboard branching guide: https://supabase.com/docs/guides/deployment/branching/dashboard
  - A merge request is created before a merge.
  - Production data is not copied to a branch by default.
  - "Branches can only be merged to main."
- Management API OpenAPI (https://api.supabase.com/api/v1-json, read
  2026-10-10): `GET /v1/branches/{branch_id_or_ref}/diff` is marked Beta and
  takes a `pgdelta` query parameter ("Use pg-delta instead of Migra for
  diffing when true"); `POST .../merge` takes an optional `migration_version`.
- MCP server tool description (as served to the client, 2026-10-10):
  `merge_branch` "Merges migrations and edge functions from a development
  branch to production".

## 2026-10-10 - exploration by hand (n = 1, not harness runs)

One parent project and branch `A`, created with `POST /projects/{ref}/branches`
(`with_data: false`, no `git_branch`), curl against the Management API. These
observations shaped the modules; each is one trial.

- Branch create answered 201 in 1 s. `GET /branches/{branch_ref}` read
  `ACTIVE_HEALTHY` on the first poll.
- `GET /projects/{branch_ref}` answers 404 `Project not found`, while
  `POST /projects/{branch_ref}/database/query` answers 201 on the branch.
- A table written on the parent through `/database/query` before the branch
  existed was not on the branch when it first read healthy, and a `GET /diff`
  taken at that moment (default and `pgdelta=true`) contained
  `drop table "public"."bn_base"`: a diff taken before the branch has the
  parent's schema proposes dropping the parent's table. After the branch's
  workflow run showed `migrate` and `pull` EXITED the table was present and
  the drop was gone from the diff.
- First merge (branch changes written only through `/database/query`): the
  parent had none of them 80 s later. The parent's
  `supabase_migrations.schema_migrations` table, which a read during the
  branch's workflow had not found, existed after that merge.
- A second change set applied to the same branch with
  `POST /projects/{branch_ref}/database/migrations` (name `bn_m_change`), then
  `POST /merge` again: that set (table, policy, function) was absent at the 10,
  20 and 30 s polls and present at the 40 s poll, with a `bn_m_change`
  history row; the earlier `/database/query` set was still absent.
- Same shape through the MCP connector on a second branch of that parent:
  `execute_sql` on the branch (table, RLS, policy, grant, function), then
  `apply_migration` for a second set, then `merge_branch`. On the parent the
  `execute_sql` set was absent and the `apply_migration` set present (table,
  policy, function; history row `bn_y_change` added). The first `create_branch`
  call returned `Invalid or expired requestState`; the retry succeeded and
  `list_branches` showed one such branch, not two.
- The exploration parent and both its branches were deleted afterwards.

## 2026-10-10 - BN01, BN02, BN03 (two runs of each, harness)

Run 3 (06:35 UTC) and run 4 (07:00 UTC), three modules in parallel, each with
its own parent project and one non-persistent branch. Artifacts (redacted):
`out/2026-10-10/run-2026-10-10T06-35-40-367Z-run3-bn0{1,2,3}.json` and
`run-2026-10-10T07-00-11-764Z-run4-bn0{1,2,3}.json`, each with a `.facts.md`.
Two earlier harness attempts of BN01 (about 28 min and 4 min) were stopped
and left no artifact: the first by its background-task time limit (the module
had no progress logging and over-ran), the second killed by hand because
`classifyBody` flagged the 200 body of `GET /diff` as throttled and the call
wrapper kept retrying (fixed in `lib/scenario.ts`; the cause of the flag was
not investigated). Their projects were deleted by hand.

Probe note, run 3: the probe waited for the branch workflow's `pull` step to
read `EXITED` before writing. In run 3 that read happened while `migrate` read
`CREATED` and the baseline table was not yet on the branch, so BN01 wrote 5 of
7 statements (the column and index on the baseline table failed with 42P01).
Run 4 polls for the baseline table itself. The `workflow_steps_at_last_read`
cell of BN03 in run 4 still reads `migrate=CREATED` with the baseline present,
so the step list is not a completion signal.

### Measured

Change set per object prefix: table with an identity key, `enable row level
security`, a `select` policy to `authenticated`, `revoke all` from `anon` and
`authenticated` followed by `grant select` to `authenticated`, an immutable
SQL function, and a column plus an index on a baseline table the parent holds.
Presence on the parent was read from `pg_class`, `pg_policies`, `aclexplode`,
`pg_proc`, `information_schema.columns` and `pg_indexes`.

| question | value | module, run |
|---|---|---|
| Branch create (`POST /projects/{ref}/branches`) | 201 in 0.9 to 1.7 s across the six runs (`create_ms` in the facts files); `persistent` false, `with_data` false | BN01b-BN03b, runs 3 and 4 |
| Branch reads `ACTIVE_HEALTHY` | 1-2 s after the create call | BN01b-BN03b, runs 3 and 4 |
| Parent's baseline table on the branch at that moment | absent in all six runs | BN01b-BN03b |
| Baseline table first seen on the branch | 53 s (BN01), 44 s (BN02), 43 s (BN03), run 4 | BN01b-BN03b |
| Parent's migration history before branching | 0 rows | BN01a-BN03a |
| History on parent and branch after the baseline arrives | one row, `remote_schema`, on both | BN01b, run 4 |
| Writes on the branch through `POST /projects/{branch_ref}/database/query` | run 4: 7 of 7 accepted (201) in BN01, BN02, BN03, and the branch held the complete set; run 3: 7 of 7 for BN02 and BN03, 5 of 7 for BN01 (probe timing, above) | BN01c-BN03c |
| Branch migration history after `/database/query` writes | unchanged (`remote_schema` only) | BN01c, BN03c |
| Branch migration history after `POST .../database/migrations` | `remote_schema`, `bn_m_change` | BN02c |
| Parent holds any of the change before merge | 0 in all six runs (isolation) | BN01c-BN03c |
| `GET /diff` default vs `?pgdelta=false` | identical text in all six runs; `?pgdelta=true` differs (1137 vs 1430 chars in BN01 run 4) | BN01d-BN03d |
| Objects the diff mentions (table, policy, function, column, index, revoke or grant) | all of them in default, `pgdelta=true` and `pgdelta=false`, for the `/database/query` set and, in BN02, the migrations set | BN01d-BN03d |
| Diff also proposes the `pg_net` extension (on the branch, absent on the parent) | yes, all variants, all runs | BN01d-BN03d |
| `POST /branches/{ref}/merge` | 201, body `{workflow_run_id, message: "ok"}` in all six runs | BN01e-BN03e |
| `/database/query` set on the parent after merge (table, RLS, policy, privileges, function, column, index) | none present; polled 246 s (BN01 run 4), 245 s (BN01 run 3), 246 s (BN03 run 4), 258 s (BN03 run 3) | BN01e, BN03e |
| Same with `PATCH /branches/{ref} {request_review: true}` first | PATCH 200, `review_requested_at` set on the parent's branch list; merge outcome as above | BN03c, BN03e |
| Migrations-endpoint set in the same branch and merge | complete on the parent (table, RLS on, policy, `SELECT` only for `authenticated`, none for `anon`, function, column, index), first seen at the 42 s poll (run 4) and 56 s (run 3); `bn_m_change` row added to the parent's history | BN02e |
| `/database/query` set in that same merge | absent when the poll ended, 73 s (run 4) and 87 s (run 3) | BN02e |
| `pg_net` on the parent after any merge | not installed (0) | BN01e-BN03e |
| Merge workflow run steps at end of window | `clone, deploy, health, migrate, pull, seed` EXITED, `configure` PAUSED | BN01e-BN03e |
| Teardown | branch DELETE 200, gone from the parent's list at the first read; parent DELETE 200; 0 refs left in `GET /projects` | BN01f-BN03f |

Reading: in these runs the merge applied the rows of the branch's migration
history that the parent lacked, and ignored the rest of the schema difference
that `GET /diff` listed. A change written through the Management API's SQL
route is not in that history. MS15's 201-and-nothing is the same outcome after
a `prisma db push`, where the branch history held only the baseline row
(inference from the matching outcome; the Prisma path was not re-run).

### Not measured

- The dashboard's own SQL Editor and Table Editor. A PAT cannot call the
  dashboard routes (BA06), so whether Studio records a migration row for a
  change made there, which is what the blog's "tracked" would need, is
  unknown. The result above is for the Management API route (BN01-BN03) and,
  once by hand, the MCP `execute_sql` tool. It does not show that the
  dashboard path behaves the same, nor that it differs.
- The dashboard merge-request screen and its review step; only the API
  `request_review` flag was tested (BN03).
- The `migration_version` field of the merge body.
- Whether `GET /diff` content is what the dashboard shows for review (the
  dashboard was not opened).
- A change that arrives after a merge, merging twice, a branch whose history
  conflicts with the parent's, persistent branches, `with_data: true`, edge
  functions, a parent that already has migration files.
- The MS15 `prisma db push` itself was not re-run here.
- Billing: branch and parent hours were short (a few minutes each; one parent
  about 28 min). Spend was not read from an invoice; by arithmetic on
  durations it is well under 1 USD.

### Resources created and deleted

Nine parent projects in the Pro org, each named `bn-...`, and eleven
branches (two on the exploration parent, one on each other). All were deleted
in the run's `finally` or by hand after the two stopped attempts;
`GET /projects` after run 4 listed no project with that prefix (2026-10-10,
15:07 +08).
