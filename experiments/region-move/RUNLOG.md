# RUNLOG - region-move

Moving one small project to another region, per tenant, in the
project-per-tenant layout: create a project in the new region, move the
data, cut over. Region is fixed at creation and Restore to a
New Project stays in the source region, so the move is always a new project
plus a data move.

Three arms this round, all on the lab's Pro organisation, Micro compute,
ap-southeast-1 -> ap-northeast-1:

- RM01: logical-replication settings on the smallest compute a Pro org can
  create.
- RM02: a dump/restore move driven only by the Management API and the stock
  Postgres clients; the write-stop by database size.
- RM03: the first managed-to-managed cross-region run of pgmig
  `cutover --with-auth-data` (a pgmig harness, `test/auth-cutover-live.harness.ts`
  in the pgmig repo, not a module here).

Not run this round: config-sync and the
repoint surface (Storage bytes and policies, Realtime reconnect), the
old-issuer third-party-auth bridge, many moves in parallel, and anything
that needs a platform-plan organisation (Nano as the default size, pausing
the source as a rollback hold).

## Prior art (sweep 2026-11-23)

| Store | Hits | What it settles |
|---|---|---|
| AGENTS.md / RUNLOGs | replica-routing and restore-paths RUNLOGs; pipelines PL02a | `max_replication_slots` 10 and `max_wal_senders` 10 on Small and Medium; nothing on Micro or Nano |
| AGENTS.md | upgrade-integrity UI01-UI06 (2026-10-23/26) | POST to ACTIVE_HEALTHY 289-335 s for PG 15 projects; restore-paths R27 saw ACTIVE_HEALTHY before an outage, "poll the database, not the status" |
| AGENTS.md | session-carry S01-S04 (2026-09-25), tenant-promotion P01/P02 | auth rows copied by hand carry a refresh token and aal2 (with `mfa_amr_claims`); a held access token is refused at the target |
| AGENTS.md | edge-resilience W05, W15 (2026-08-15/16) | managed -> managed logical replication streams; a source-only DDL stalls the stream |
| pgmig repo | `docs/research/2026-11-09-pg15-to-17-live.md` | pgmig cutover 1.6 s at 0.06 GB and 3.65 GB (no writer, one region pair); `cutover --with-auth-data` tested on the docker integration tier only |
| lexicanum | guides/supabase-region-migration-e2e (validated 2026-07-30, eu-central-1 -> eu-west-1) | the pipeline end to end; no size curve for dump/restore |
| Board | two open cards | a CLI dump/restore rehearsal (2026-11-11) and an auth 15 -> 17 test, both open |

Nothing on record measured: Nano on a Pro org, a dump/restore write-stop by
size, or `cutover --with-auth-data` between two managed projects.

## 2026-11-23 - runs (Pro org, Micro, ap-southeast-1 -> ap-northeast-1)

Orchestrator: the operator's laptop (`where: "local"`), Postgres 17.12
clients, every database connection through the region's session-mode pooler
(IPv4, port 5432). This machine has no global IPv6 address, so its system
resolver returns no address for the IPv6-only `db.<ref>` name (`dig` does);
the first two module runs failed on that (`getaddrinfo ENOTFOUND`) and the
lib was switched to the pooler. Every project was created by the run and
deleted by RM99 or the harness's teardown; a project list after the last
run held none of them.

| Run (UTC start) | What | Outcome | Published |
|---|---|---|---|
| 08:59:00 | RM01, RM02, RM99 | org capability unset, RM01/RM02 skipped | no |
| 08:59:23 | RM01, RM02, RM99 | RM01 and RM02 threw `getaddrinfo ENOTFOUND` (direct host) | no |
| 09:00:45 | RM01, RM02 (10 MB) | stopped by hand while waiting on the direct host; projects deleted by hand | no |
| 09:09:55 | RM01, RM02, RM99 (pooler) | RM01 as below; RM02 threw `could not extend file "base/5/17670": No space left on device` while seeding toward 1 GB on the default disk | `out/2026-11-23/run-2026-11-23T09-09-55-932Z.json` |
| 09:12:27 | RM01, RM02 (disk grown to 8 GB first), RM99 | 11 pass, 0 fail | `out/2026-11-23/run-2026-11-23T09-12-27-329Z.json` |
| 09:04:11 | RM03 first attempt (pgmig harness) | stopped by hand in its DNS wait (system resolver, as above); projects deleted by hand | no |
| 09:09:55, 09:11:16 | RM03 runs A and B (pgmig harness) | all checks passed, both runs | `out/2026-11-23/rm03-auth-cutover.ndjson` |

### RM01 - replication settings on the smallest creatable compute

- RM01a: `POST /v1/projects` with `desired_instance_size: "nano"` on the Pro
  org answered `400 {"message":"Minimum instance size on paid plans is Micro"}`
  (09:09:55 and 09:12:27 runs). Nano is not creatable on a Pro org; it was not
  measured.
- RM01b, Micro, ap-southeast-1, Postgres 17.12 (09:12:27 run; the 09:09:55 run
  read the same four replication values):

| Setting | Value |
|---|---|
| `wal_level` | logical |
| `max_replication_slots` | 10 |
| `max_wal_senders` | 10 |
| `max_logical_replication_workers` | 4 |
| `max_sync_workers_per_subscription` | 2 |
| `max_worker_processes` | 6 |
| `max_slot_wal_keep_size` | 512 MB |
| `max_connections` | 60 |
| `shared_buffers` | 32768 x 8kB (256 MB) |
| `statement_timeout` (postgres session through the pooler) | 2min |

