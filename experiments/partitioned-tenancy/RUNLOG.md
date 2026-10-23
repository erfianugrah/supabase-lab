# RUNLOG - partitioned-tenancy

Chronological record of what was run. Org and project identifiers are not
recorded; the org class is (Pro). Each run provisions one throwaway project
through `POST /v1/projects` (ap-southeast-1, no compute add-on requested, so
the platform default size, Micro; not read back) and deletes it in PT99.
"Measured" means the artifact under `out/`; "docs" means the Supabase docs
page named in the module header.

## 2026-10-22 - three runs (vantage: this lab's Mac, over the public internet)

Harness: `make run`, `--destructive`. All three artifacts carry lab commit
b6bd1d2; the uncommitted tree that adds this experiment differed per run
(the probe changes below). One fresh project per run. The Postgres version
was queried at setup (`lib/project.ts`) but not written to the artifact; the
PostgREST version was not read. Published (redacted) under
`out/2026-10-22/`:

- run 1 `run-2026-10-22T22-42-07-054Z.json` - PT01-PT04, PT99; 22:42 to
  22:48 UTC. 7 pass, 1 fail, 23 info.
- run 2 `run-2026-10-22T22-53-31-200Z.json` - PT01-PT04, PT99; 22:53 to
  23:00 UTC. 8 pass, 1 fail, 23 info.
- run 3 `run-2026-10-22T23-03-58-973Z.json` - PT04, PT99 only; 23:04 to
  23:05 UTC. 1 pass, 0 fail, 6 info.

Probe changes between runs 1 and 2. Run 1's PT01e, PT01g, PT01j and PT02g
rows are probe artefacts for these reasons; other differences between runs 1
and 2 are run-to-run variation, and run 2's PT04 is void (below).

- PT01g's status assumed partitions were readable at the Data API; they are
  not (PT01c), so run 1 marked it `fail` with the parent reads correct
  (t1 5, t2 7). Run 2 judges only the parent reads: pass.
- PT01e/PT01j matched a lint to a table by substring, so in run 1 the parent
  `pt_audit` collected its partitions' lints (`rls_disabled_in_public` three
  times). Run 2 matches `public.<table>` as a whole word: the parent has no
  lint.
- PT02g read the oldest detached table, which held no rows (run 1: 200,
  rows=0). Run 2 reads the newest one and records its row count.
- Run 2 also adds the `PGRST205` code keys that run 1 lacks (PT01c
  `*_anon_code`, PT01g `rlsonpart_direct_anon_status` and code in the
  detail, PT02c `child_anon_code`). PT04z (database state before the DETACH
  windows) was added before run 3.

