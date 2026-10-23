# RUNLOG - advisor-coverage

Chronological record of what was run. Org and project identifiers are not
recorded; the org class is (Pro). Each run provisions one throwaway project
through `POST /v1/projects` (ap-southeast-1, no compute add-on requested, so
the platform default size) and deletes it in AV99.

"audit.sql" below is the community file at
https://github.com/EstasDespedido/supabase-audit/blob/f8d15fa4f51a131c1250fb8de32300a7f9f6b22a/audit.sql
(MIT, fetched at run time and checked against a pinned SHA-256; checks 1-11
are byte-identical to the eleven-check first commit 983ac92). "Advisors" means
`GET /v1/projects/{ref}/advisors/security` plus `/performance` with a PAT. The
lint SQL named in the "why" column is supabase/splinter at
https://github.com/supabase/splinter/tree/fccca4b1c4d8b48b8ccd69bd6b30e84adcb92975/lints,
read before the run; which splinter version the hosted endpoint runs is not
visible from outside.

## 2026-10-23 - two runs (vantage: this lab's Mac, over the public internet)

Harness: `make run`, modules AV01, AV02, AV03 and AV99, `--destructive`, lab
commit 661afdf plus the uncommitted tree that adds this experiment. One
project per run, n = 2 projects, one trial per probe per run. Postgres 17.11
on both. Published: run 1 `out/2026-10-23/run-2026-10-23T07-58-18-094Z.json`,
run 2 `out/2026-10-23/run-2026-10-23T08-01-46-405Z.json`, each with a
`.facts.md`.

- Run 1: 1 pass (AV99), 50 info, 0 fail. Run 2 the same.
- `pvlab --diff` run 1 against run 2: 405 measurements unchanged; the three
  that changed are timings (`setting_poll_s` 63 -> 62, `warmup_s` 1 -> 0,
  `gone_from_listing_s` 20 -> 0). Every matrix cell below is the same in both
  runs.
- Both projects were deleted by AV99; `GET /v1/projects` listed no project
  with the `pvlab-av-` prefix afterwards (0 of 18 visible in a `make clean`
  listing after run 2; not in the artifact).

### AV01 - the fresh project, before seeding

| step | measured (run 1; run 2 identical) |
|---|---|
| AV01a audit.sql as `postgres` in `BEGIN TRANSACTION READ ONLY` | no error, 0 rows, 63 ms (run 2: 64 ms) |
| AV01b advisors | security 200, performance 200; 1 lint: `INFO auth_db_connections_absolute` (Auth server capped at 10 connections) |
| AV01c context | `server_version` 17.11; `current_setting('pgrst.db_schemas', true)` as `postgres` unset; no `pgrst.db_schemas` entry in `authenticator`'s role settings; default ACL for functions in `public` (roles `postgres` and `supabase_admin`) grants `X` to `anon`, `authenticated` and `service_role` by name |

Neither side reports anything about the user's schema on a fresh project.
The audit's read-only claim held: the file ran inside a READ ONLY
transaction without error on both projects.

### AV02 - 36 seeded fixtures

Seeding: 36 of 36 fixtures without an error. `PATCH /v1/projects/{ref}/postgrest`
with `db_schema` `public,graphql_public,av_api` answered 200. After it,
`pgrst.db_schemas` was still unset as `postgres` and absent from
`authenticator`'s role settings at the end of a 63 s poll (run 2: 62 s).
audit.sql after seeding: no error, 30 rows, 67 ms (run 2: 100 ms). Advisors: 41 lints. The
first advisor poll came after the 63 s setting poll, a 10 s wait and the
audit, so more than a minute after the last fixture; it already listed seeded
objects, and the second, 30 s later, matched it (`settled_s` 31). How soon
after a schema change the endpoint reflects it was not measured.

Cell = whether the check(s) or lint(s) for that category fired on that
object. Other findings on the same object are listed but do not decide the
cell. "Predicted" is what reading the two SQL sources said before the run.

