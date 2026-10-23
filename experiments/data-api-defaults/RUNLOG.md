# RUNLOG - data-api-defaults

Chronological record of what was run. Org and project identifiers are not
recorded; the org class is (Pro). Each run provisions one throwaway project
through `POST /v1/projects` (ap-southeast-1, no compute add-on requested, so
the platform default size) and deletes it in DD99. "Docs" below means the
public notice cited in the module header; "measured" means the artifact.

## 2026-10-10 - two runs (vantage: this lab's Mac, over the public internet)

Harness: `make run`, modules DD01-DD04 and DD99, `--destructive`, lab commit
d8a16df plus the uncommitted tree that adds this experiment. n = 1 project per
run, one trial per probe. Postgres 17.11 on both projects. Published
(redacted, recovered from a session scratchpad on 2026-10-13): run 1
`out/2026-10-09/run-2026-10-09T23-58-24-538Z.json` (UTC start date), run 2
`out/2026-10-10/run-2026-10-10T00-00-27-688Z.json`, each with a `.facts.md`.

- Run 1: 9 pass, 2 fail. The two fails were probe bugs, not platform
  behaviour: DD02c and DD02d matched `Unknown field "__schema"` against the
  raw JSON body, where the quotes are escaped, so they could not match. Fixed
  to match the parsed `errors[].message`. Run 1 also left the public schema
  comment set to the DD02d `"introspection": false` value, which showed up as
  the OpenAPI spec title in DD04; DD02 now restores the original comment.
- Run 2: 11 pass, 0 fail. All figures below are run 2 unless stated. DD01,
  DD03 and DD04 measurements in run 1 equal run 2 apart from the spec title
  just described and the DD01 and DD03 fields added between the runs
  (`anon_privs_in_tables_acl*`, `tr_check_filters_exists_before`).
- Both projects were deleted by DD99; `GET /v1/projects` listed no project
  with this run's name prefix afterwards.

### DD01 - Data API default privileges