Run 2's PT04 is void: every DDL the postgres session sent answered `25006
cannot execute ALTER TABLE in a read-only transaction` (the final DROP the
same), after the PT03 and PT04 loads had succeeded, while the Data API
writes in the same four windows all answered 2xx (210, 213, 212, 197 writes,
non-2xx 0). Why the session was read-only was not read. Run 3 reruns PT04
alone on a fresh project and records the state first (PT04z:
`default_transaction_read_only` `off`, database size 369 MB); its DDL
succeeded.

### PT01 - tenant RLS on a partitioned parent (runs 1 and 2 agree unless noted)

- Default privileges on the fresh project (PT01a): `pg_default_acl` for
  postgres in `public` = `{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
  authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`, the
  legacy grants data-api-defaults DD01a measured. All 3 partitions have
  `relrowsecurity = false` and 0 policies; the sampled partition
  `pt_audit_2026_10` carries the same ACL (PT01c).
- Through the parent (PT01b, pass in both runs): anon 200 rows=0; tenant 1
  200 rows=5, tenant ids seen [1]; tenant 2 200 rows=7, tenant ids seen [2].
- Each partition read directly (PT01c): anon and tenant 1 both answered
  `404` on all three partitions, despite the legacy grants and RLS off; the
  code `PGRST205` is recorded for the anon reads in run 2 (tenant-1 reads
  record the status only). The OpenAPI document lists the parent and 0 of 3
  partitions (PT01d). PostgREST's schema cache leaves partitions out; the
  PostgREST version and the code path were not read.
- Writes (PT01f): tenant 1 POSTing a tenant-2 row through the parent
  answered `403 42501` (the WITH CHECK policy), 0 rows landed; into the
  partition `pt_audit_2026_10`, as tenant 1 and as anon, `404 PGRST205`, 0
  landed.
- Advisors (PT01e, run 2): `rls_disabled_in_public` on each of the 3
  partitions, none on the parent. The lint fires on tables the Data API does
  not serve.
- Mitigations: RLS enabled on one partition with no policy (PT01g) and
  `revoke all ... from anon, authenticated` on another (PT01h) both leave the
  parent reads at t1 5 / t2 7, and a tenant-1 insert through the parent
  routed into the revoked partition answered 201. Advisors afterwards (PT01j,
  run 2): the RLS partition `rls_enabled_no_policy`, the untouched one still
  `rls_disabled_in_public`, the revoked one no lint.
- After the default-privilege revoke (PT01i): a new partition
  `pt_audit_2026_12` gets `{postgres=arwdDxtm/postgres,anon=Dxtm/postgres,
  authenticated=Dxtm/postgres,service_role=Dxtm/postgres}`, is `404 PGRST205`
  directly, the parent returns 7 rows to tenant 1 (5 seeded plus 2 inserted
  into `pt_audit_2026_12`), and the advisors report no lint for it (PT01j).
  PT01z restored the default privileges for the later modules (pass).

### PT02 - pg_partman (runs 1 and 2 agree unless noted)

- `pg_partman@5.3.1` is available; the documented `create schema partman;
  create extension pg_partman with schema partman` answered 201, installed
  5.3.1. `pg_partman_bgw` is not in `shared_preload_libraries` and there are
  0 `pg_partman_bgw.*` settings: no background worker, so maintenance has to
  be called (PT02a).
- `create_parent` (daily, premake 3, start 10 days back) on a parent that
  already had RLS and a policy: 201, 15 children, a default partition,
  template `partman.template_public_pm_events`, `inherit_privileges=false`
  (PT02b).
- The 15 children: RLS on 0, policies on 0, anon SELECT on 15; an anon read
  of today's child `404` (partitions are not exposed, as in PT01c); anon via
  the parent rows=0 (PT02c).
- `call partman.run_maintenance_proc()` works through the Management query
  endpoint (201, not timed; children 15 -> 17 at premake 5) and through a
  session pooler connection (68 ms run 1, 69 ms run 2; 17 -> 19 at premake
  7) (PT02d).
- RLS enabled on the template table plus `inherit_privileges = true`, then
  maintenance: 2 new children, RLS on 0 of 2 (PT02e). The template does not
  carry RLS to new children.
- pg_cron `* * * * *` running `call partman.run_maintenance_proc()`: first run
  `succeeded` (`CALL`), seen within 61 s (run 1) and 30 s (run 2) at 15 s
  polling; children 21 -> 24 (PT02f).
- Retention `5 days` with `retention_keep_table = true`: 24 -> 19 attached, 5
  detached tables kept in `public`, RLS on 0 of 5, anon SELECT on 5. Run 2:
  an anon Data API read of the newest detached table (2 rows) answered 200
  with rows=2, tenant ids seen [1,2], schema cache 0 s. A detached child is
  an ordinary exposed table without the parent's policy. Retention `3 days`
  with keep_table false: 19 -> 17 attached; the 5 earlier detached tables
  stay in `public` (whether pg_partman still tracks them was not read)
  (PT02g).

### PT03 - pruning under a tenant policy (2,000,000 rows per table)

Median Execution Time of 5 `explain (analyze)` after a warm-up, as
authenticated with tenant 7's claims unless noted. Run 1 / run 2:

| row | shape | partitions in plan | executed | Subplans Removed | count (run 1 / run 2) | ms (run 1 / run 2) |
|---|---|---|---|---|---|---|
| PT03a | month range, wrapped policy, `created_at >= '2026-10-01'` | 1 of 12 | 1 | 0 | 1623 / 1580 | 1.97 / 1.83 |
| PT03b | month range, wrapped policy, no time filter | 12 of 12 | 12 | 0 | 20000 / 20000 | 22.17 / 22.44 |
| PT03c | hash(16) by tenant, wrapped `(select ...)` policy | 16 of 16 | 1 (15 never executed) | 0 | 20000 / 20000 | 9.48 / 9.84 |
| PT03d | hash(16) by tenant, bare `auth.jwt()` policy | 1 of 16 | 1 | 15 | 20000 / 20000 | 14.25 / 14.8 |
| PT03e | hash(16), postgres, literal `tenant_id = 7` | 1 of 16 | 1 | 0 | 20000 / 20000 | 6.56 / 6.75 |
| PT03f | hash(16), postgres, no filter | 16 of 16 | 16 | 0 | 2000000 / 2000000 | 361.69 / 362.64 |

- Time-range pruning is plan-time and survives the policy (PT03a). Tenant
  pruning under the wrapped policy happens at run time on the InitPlan value:
  all 16 partitions are planned and 15 are never executed (PT03c). The bare
  form is pruned at executor startup (Subplans Removed 15) but ran slower than
  the wrapped form in both runs (14.25 / 14.8 against 9.48 / 9.84 ms); the
  cause was not separated (a per-row re-evaluation of the bare call, as in
  rls-policy-cost, is one reading; this run does not show it).
- Every policy row's count equalled the postgres-role count with the same
  predicate (the module fails otherwise).
- Load (PT03z): 2,000,000 rows in 15707 / 15930 ms (time table), then, after
  dropping it, 16365 / 16828 ms (hash table); database size with the time
  table 314 / 313 MB, with the hash table 273 / 273 MB. Micro runs on shared
  CPU, so the ms figures are relative, not capacity numbers.

### PT04 - DETACH under a Data API reader and writer (runs 1 and 3; run 2 void)

Reader and writer each send their next request when the previous one
answers; 3 s before and 3 s after the DDL. "During" = requests overlapping
the DDL. PT04a and PT04b are two repetitions inside one harness run (their
titles say "run 1" and "run 2"; the test now says "rep 1" and "rep 2"); the
"run 1 / run 3" columns are harness runs.

| row | DDL | DDL ms (run 1 / run 3) | during: reads, non-2xx, max ms (run 1 / run 3) | during: writes, non-2xx, max ms (run 1 / run 3) |
|---|---|---|---|---|
| PT04a | DETACH CONCURRENTLY, 1M rows | 12 / 13 | 2, 0, 31 / 2, 0, 54 | 2, 0, 33 / 2, 0, 44 |
| PT04b | DETACH CONCURRENTLY, 1M rows | 12 / 13 | 1, 0, 25 / 1, 0, 38 | 2, 0, 32 / 2, 0, 35 |
| PT04c | DETACH CONCURRENTLY, 200k rows, 15 s transaction open | 12010 / 12011 | 438, 0, 63 / 408, 0, 93 | 454, 0, 45 / 437, 0, 52 |
| PT04d | plain DETACH, 200k rows, 15 s transaction open | 12011 / 12011 | 2, 1 (500/57014), 8027 / 3, 1 (500/57014), 8048 | 3, 1 (500/57014), 8027 / 2, 1 (500/57014), 8042 |

- DETACH CONCURRENTLY of a 1M-row partition took 12 or 13 ms of DDL time and
  no client request failed; the slowest overlapping request took 54 ms
  (PT04a/b, 4 detaches across two runs). Window medians stayed 27-30 ms for
  reads and 26-28 ms for writes.
- With another transaction open on the parent, DETACH CONCURRENTLY of the
  200,000-row `dt_events_2026_05` waited for it (12010 / 12011 ms, the
  holder's remaining time) and clients carried on: reads 438 / 408 and writes
  454 / 437 overlapped the wait (892 requests in run 1, 845 in run 3), none
  failed, slowest 93 ms (PT04c).
- Plain DETACH of the 200,000-row `dt_events_2026_06` under the same kind of
  open transaction waited 12011 ms, and clients queued behind its lock
  request: in each run 1 read and 1 write answered `500 57014` at 8027 to
  8048 ms (consistent with an 8 s statement timeout for the authenticated
  role; the role setting was not read), and the overlapping requests had
  medians of 3968 to 6013 ms (PT04d).
- Detached tables standalone (PT04e, runs 1 and 3): row counts kept (200000,
  200000, 1000000, 1000000), `relrowsecurity = false`, anon SELECT true; the
  parent returns 0 rows before 2026-09; an anon Data API read of the detached
  1M-row table answered 200 with 1000 rows (the request's limit) from all 50
  tenants in the table. The tenant policy stays on the parent; the detached
  table is open to the anon key under the legacy default privileges.
- Archiving the detached table elsewhere (Storage, another database) was not
  attempted in these runs; PT06 (2026-10-23, below) archived to Storage, and
  another database was not attempted.

Re-run note: run 2's postgres session refused the PT04 DDL as read-only
after the PT03 and PT04 loads; running PT04 on its own project (`make run
ONLY=PT04,PT99`, run 3) avoided it.

Teardown: PT99 deleted each project (`DELETE 200`, absent from `GET
/projects` on the first read). Afterwards `make clean` printed 0 projects
with the `pvlab-pt-` prefix (console output, not in `out/`). Project time:
about 14 minutes of Micro across the three runs.

## 2026-10-23 - PT05 and PT06 (vantage: this lab's Mac, over the public internet)

Harness: `make run ONLY=PT05,PT06,PT99`, `--destructive`, one fresh project
(an earlier invocation the same minute skipped all three modules because
`PVLAB_ORG_SLUGS` was not set, so the `org` capability was absent; no
project was created; console output, not in `out/`). Published (redacted)
under `out/2026-10-23/`:

- `run-2026-10-23T03-07-40-623Z.json` - PT05, PT06, PT99. 1 pass, 0 fail,
  12 info. The harness stamps each module's elapsed time on every row it
  emits, so the per-row `durationMs` values repeat within a module; counted
  once per module they are PT05 20535 + PT06 35865 + PT99 1380 = 57780 ms,
  the 58 s between the start and finish stamps. PT05's 20535 ms includes
  creating the project.

Question: PT04e and PT02g left a detached partition (and a pg_partman
retention `keep_table` child) in `public` with RLS off and the anon grant,
readable by anon through the Data API. Which step closes that, and can a
detached partition go to Storage and come back for a lookup using only
generally available pieces (not the alpha Analytics buckets)?

### PT05 - closing the read (one table per step, n = 1)

Table `public.ar_events` range by month with the tenant policy on the
parent; each partition held 1000 rows from tenants 1 and 2. Reads are anon
(legacy anon JWT) and a tenant-2 user's token, at the default profile and,
for tables outside `public`, with `Accept-Profile: archive`. `archive` is a
new schema not added to the exposed schemas. Advisors read once, after all
steps (PT05f).

| row | step | RLS / policies / anon SELECT / anon USAGE on schema | anon read | tenant-2 read | advisor lint on the table |
|---|---|---|---|---|---|
| PT05a | plain DETACH (control) | off / 0 / true / true | 200, 1000 rows, tenants 1,2 | 200, 1000 rows, tenants 1,2 | `rls_disabled_in_public` |
| PT05b | REVOKE ALL from anon, authenticated, then DETACH | off / 0 / false / true | 401 `42501` | 403 `42501` | none |
| PT05c | DETACH, then SET SCHEMA archive | off / 0 / true / false | 404 `PGRST205`; with the archive profile 406 `PGRST106` | the same | none |
| PT05d | ENABLE ROW LEVEL SECURITY, then DETACH | on / 0 / true / true | 200, 0 rows | 200, 0 rows | `rls_enabled_no_policy` |

- The control reproduces PT04e: any token reads every tenant's rows from the
  detached table, and the advisor flags it `rls_disabled_in_public`.
- PT05b, PT05c and PT05d each closed the read. The revoke (PT05b) and the
  schema move (PT05c) answer with an error; RLS without a policy (PT05d)
  answers 200 with no rows.
- After the schema move the table still carries the anon SELECT grant; what
  blocks the read is that `archive` is not exposed (PGRST205 at the default
  profile, PGRST106 when the profile is requested) and anon has no USAGE on
  it. Exposing `archive` later, or granting USAGE on it, was not tested.
- The advisor did not flag the revoked table or the moved table, and flagged
  the RLS-on table as `rls_enabled_no_policy`.

PT05e - pg_partman (installed per PT02) on `public.rp_events`, daily
children from 10 days back, premake 2, tenant policy on the parent; then
`retention = '5 days'` with `retention_schema = 'archive'` and one
`run_maintenance_proc` through a session:

- children 14 -> 9 attached; the 5 retired children were moved to `archive`
  (none left in `public`), with RLS off, no policies and the anon SELECT
  grant (5 of 5);
- the newest retired child (2 rows) answered anon 404 `PGRST205` at the
  default profile and 406 `PGRST106` with the archive profile (anon only;
  PT05e did not read it as the tenant-2 user);
- the advisor flagged none of the 5 (PT05f).

So `retention_schema` pointed at a non-exposed schema closed the read the
same way PT05c did. The grant travels with the table.

### PT06 - a detached partition to Storage and back

`public.cs_events_2026_06`: 1,000,000 rows (tenants 1 to 50, spread over
the 43200 minutes of June by `g % 43200`, about 23 rows a minute, short
text payload), loaded in 6 s, detached, 114679808
bytes with its primary-key index. Checksum = count plus the sum of
`hashtextextended(row::text, 0)` over (id, tenant_id, created_at, payload).
Lookup = count of tenant 7's rows on 2026-06-15 (644 rows), execution time
from `EXPLAIN ANALYZE`, median of 5. Storage global file size limit read as
52428800 bytes.

| step | rep 1 | rep 2 |
|---|---|---|
| psql `\copy ... to pstdout`, gzip, ms | 1590 | 1420 |
| gzip CSV object, bytes | 6611657 | 6611657 |
| upload, Storage REST (service_role), status / ms | 200 / 505 | 200 / 471 |
| download, Storage REST (service_role), status / ms | 200 / 505 | 200 / 601 |
| gunzip + psql `\copy ... from pstdin` into `archive.cs_restore_rN`, ms | 1925 | 1913 |
| rows / checksum against the original | 1000000 / equal | 1000000 / equal |
| lookup, restored table without an index, ms | 95.61 | 96.1 |
| index on (tenant_id, created_at), build ms | 935 | 942 |
| lookup, restored table with that index, ms | 0.23 | 0.22 |
| anon read of the restored table: default profile / archive profile | 404 `PGRST205` / 406 `PGRST106` | the same |

The same lookup on the detached table before the drop, through its primary
key on (created_at, id), took 4.94 ms (PT06a).

PT06c - the Wrappers S3 FDW (wrappers 0.6.3) against the uploaded object:

- The Supabase Storage form in the S3 FDW docs uses S3 access keys from the
  dashboard. The Management API v1 document lists no endpoint that creates
  them (its storage paths are `config/storage` and `storage/buckets`), and
  the dashboard's own credential route answered the PAT with 401
  `{"message":"Unsupported access token"}`. So the documented form was not
  exercised.
- Three credential forms a test can produce, each a server plus a foreign
  table over the gzip CSV: access key id = project ref with the anon key as
  secret on `<ref>.storage.supabase.co` and on `<ref>.supabase.co`, and the
  project ref with the service_role key on the storage host. All three
  answered `ERROR: HV000: request failed: service error` on the first
  `select count(*)`. These are the session-token shape of Storage S3 auth
  without the session token; the FDW's documented server options list no
  session-token field, and sending one was not tested. What Storage answered
  underneath the FDW's generic error was not captured.

Reading of PT06: on generally available pieces, a detached partition can be
kept in a private bucket as gzip CSV at about 6.6 MB per 1,000,000 rows of
this shape and restored with its rows intact in about 2.5 s of download and
import on default compute (Micro, not read back); a lookup needs the restore (or dashboard keys for the FDW,
not tested), and an index on the restored table took the lookup from about
96 ms to about 0.2 ms.

Not tested: Parquet; objects above the 52428800-byte limit (multipart or
TUS); the FDW with dashboard-generated keys; what happens when `archive` is
exposed or granted; a revoke after the detach (reasoned to match PT05b);
larger compute.

Teardown: PT99 `DELETE 200`, absent from `GET /projects` on the first read.
The project existed for under a minute: created inside PT05's 20535 ms,
deleted in PT99's 1380 ms, 57780 ms of module time in all. Afterwards `make
clean` printed 0 projects with the `pvlab-pt-` prefix (console output, not
in `out/`).