| fixture | seeded issue | audit check | observed | audit finding | advisor finding | other findings on the object |
|---|---|---|---|---|---|---|
| F01 | table in `public`, RLS off, granted to anon | 1 | both | CRITICAL RLS disabled | ERROR rls_disabled_in_public | - |
| F02 | RLS off, anon reads it only through a grant to PUBLIC | 1 | advisors only | - | ERROR rls_disabled_in_public | - |
| F03 | RLS off, in a second exposed schema `av_api` | 1 | advisors only | - | ERROR rls_disabled_in_public | - |
| F04 | RLS on, zero policies | 2 | both | HIGH RLS on, zero policies | INFO rls_enabled_no_policy | - |
| F05 | SELECT policy `USING (true)` for anon | 3 | tool only | CRITICAL Policy open to anon | - | - |
| F06 | UPDATE policy `USING (true) WITH CHECK (true)` for authenticated | 3 | neither (predicted advisors only) | - | - | - |
| F07 | DELETE policy `USING (true)` for anon | 3 | tool only (predicted both) | CRITICAL Policy open to anon | - | - |
| F08 | SECURITY DEFINER in `public`, default privileges, search_path pinned | 4 | both | CRITICAL SECURITY DEFINER open to PUBLIC | WARN anon_security_definer_function_executable; WARN authenticated_security_definer_function_executable | - |
| F09 | F08 after the audit's own fix, `REVOKE EXECUTE ... FROM PUBLIC`, and nothing else | 4 | advisors only | - | WARN anon_security_definer_function_executable; WARN authenticated_security_definer_function_executable | - |
| F10 | SECURITY DEFINER open to PUBLIC in an unexposed schema `av_private` | 4 | tool only | CRITICAL SECURITY DEFINER open to PUBLIC | - | - |
| F11 | SECURITY DEFINER without a pinned search_path | 5 | both | HIGH SECURITY DEFINER without search_path | WARN function_search_path_mutable | - |
| F12 | SECURITY INVOKER without a pinned search_path | 5 | advisors only | - | WARN function_search_path_mutable | - |
| F13 | view without `security_invoker`, granted to anon | 6 | both | REVIEW View runs as owner | ERROR security_definer_view | - |
| F14 | view over `auth.users` granted to anon | - | advisors only | - | ERROR auth_users_exposed | audit: REVIEW View runs as owner; advisors: ERROR security_definer_view |
| F15 | column `password`, RLS off | 7 | tool only (predicted both) | HIGH Secret-shaped column exposed | - | audit: CRITICAL RLS disabled; advisors: ERROR rls_disabled_in_public |
| F16 | column `stripe_api_key`, RLS off | 7 | tool only | HIGH Secret-shaped column exposed | - | same as F15 |
| F17 | column `api_key`, RLS on with an owner policy | 7 | tool only | HIGH Secret-shaped column exposed | - | - |
| F18 | column `ssn`, RLS off | 7 | neither (predicted advisors only) | - | - | same as F15 |
| F19 | policy calls `auth.uid()` unwrapped | 8 | both | PERFORMANCE auth.uid() re-evaluated per row | WARN auth_rls_initplan | - |
| F20 | policy calls `current_setting()` unwrapped | 8 | advisors only | - | WARN auth_rls_initplan | - |
| F21 | policy with one wrapped and one unwrapped `auth.uid()` | 8 | neither | - | - | - |
| F22 | control: `(select auth.uid())` only | 8 | neither | - | - | - |
| F23 | policy that queries its own table | 9 | tool only | HIGH Possible policy recursion | - | - |
| F24 | single-column foreign key, no index | 10 | both | PERFORMANCE Foreign key without index | INFO unindexed_foreign_keys | both: RLS on, zero policies |
| F25 | foreign key (a, b), index on (a) only | 10 | advisors only | - | INFO unindexed_foreign_keys | both: RLS on, zero policies; advisors: INFO unused_index |
| F26 | `pg_trgm` installed in `public` | 11 | both | REVIEW Extension installed in public | WARN extension_in_public | - |
| F27 | INSERT policy for anon, no SELECT policy | 12 | tool only | HIGH INSERT policy with no SELECT policy | - | audit: CRITICAL Policy open to anon |
| F28 | no primary key | - | advisors only | - | INFO no_primary_key | both: RLS on, zero policies |
| F29 | two identical indexes | - | advisors only | - | WARN duplicate_index | both: RLS on, zero policies; advisors: INFO unused_index |
| F30 | an unused index | - | advisors only | - | INFO unused_index | both: RLS on, zero policies |
| F31 | two permissive SELECT policies for one role | - | advisors only | - | WARN multiple_permissive_policies | - |
| F32 | policy exists, RLS disabled | - | advisors only | - | ERROR policy_exists_rls_disabled | audit: CRITICAL RLS disabled; advisors: ERROR rls_disabled_in_public |
| F33 | policy reads `user_metadata` from the JWT | - | advisors only | - | ERROR rls_references_user_metadata | - |
| F34 | materialized view granted to anon | - | advisors only | - | WARN materialized_view_in_api | - |
| F35 | table with `autovacuum_enabled = false` | - | neither (predicted advisors only) | - | - | both: RLS on, zero policies |
| F36 | public Storage bucket with an anon listing policy | - | neither (predicted advisors only) | - | - | - |

Totals (AV02, both runs): both 8, tool only 8, advisors only 14, neither 6
of 36; predictions hit 30 of 36. The full advisor lint list and every audit
row are in each run's AV02a and AV02b evidence.

### AV03 - anon through the Data API on the disagreements

Legacy anon key, one request each, run 1 (run 2 identical):