The 2 min `statement_timeout` is what a hand-written subscription inherits
unless its connection string sets `statement_timeout=0` (pgmig ae33443). With 4
logical replication workers, a subscription on a Micro target syncs at most 2
tables at a time beside its apply worker; pgmig `doctor` warned on both RM03
runs: "target max_logical_replication_workers=4 for 4 tables - raise to >= 5".

### RM02 - dump/restore move, write-stop by size

RM02a, 09:12:27 run, the pair created in parallel:

- `POST /v1/projects` -> status `ACTIVE_HEALTHY` on the first 5 s poll: 3 s
  (ap-southeast-1) and 2.9 s (ap-northeast-1). First pooler login: 3.7 s and
  4.1 s.
- The projects' `created_at` read 09:01:59 and 09:07:09 UTC, 5 to 10 minutes
  before the run began (09:12:27): the API handed back projects that already
  existed. Every pair whose status was polled this day read `ACTIVE_HEALTHY`
  within 3.6 s of the POST (six pairs, RM and RM03 runs), and `created_at`
  predated the POST on the four pairs where it was read. The lab's earlier
  create timings (upgrade-integrity, 289 to 335 s, Postgres 15 projects on
  2026-10-23/26) are a different shape and were not re-run.
- `select 1` median from the orchestrator through the pooler: 6.7 ms
  (ap-southeast-1), 75.9 ms (ap-northeast-1).

RM02b: both new projects came with a 2 GB disk (`GET /config/disk`
`size_gb` 2). The 09:09:55 run filled it while seeding toward 1 GB. The
09:12:27 run grew both to 8 GB first (`POST /config/disk`, config and status
settled in 12 s and 14 s).

Write-stop of a naive dump/restore (writes stop before `pg_dump`, resume
after `pg_restore`), one table of ~1 KB incompressible rows with its primary
key, ap-southeast-1 -> orchestrator -> ap-northeast-1, 09:12:27 run:

| Table | Rows | Dump file | `pg_dump -Fc` | `pg_restore` | Write-stop (file path), 2 repeats | Streamed `pg_dump \| psql` |
|---|---|---|---|---|---|---|
| 10.4 MB | 9,104 | 7 MB | 1.1 s, 1 s | 3.7 s, 3.9 s | 4.8 s, 4.9 s | 3.7 s |
| 103.3 MB | 90,797 | 69.5 MB | 3 s, 3.1 s | 5.8 s, 5.8 s | 8.8 s, 8.9 s | 6.2 s |
| 1024.4 MB | 900,300 | 689.4 MB | 26.4 s, 23.7 s | 39.6 s, 44.1 s | 66 s, 67.8 s | 51.7 s |

Row counts matched on the target after every restore. One table only: no
auth, storage, roles, extensions or other schemas, so these are the data
half of the stop, not a whole-project move. The byte path ran through a
home connection; a client in either region would see a different
throughput.

### RM03 - pgmig `cutover --with-auth-data`, managed to managed, cross-region

pgmig harness `test/auth-cutover-live.harness.ts` (pgmig worktree on 940eff8
plus that file), Micro pair ap-southeast-1 -> ap-northeast-1, 5,000
documents plus dependents, two runs (A, B). Per run:

1. On the source before bootstrap: user A signs in (password); user B signs in
   and completes a TOTP challenge (source session `aal2` both runs).
2. `bootstrap --with-auth-data` copies a snapshot of the auth rows.
3. On the source after the snapshot: user C is created and A's session is
   refreshed, so C and A's new refresh token exist only on the source.
4. Controls at the target before cutover, both runs: C's password login `400
   invalid_credentials`; A's new refresh token `400 refresh_token_not_found`.
5. replicate, watch, reconcile, then cutover with the auth reload. No writer
   ran, so the cutover duration is the write-stop before the app repoint.

| | Run A | Run B |
|---|---|---|
| bootstrap (with the auth snapshot) | 14.4 s | 14.6 s |
| initial copy (replicate + watch) | 7.5 s | 7.3 s |
| cutover with auth reload | 11.7 s | 10.8 s |
| A's post-snapshot refresh token at target | 200 | 200 |
| C (created after the snapshot) password login at target | 200 | 200 |
| A password login at target | 200 | 200 |
| B's refresh at target | 200, `aal2`, amr password + totp | 200, `aal2`, amr password + totp |
| A's held source access token at target `/auth/v1/user` | `403 bad_jwt` | `403 bad_jwt` |
| auth users / sessions / refresh_tokens / mfa_factors, source = target | 3 / 2 / 4 / 1 | 3 / 2 / 4 / 1 |

By the step timestamps (1 s resolution) the lag drain and sequence resync
took about 2 s and the auth dump plus reload about 9 to 10 s of each cutover;
the dump and reload ran from the orchestrator through both poolers. The
2026-11-09 pgmig runs measured cutover without the auth reload at 1.6 s. The
harness's "create to login" figure (24.9 s, 24.2 s) includes a fixed 20 s
wait and is not a readiness measurement.

Not run: a writer during cutover, auth reload of a large `auth` schema, an
OAuth identity, and the same on a platform-plan organisation.