Docs (discussion 45329, 2026-04-28): new tables in `public` are not exposed
unless granted; opt-in at project creation from 2026-04-28, default for new
projects from 2026-05-30, enforced on existing projects 2026-10-30. Recalled,
not quoted from the notice: that the dashboard's "Automatically expose new
tables" checkbox runs the two `ALTER DEFAULT PRIVILEGES ... REVOKE` statements
used here (the probe's own wording of them), and that the hint format matches
the notice's example (the measured hint is below).

Measured on a project created 2026-10-10 through the Management API:

| step | measured |
|---|---|
| DD01a `pg_default_acl`, schema `public`, role `postgres`, tables | `anon`, `authenticated`, `service_role` each `arwdDxtm`; sequences `rwU`; functions `X`. Same for role `supabase_admin`. |
| DD01b table made in SQL, anon GET | 200 `[{"id":1}]` after 2 s (schema-cache wait); publishable key 200 |
| DD01c after the notice's two `ALTER DEFAULT PRIVILEGES ... REVOKE` statements (tables, sequences), new table | default ACL for `anon`, `authenticated`, `service_role` becomes `Dxtm` (the statements name select, insert, update, delete, so TRUNCATE, REFERENCES, TRIGGER and MAINTAIN stay) |
| DD01c anon GET on the new table | HTTP 401, code `42501`, message `permission denied for table dd01_revoked`, hint `Grant the required privileges to the current role with: GRANT SELECT ON public.dd01_revoked TO anon;` |
| DD01c publishable key | HTTP 401, 42501, hint names `TO anon` |
| DD01c legacy service_role JWT and sb_secret_ key | HTTP 403, 42501, hint names `TO service_role` |
| DD01d `GRANT SELECT ... TO anon`, anon GET | 200 `[{"id":1}]`, no wait needed; table ACL for anon `rDxtm`; publishable 200; service_role still 403 |

What this separates. The docs describe the dashboard creation path. A project
created through `POST /v1/projects` on 2026-10-10 still has the legacy grants.
Two readings: the 2026-05-30 default does not reach API-created projects, or
the gradual rollout had not reached this project when it was created. The run
cannot separate them. The v1 OpenAPI create-project body (read from
api.supabase.com on 2026-10-10) carries no field for the setting. After the
opt-in statements the 42501 shape and hint match the notice's example. The
401 for anon and publishable versus 403 for service_role and sb_secret_ is not
in the notice.

Not measured:

- The standing-project re-run on or after 2026-10-30. Whether the enforcement
  applies the same revoke to existing projects, and what a project created
  before 2026-05-30 shows before and after that date, is not tested. As of
  2026-10-10 this API-created project is, for tables made in SQL, in the
  pre-flip state, as S21 recorded on 2026-09-03.
- A dashboard-created project, with the checkbox in either state.
- Functions: the default ACL row for functions was read, but no RPC was called.
- `iap-lockdown` L08 measured the same revoke earlier (L08c); not re-run.
  iap-lockdown's fixture grants SELECT explicitly (`seedFixture`), so it does
  not depend on the default ACL.

### DD02 - pg_graphql

Docs (discussion 42180, announced 2026-01-26: pg_graphql disabled by default
on new projects, roughly three weeks out per the post; discussion 46320: pg_graphql 1.6.0 introspection off for
projects created from 2026-06-29; the `comment on schema ... @graphql({"introspection": true})`
opt-in).

| step | measured |
|---|---|
| DD02a fresh project | `pg_extension` has no `pg_graphql`; `pg_available_extensions` offers 1.6.2; `graphql_public.graphql` exists; POST `/graphql/v1` `{ __typename }` with the anon key: HTTP 200, `errors: pg_graphql extension is not enabled.` The old probe `{ __schema ... }` gets the identical answer. |
| DD02b `create extension pg_graphql` | installed 1.6.2; endpoint served `{ __typename }` at the first poll (`seconds_to_serve_typename` 0; `total_ms` 625 for the statement and the poll) |
| DD02c enabled, no opt-in | `__schema`: HTTP 200, `Unknown field "__schema" on type Query`; `__type`: HTTP 200, `Unknown field "__type" on type Query`; `{ __typename }`: `{"__typename":"Query"}`; a collection query on a table anon can read returns its row |
| DD02d `comment on schema public is e'@graphql({"introspection": true})'` | `__schema` returns `queryType.name` `Query` and `__type` returns data, at the first poll; setting `"introspection": false` refused `__schema` again at the first poll |
| DD02e iap-lockdown probe row, `{ __typename }` | absent: `200 pg_graphql extension is not enabled.`; enabled: `200 ok:Query`; opt-in: `200 ok:Query` |
| DD02e old probe `{ __schema ... }` | absent: `200 pg_graphql extension is not enabled.`; enabled, no opt-in: `200 Unknown field "__schema" on type Query`; opt-in: `200` with data and an empty code |

The old probe reads HTTP 200 in all three states, so a 200 on it meant
nothing on a project created after 2026-06-29. The fix (in
`experiments/iap-lockdown/lib/inventory.ts`): the probe query is
`{ __typename }`, and `http()` now puts `errors[0].message` or `ok:<type>`
in the row's code, so the inventory distinguishes absent, enabled and
refused-field answers. `l02-data-api-levers.ts` L02c uses the same query for
its wait (it still waits on a non-200 status, which the platform returns when
`graphql_public` leaves `db_schema`).

Not measured: the fixed probe inside L02 and L01 themselves (they need the
iap-lockdown project; only the probe function was exercised, in DD02e); a
project created before 2026-06-29 with pg_graphql on and then upgraded to
1.6.0.

### DD03 - lockdowns met by the postgres role

Docs: changelog `extension-version-pinning-ignored` (from 2026-08-05) and
`realtime-schema-locked-down-against-modification` (2026-07-14, Realtime
v2.112.7). Both vantages were the `postgres` role with `is_superuser` off:
the Management API query endpoint and a session-mode pooler connection (the
pooler connection surfaces NOTICE and WARNING text; the query endpoint
returned `[]` for a `CREATE EXTENSION ... VERSION` that warned).

Extension versions (citext, default 1.6):

| statement | measured |
|---|---|
| `create extension citext version '1.5'` and `'9.9'` | succeeds; WARNING `only superusers can specify extension versions, ignoring version "1.5" and installing the default version` (same text with "9.9"); `extversion` 1.6 both times, so an unavailable version is ignored too |
| `alter extension citext update`, `update to '1.4'`, `update to '1.6'`, `update to '9.9'` | every form fails on both vantages with `XX000 pgaudit stack is not empty`; the pooler session also printed the NOTICE `version "1.6" of extension "citext" is already installed` and, for the `to` forms, the WARNING `... ignoring version "<v>" and updating to the default version`; `extversion` stays 1.6 |
| control `alter extension citext set schema public` | succeeds (201) |

The changelog says the update form warns and proceeds. Measured, the warning
and the NOTICE appear and the statement then errors. Two readings: the error
comes from the no-op path when installed equals default, or from every
`ALTER EXTENSION ... UPDATE` on a project running pgaudit. The run cannot
separate them: a version pin is ignored at create, so no older installed
version was available to update from. Not measured.

Realtime schema, ten operations (eight follow the changelog's list, reading
"create objects" as create table and create function; UPDATE and ALTER on
`realtime.schema_migrations` are the probe's own additions), each run inside
`begin; ...; rollback;` and checked afterwards (89 rows in
`realtime.schema_migrations` before and after, no probe row, no
`realtime.dd_probe`, `messages.topic` and `realtime.topic()` still present):

| operation | measured (query endpoint; the pooler session matched where tried) |
|---|---|
| `create table realtime.dd_probe`; `create function realtime.dd_fn` | refused, `42501 permission denied for schema realtime` |
| `alter table realtime.messages drop column topic`; `drop table realtime.messages`; `drop function realtime.topic()` | refused, `42501 must be owner of table messages` / `must be owner of function realtime.topic` (a different text from the changelog's, which gives `permission denied for schema realtime` for the blocked operations) |
| `alter table realtime.schema_migrations add column ...` | refused, `42501 must be owner of table schema_migrations` |
| `insert`, `update`, `delete` on `realtime.schema_migrations` | ALLOWED (201), on both vantages; the table ACL gives `postgres` `arwdDxtm`, owner `supabase_admin` |
| `drop trigger tr_check_filters on realtime.subscription` | ALLOWED (201); the trigger existed before |
| control: policy create, list, drop on `realtime.messages` | all succeed |

Six of ten refused, four allowed (the UPDATE allowance is outside the
changelog's list; the other three allowed are INSERT, DELETE and the trigger
drop). The changelog lists
`INSERT` or `DELETE` on `realtime.schema_migrations` and the trigger drop as
refused with `permission denied for schema realtime`. On this project they were
accepted. Readings: the lockdown is delivered per Realtime service version
and this project's Realtime was below 2.112.7 or had not applied it; or the
lockdown covers the other six operations only. Not separated: the project's
Realtime service version was not read, and the latest `schema_migrations`
version is 20261002120000.

Not measured: the Realtime version; a persisted (not rolled-back) write; any
effect of an accepted `schema_migrations` write on Realtime.

### DD04 - OpenAPI spec key matrix

Docs (discussion 42949; anon refused from 2026-03-11 for new projects and
2026-04-08 for existing ones): the notice gives the body
`{"message":"Access to schema is forbidden","hint":"Accessing the schema via the Data API is only allowed using a secret API key."}`
for anon; service_role and sb_secret_ keys unchanged; a Management API
endpoint replaces the route.

`GET /rest/v1/`, key sent as apikey plus Authorization, and as apikey alone
(identical statuses and bodies both ways):

| key | measured |
|---|---|
| none | 401 `No API key found in request` |
| anon (legacy JWT) | 401 `{"message":"Invalid API key","hint":"Only the `service_role` API key can be used for this endpoint."}` |
| publishable | 401 `{"message":"Secret API key required","hint":"Only secret API keys can be used for this endpoint."}` |
| service_role (legacy JWT) | 200, swagger 2.0 spec, 5 paths |
| sb_secret_ | 200, same spec, 5 paths |

The anon status matches the notice (a refusal) and its text does not:
`Access to schema is forbidden` was not seen; the body above was. Control:
`GET /rest/v1/<granted table>` returns 200 for anon, publishable,
service_role and sb_secret_ keys and 401 with no key.

`GET /v1/projects/{ref}/database/openapi` with the Management API token: 200,
swagger 2.0, the same 5 paths as the sb_secret_ root spec (path sets equal);
`?schema=graphql_public` 200 with title `PostgREST API` and 2 paths; without a
token 401 `No access token provided`. The spec title is the `public` schema
comment (`standard public schema` after DD02 restored it).

Not measured: the 2026-03-11 / 2026-04-08 rollout split (one project, created
after both dates); a token without the read-only database permission the
notice mentions; the Management API path against a project created before the
anon change.

## 2026-10-13 - DD01S standing-project baseline, before 2026-10-30

Harness: `make run-standing`, module DD01S only, `--destructive` (one probe
table created and dropped; no GRANT, REVOKE or ALTER sent), lab commit 27a322f
plus the staged tree that adds DD01S (second reading at lab commit a5a34fe).
Two readings 15 minutes apart (00:06Z and 00:21Z) on n = 1 existing project, created
2026-04-07 (before the 2026-05-30 new-project default), Postgres 17.6, not a
lab-provisioned project. Published: `out/2026-10-13/`. The artifact header's
region is the harness default, not the project's region.

| step | measured |
|---|---|
| DD01Sa `pg_default_acl`, schema `public`, roles `postgres` and `supabase_admin` | tables: `anon`, `authenticated`, `service_role` each `arwdDxtm`; sequences `rwU`; functions `X` - the same legacy grants DD01a read on the 2026-10-10 API-created project |
| DD01Sb table made in SQL, anon GET | 200 `[{"id":1}]` after 1 s (second reading: 0 s); publishable key 200 |
| DD01Sb drop | dropped, `to_regclass` null |

`pvlab --diff` of the two readings: 32 of 33 measurements unchanged; only
the schema-cache wait moved (1 s to 0 s), so the baseline repeats and a later
change in the grants or the anon status is not run-to-run noise.

This is the pre-enforcement half of #89. Re-run the same target on the same
project on or after 2026-10-30 and diff the two artifacts (README,
"Standing-project baseline"); a 42501 with the "Grant the required
privileges" hint on DD01Sb would show the enforcement reached an existing
project, and an unchanged `pg_default_acl` would show it was done some way
other than rewriting the default ACL.

## 2026-10-23 - DD05: the lab fixtures' explicit GRANTs under the revoked default (work-supabase-lab#179)

Why: the 2026-10-13 re-runs after the explicit GRANTs of #128 (edge-resilience
W12, usage-metering M01 and M05, compute-disk D09, s2z-wake Z01) all hit
projects that still carried the legacy `pg_default_acl`, so each would have
passed without the GRANTs. DD05 applies DD01c's two `ALTER DEFAULT PRIVILEGES
... REVOKE` statements first, then runs three fixtures with the GRANT left
out and then issued: the edge-resilience `make seed` SQL for `w_probe`
(publishable-key read), usage-metering M05's `metering_hourly` (insert with
the legacy service_role key and an `sb_secret_` key), and edge-resilience W12
itself, imported and run three times on one table with grants only ever added
(none, table only, table + sequence).

Harness: `make run ONLY=DD05,DD99`, `--destructive`, lab commit 661afdf plus
the uncommitted tree that adds DD05 and W12's grant variant. Two runs, n = 1
fresh Pro-org project per run, created through `POST /v1/projects`
(ap-southeast-1) and deleted by DD99 (`DELETE 200`, gone from the listing).
One trial per probe. Published: run 1
`out/2026-10-23/run-2026-10-23T08-06-02-454Z.json`, run 2
`out/2026-10-23/run-2026-10-23T08-07-48-510Z.json`, each with a `.facts.md`.

- Run 1: 5 pass, 2 fail. Both fails were the module's own expectations, not
  the platform: DD05a tested that anon held no privilege at all after the
  revoke, but the revoke leaves `Dxtm` on tables (as DD01c recorded on
  2026-10-10) and `w` on sequences; DD05e expected W12 to fail without the
  sequence GRANT and it passed. DD05a now checks only the letters the revoke
  targets; DD05e is recorded as `info`. Measurements of the two runs agree
  apart from W12's latencies.
- Run 2: 6 pass, 1 info (DD05e), 0 fail. Figures below are run 2 unless stated.

| step | measured |
|---|---|
| DD05a `pg_default_acl` for `postgres` in `public`, before | tables `anon=arwdDxtm` (same for authenticated, service_role); sequences `anon=rwU` |
| DD05a after the revoke (HTTP 201) | tables `anon=Dxtm`; sequences `anon=w` (same for authenticated, service_role) |
| DD05b `w_probe` seed without its GRANT, publishable GET | 401, code `42501`, hint `Grant the required privileges to the current role with: GRANT SELECT ON public.w_probe TO anon;` |
| DD05b after the seed's GRANT | 200 `[{"id":1}]`, 0 s to serve |
| DD05c `metering_hourly` without M05's GRANT, insert | service_role 403 `42501`; `sb_secret_` 403 `42501`, hint `... GRANT INSERT ON public.metering_hourly TO service_role;` |
| DD05c after M05's GRANT | `sb_secret_` 201, service_role 201 |
| DD05d W12, no GRANT | W12 fail: `Insert failed: HTTP 401`, code `42501`, hint `... GRANT INSERT ON public.probe_canary TO anon;`, on all 4 attempts (both runs) |
| DD05e W12, table GRANT only | W12 pass (conn1 480 ms, conn2 277 ms; run 1: 563 ms, 422 ms); sequence relacl `anon=w` |
| DD05f W12, table + sequence GRANT (the committed fixture) | W12 pass (conn1 474 ms, conn2 403 ms; run 1: 381 ms, 434 ms); sequence relacl `anon=rwU` |

What this settles, for these three fixtures on an API-created project with
DD01c's revoke applied: the table GRANTs are load-bearing. Without them the
Data API answers 42501 with the hint (401 for the publishable key, 403 for
both service_role key kinds), and with them the same request succeeds.

What it does not settle:

- W12's sequence GRANT is not needed under these revoke statements. They take
  USAGE and SELECT on sequences and leave UPDATE (`w`); Postgres documents
  that `nextval` requires USAGE or UPDATE on the sequence
  (https://www.postgresql.org/docs/current/functions-sequence.html), so the
  anon insert into the `serial` column still drew its id. Whether the
  platform's own 2026-10-30 default leaves UPDATE the same way is not
  measured; the GRANT stays in W12 for a default that also takes it.
- The REVOKE statements are DD01c's wording of the opt-in, not a project
  created with the dashboard checkbox or a project after the 2026-10-30
  enforcement (#89).
- M01, D09, O03, Z01 and privatelink-aws T22 were not run under the revoke.
  M01 and D09 read their table with the anon key and O03 with an
  authenticated user's token, through a table-only GRANT of the same form as
  `w_probe`'s; that they would answer 42501 without it is an inference from
  the code, not a measurement. Z01's table is never read over the Data API
  (it exists to trip a security advisor lint), so DD05 says nothing about it.