| step | measured |
|---|---|
| AV03a F02 `GET /rest/v1/av_f02_rls_off_public_grant` | 200 `[{"id":1,"note":"seeded"}]` |
| AV03b F08 `POST /rest/v1/rpc/av_f08_definer_default` (control) | 200 `1` |
| AV03b F09 `POST /rest/v1/rpc/av_f09_definer_revoked_public` | 200 `9` |
| AV03c F10 RPC with `Content-Profile: av_private` | 406 `PGRST106` `Invalid schema: av_private`, hint `Only the following schemas are exposed: public, graphql_public, av_api` |
| AV03d F27 insert, `Prefer: return=representation` | 401 `42501` `new row violates row-level security policy for table "av_f27_insert_only"` |
| AV03d F27 insert, `Prefer: return=minimal` | 201, empty body |
| AV03e F03 `GET /rest/v1/av_f03_rls_off_api` with `Accept-Profile: av_api` | 200 `[{"id":1,"note":"seeded"}]` |

What the runs separate:

- **The audit's fix for check 4 left the function callable by anon.** The
  project's default privileges grant EXECUTE on new functions in `public` to
  `anon` and `authenticated` by name (AV01c), so after `REVOKE EXECUTE ...
  FROM PUBLIC` anon still held EXECUTE (AV02s `f09_anon_execute` true, proacl
  `postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres`)
  and the anon RPC answered 200 (AV03b). audit.sql reported nothing for F09;
  the advisors flagged it for both roles.
- **audit.sql missed two tables anon could read.** Check 1 reads direct grants
  to `anon`/`authenticated` in `public` only: F02 (readable through PUBLIC)
  and F03 (in a second exposed schema) answered anon reads with the seeded
  row, and only the advisors flagged them.
- **The advisors found the second exposed schema without the GUC splinter
  reads.** `pgrst.db_schemas` stayed unset as `postgres` and on
  `authenticator`, and F03 was still flagged; how the hosted runner learns
  the exposed schemas is not visible from SQL (inference: it sets the value
  itself from the PostgREST config).
- **audit.sql flagged one function anon could not reach.** F10 is open to
  PUBLIC, but its schema is not exposed and the RPC answered 406 PGRST106.
  It would also need anon USAGE on `av_private` (not granted here) before
  exposing the schema made it callable; not probed.
- **Check 12's claim held.** With an INSERT policy and no SELECT policy, the
  insert asking for the row back failed with 42501 and the same insert
  without it succeeded (AV03d). The advisors have no equivalent.
- **audit.sql check 3 flagged a restrictive INSERT policy as open.** F27's
  policy is `WITH CHECK (body is not null)`; check 3 looks at `USING` only,
  an INSERT policy has none, and the null is coalesced to `true`, so it was
  reported as CRITICAL "Policy open to anon". Read from the SQL and observed
  in AV02a; not a fixture of its own.
- **Four lints in the splinter source were not returned by the endpoint on
  either project.** `rls_policy_always_true` (F06, F07),
  `sensitive_columns_exposed` (F15, F18), `autovacuum_disabled` (F35) and
  `public_bucket_allows_listing` (F36) did not appear, while
  `anon_security_definer_function_executable` and
  `authenticated_security_definer_function_executable`, added to splinter
  after three of those four, did. Dates from the splinter git history
  (read 2026-10-23): 0023 and 0024 on 2026-01-06, 0025 on 2026-04-13, 0028
  on 2026-04-27, 0030 on 2026-09-04. The v1 OpenAPI spec (read 2026-10-23)
  marks `/advisors/security` experimental and its lint-name enum lists none
  of these six. Whether the dashboard's advisor pages show the four was not
  checked. Those four lints account for the six missed predictions.
- **Severity differs on shared findings.** "RLS on, zero policies" is HIGH in
  the audit and INFO in the advisors; an owner-rights view is REVIEW in the
  audit and ERROR (`security_definer_view`) in the advisors; the view over
  `auth.users` is REVIEW in the audit and ERROR `auth_users_exposed` in the
  advisors.

Not measured:

- The Studio dashboard's advisor pages, and `?lint_type=sql` on the security
  endpoint.
- Audit checks 8 and 9 under load (whether the flagged policies are slow or
  recurse at query time); the matrix is about detection only.
- The heuristic false positives the audit README names for check 9 (a policy
  that mentions its own table name without querying it) and check 10 (an
  unusual composite index).
- pg_graphql exposure lints (0026, 0027), foreign tables in the API (0017),
  and the Auth and platform-config lints (only `auth_db_connections_absolute`
  appeared, on both projects).
- A project with the 2026 default that stops auto-granting new tables and
  functions to anon; on these projects the function default ACL still
  granted anon EXECUTE, which is what made F09 callable.
