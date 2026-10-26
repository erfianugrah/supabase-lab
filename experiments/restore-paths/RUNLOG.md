# restore-paths RUNLOG

Throwaway projects in ap-southeast-1, all on 2026-10-10 (UTC), driven from an
IPv4-only workstation over the Management API and the shared pooler. Every
project was named `rp-*` and deleted at the end of its module (or by
hand when a run was killed); a final `GET /v1/projects` listed none (author's
observation at the end of the session; no snapshot was saved). Raw
artifacts carry project refs and stay off-repo (`evidence/`); redacted
copies are listed under the run table.

Sources for the claims under test, read 2026-10-10:

- Changelog, "Fixed stale database credentials left behind after a restore",
  2026-07-30 (https://supabase.com/changelog/restore-credential-resync):
  a physical restore recovers the whole data directory including `pg_authid`,
  so a password rotated after the backup is overwritten; credential
  reapplication used to be queued only for a clone, so a plain restore or an
  unpause could leave `db_user` with a stale password; the fix reapplies
  current credentials after every physical restore. Logical restores are
  unaffected (`pg_dumpall --no-role-passwords`).
- Restore to a new project (https://supabase.com/docs/guides/platform/clone-project):
  paid plans, physical backups required, triggered from the Dashboard's
  database backups page. The page says nothing about the database password.
- Database backups (https://supabase.com/docs/guides/platform/backups): PITR
  needs at least Small compute; the Management API route for restoring is
  `restore-pitr` with a unix timestamp.

Everything below is measured unless it says "docs", "inference" or "not run".

## Runs

| run | module | start (UTC) | what | n |
|---|---|---|---|---|
| R1 | RP01 | 01:27 | Pro surface, default compute | 1 |
| R2 | RP02 | 01:30 | Small + `pitr_7`, 10 MB database, two PITR restores | 1 |
| R3 | RP02 | 01:42 | as R2 | 1 |
| R4 | RP02 | 01:42 | as R2 with `RP02_SEED_MB=1500`: the disk filled during seeding (below) | 1 |
| R5 | RP02 | 01:57 | as R2 with `RP02_SEED_MB=500` (574 MB) | 1 |
| R6 | RP02 | 02:11 | as R2, plus an object written after the restore target | 1 |
| R7 | RP03 | 01:30 | Free project, two pause/unpause cycles | 1 |
| R8 | RP03 | 01:43 | as R7 | 1 |
| R9 | RP03 | 02:19 | as R7, with the Management API SQL call fixed (R7 and R8 sent it with an empty project path) | 1 |

Published artifacts (redacted, a `.facts.md` beside each):

| run | artifact |
|---|---|
| RP01 first attempt (about 01:22) | `out/2026-10-10/run-2026-10-10T01-22-13-170Z.json` |
| R1 | `out/2026-10-10/run-2026-10-10T01-27-07-341Z.json` |
| R2 | `out/2026-10-10/run-2026-10-10T01-30-06-076Z.json` |
| R3 | `out/2026-10-10/run-2026-10-10T01-42-15-008Z.json` |
| R4 | `out/2026-10-10/run-2026-10-10T01-42-15-009Z.json` |
| R5 | `out/2026-10-10/run-2026-10-10T01-57-31-964Z.json` |
| R6 | `out/2026-10-10/run-2026-10-10T02-11-13-334Z.json` |
| R7 | `out/2026-10-10/run-2026-10-10T01-30-06-076Z-rp03.json` (R2 and R7 started in the same millisecond; the suffix keeps R7 from overwriting R2) |
| R8 | `out/2026-10-10/run-2026-10-10T01-43-58-645Z.json` |
| R9 | `out/2026-10-10/run-2026-10-10T02-19-59-081Z.json` |

An earlier RP02 attempt (about 01:24) was killed by the author before it wrote
an artifact: the credential poller was trying a wrong password every 4 s and
the pooler answered every login with `(ECIRCUITBREAKER) too many
authentication failures, new connections are temporarily blocked` within about
a minute, before checking the password. The poller was changed (5 s for the
current password, 60 s for the replaced one) and the breaker reappeared only
in R4's wrecked state. That log is in the evidence copy as
`rp02-run1-aborted.log`. The RP02 and RP03 JSON in the evidence copy carries a
`poll_interval_s: 4` field; it is stale (left from that first poller) and the
field was removed from the modules afterwards. The transitions in the runs are
5 s apart, matching the 5 s poller. R2 and R7 ran an intermediate poller that labelled
results `ok`/`fail` only; R3 onward, R8 and R9 use `ok`/`refused`/`down`/
`blocked`, which separates "the password was refused" from "nothing answered".

## RP01 - what a Pro org can reach (R1, n=1)

Entitlement flags on the Pro org: `project_pausing` false, `project_cloning`
true, `backup.restore_to_new_project` true, `project_restore_after_expiry`
true, `pitr.available_variants` true, `backup.schedule` false.

| call on an active Pro project | answer |
|---|---|
| `POST /pause` | `400` "Project is not free-tier. Please downgrade it to free-tier first and try again." |
| `POST /restore` | `400` "This project is no longer in a paused state, it is ACTIVE_HEALTHY ..." |
| `GET /restore` | `400` "This project is not in a paused state." |
| `POST database/backups/restore {id}` with the listed physical backup | `400` "This endpoint is unavailable at the moment" |
| `GET database/backups/restore-point` | `400` "This endpoint is unavailable at the moment" |
| `POST database/backups/restore-pitr` without PITR | `400` "PITR is not enabled for this project." |
| `GET /v1/projects/{ref}/clone` | `404` |
| `GET /platform/database/{ref}/clone` with a PAT (the Dashboard's route; undocumented) | `401` "Unsupported access token" |

The published OpenAPI document (115 paths, read in R1) has 0 paths matching
`clone` and 7 matching `restore`, `clone` or `pause`; the create-project body
has no clone, restore, source or backup field.

Not settled. `backups/restore` answered "unavailable" on a fresh Pro project
and, in a manual probe of a project with `pitr_7` applied a few minutes
earlier (a manual call, no artifact), answered the same. Whether it works on an
older project, or for an org with another flag, was not tested. The
Dashboard's "restore to a new project" and its physical-backup restore were
not run: the Dashboard route refuses a PAT and a session token for it was not
available to this lab. Read that as "not run", not "not possible".

A fresh Pro project listed one completed physical backup on the first read in
R1. An earlier first attempt at RP01 (about 01:22, a replaced version of the
module; artifact `out/2026-10-10/run-2026-10-10T01-22-13-170Z.json`,
`fresh_physical_backups=0`) found the listing empty at the same
point, so the first physical backup's arrival time is not pinned down. With
`pitr_7` applied the listing is empty and `physical_backup_data` carries a
window instead.

## RP03 - Free-plan pause and unpause (R7, R8, R9; 6 cycles)

The only pause and unpause a lab org could run, since Pro refuses pause.

| measurement | value, one entry per cycle (R7, R7, R8, R8, R9, R9) |
|---|---|
| `POST /pause` to `INACTIVE` (5 s polling) | 62, 62, 62, 63, 276, 62 s |
| `POST /restore` to `ACTIVE_HEALTHY` (10 s polling) | 202, 194, 212, 202, 444, 183 s; statuses `INACTIVE -> COMING_UP -> RESTORING -> ACTIVE_HEALTHY` |
| REST path, first sustained answer after the unpause request | 15, 17, 15, 20, 6, 17 s |
| Realtime path | 16, 17, 18, 18, 445, 17 s |
| Auth path | 165, 152, 175, 154, 445, 161 s |
| Storage path | 203, 196, 217, 198, 445, 181 s |
| Pooler (login with the current password, 5 s poll) | 196, 196, 211, 196, 445, 178 s |

The R9 first cycle is an outlier on both operations (276 s to pause, 444 s to
unpause). In that cycle the Auth, Storage, Realtime and Pooler windows ran 445 s,
to the end of the unpause, while the REST window was 6 s; its pause-time
sampler window (150 s) ended before the project reached `INACTIVE`, so its
pause path columns are partial. No cause was found; other agents were using
the same control plane at the time. The other five cycles sit in a narrow band.

While parked, the first failing sample on REST and Auth read `HTTP 540`, on
Storage `HTTP 500` (R7, R8) and on the pooler `tenant/user ... not found`.
"Answer" for the HTTP paths is any non-5xx, the repo's convention for these
probes, so REST answering 15-20 s after the unpause request means the gateway
answered, not that PostgREST served rows.

Password across the cycle (one rotation per project, before the first pause):

- `PATCH database/password` while the project was `INACTIVE` was refused in
  R7, R8 and R9: `400` "Cannot reset password for non-active projects". The
  Management API SQL call while parked: R7 and R8 sent it with an empty project
  path (a module bug, `404`, not a finding); R9 sent it correctly and it
  timed out at 20 s. So the one password-change route tried
  (`PATCH database/password`) is refused while the project is parked, and SQL
  while parked timed out in R9 (invalid in R7 and R8). Whether the
  stale-credential condition the changelog describes (a password changed after
  the stored snapshot) can be produced on a Free project by another route was
  not tried.
- After each first unpause the password set before the pause (p2) logged in;
  the original (p1) and the one attempted while parked (p3) were refused with
  `password authentication failed` (R7, R8, R9). The second cycle, with no
  change, kept the same password (R7, R8, R9).
- The stored verifier fingerprint (first 8 hex characters of `md5(rolpassword)`
  for `postgres`) after the first unpause matched neither the pre-rotation nor
  the post-rotation value in R7, R8 and R9. Inference: the password was set
  again after the restore (a new salt), consistent with the changelog; a
  restore that only replayed the old verifier would match one of the two.
- Rows written before the pause were present; Storage list, download (bytes
  equal to the object stored before the pause) and upload answered `200` after
  every unpause. No Storage `500` was observed after any unpause.
- `GET /health` right after `ACTIVE_HEALTHY` read `realtime=COMING_UP` in R7
  and all healthy in R8 and R9.

## RP02 - PITR restore on a Small Pro project (R2-R6)

Subject: Pro, Small compute (PITR needs Small), `pitr_7` applied by the
module and removed in `finally`, a 2 GB gp3 disk (read from the disk config in
R5 and R6), a seed row, a bucket and an object. Sequence per run: enable PITR,
note a target instant T, 15 s later rotate the db password (p1 to p2), insert a
second row, then `restore-pitr {T}`. A control follows: rotate again (p3), pick
a new target after that rotation, restore again. "Clean" below excludes R4's
pre-rotation restore: 9 clean restores (4 pre-rotation targets: R2, R3, R5, R6;
5 controls: R2-R6).

Enabling PITR (5 runs): `PATCH billing/addons` `200`, and the first
`GET database/backups` read (0 s, 15 s polling) already showed
`pitr_enabled=true` and a window. `backups` listed zero entries once PITR was
on; the window is in `physical_backup_data`. At enable time the window width
was 359 or 360 s in all five runs and both ends were before the create call
(author's reading of the run logs: earliest 352 to 557 s before the create
call, latest from 197 s before to 7 s after it; the create timestamps are not in
the JSON measurements, so this offset is unrecorded). The reason is not known.

Acceptance of a target. The first attempt was refused `400` "Recovery time
target must be within range: <earliest> <= t <= <latest>" in 8 of the 9 clean
restores (all but R5's pre-rotation restore, whose target was already inside
the range because seeding took minutes). Where the target was recorded (R3,
R4 control, R5 control, R6) it sat 19 to 96 s past the quoted upper bound.
Retries ran every 60 s: the second attempt (accepted `201` at 60 s) succeeded in
R2 control, R3 control and both R6 restores; the third (121 s) in R2 and R3
pre-rotation, R4 control and R5 control. The lag is bounded by those 60 s steps,
not resolved.

| per clean restore | value |
|---|---|
| project status back to `ACTIVE_HEALTHY` (10 s polling), pre-rotation target | 30 s (R2, R3, R6, 10 MB database), 81 s (R5, 574 MB) |
| same, control restores | 40, 30, 41, 40, 30 s (R2, R3, R4, R5, R6; R4's database was 715 MB, R5's 574 MB) |
| REST, Auth, Realtime paths (1 s probes) | no failed sample during any of the 9 restores (REST here is anon GET /rest/v1/, which never reads the database; see the 2026-10-23 correction below); one simultaneous timeout on all three 338 s after R5's first request, no recovery recorded, not explained |
| Storage path | a failure window of 12 s in 8 of 9 restores, 24 s in R5's control; mode `The operation timed out`, never an HTTP 5xx |
| pooler path (5 s login poll) | 5 to 13 s on 10 MB and on R4's control (715 MB); 41 s in R5's pre-rotation restore (574 MB); 23 s in R5's control; error texts `the database system is not accepting connections`, `is starting up`, `is shutting down`, `econnrefused`, `terminating connection due to administrator command` |

Which password. After every clean restore the current password logged in
through the pooler and the replaced one was refused, and the end-state check
repeated after the poller stopped agreed. Data was rolled back as asked: the
row inserted after the target was gone in R2, R3, R5 and R6, and the control
rows were kept.

- The current password was refused for a short span between "the database
  answers" and "the password works": one 5 s poll in R3, R5 and R6 (pre-rotation
  targets) and in R3, R4 and R5 controls (5 to 6 s); not seen in R6's control.
  R2 used the intermediate poller. Read it as at most about 10 s with 5 s
  resolution, not as a measured duration.
- The stored verifier fingerprint after each restore matched neither the
  pre-rotation nor the post-rotation value, including after the control
  restores, whose target was after a rotation (a plain replay would have
  reproduced that rotation's fingerprint). Inference: current credentials were
  set again after the restore each time, as the changelog says, and the refusal
  span is the interval before that step finished. Not separated: that reading
  from a pooler-side cache.
- Every target here was minutes old. A restore from a backup older than a
  rotation by hours or days was not run.

Storage after restore (all clean restores): bucket list, object list, download
of the object stored before the restore (bytes equal) and a new upload
answered `200`; no `500`. R6 wrote one more object after the target and
restored to before it: the download answered `404` `not_found`, the bucket
listing did not contain it, and writing the same path again without upsert
answered `200`. What happened to the file in object storage was not read.
`GET /health` read `realtime=COMING_UP` right after the restore in R3, R4 and
R6 and all healthy in R2 and R5.

Size. R5 grew the database to 574 MB (`pg_database_size`) in four 500k-row
batches: `pg_ls_waldir` summed 736 MB against a 574 MB database, with 505 MB
free of 1981 MB. R4 asked for 1500 MB on the same disk and hit `No space left
on device` at 715 MB; the password rotation then answered `400`, so p1 stayed
the live password and R4's pre-rotation restore is not comparable (its
end-state check had p1 working and p2 refused). That restore's first attempt
answered `400` "Failed to check for major version of database. Database
appears to be unreachable" with a `57P03` error and was accepted at 301 s. What
filled the disk (WAL not yet archived, or something else) was not separated;
the WAL figure is from R5 only. Restore time against size is one point (574 MB,
81 s) beyond the 10 MB runs: not a curve.

PITR on-time per run: R2 0.12 h, R3 0.12 h, R4 0.24 h, R5 0.21 h, R6 0.10 h.

## Cost and teardown

Fourteen projects over the session: ten Pro and four Free (author's count from
memory; no project list snapshot was saved). The Pro projects:
seven with `pitr_7` (the five measured runs R2-R6, one killed RP02 run, one
exploration project), and three without (two Small for RP01's first versions,
one default-compute for the final RP01). The Free projects: R7, R8, R9 and one
killed mid-pause. PITR hours total about 1 h (0.79 h from the per-run figures above plus
the killed run and the exploration project) at the docs price of 0.137 USD/h
for the 7-day add-on (backups guide); Small compute and the default Pro
projects were not priced here. Estimated total under 2 USD (author's estimate, not recorded elsewhere;
unverified for compute). Three runs were killed by the author, per the author's
recollection: two are described in this log (the RP02 attempt with
`rp02-run1-aborted.log`, and the mid-pause Free project); the third is not
recorded. Their projects were deleted by hand, as was the exploration project;
deleting a
project that was still `PAUSING` answered `400` "Project is pausing and is not
ready for deletion" until it settled. A delete issued while `pitr_7` removal
was still processing (`429` "still processing addon changes") succeeded for
the project.

## Not measured

- Restore to a new project (clone): Dashboard only, refused a PAT; the
  password after a clone is unread. Storage after a clone is in the lexicanum
  major-upgrade guide (dashboard clones, 2026-07-29 and 2026-08-04), not this
  experiment. The docs list what is not copied
  (Storage objects and settings among them); not tested.
- The Dashboard's physical-backup restore, and `backups/restore` on any
  project where it answers (still "unavailable" on Team, RP04, 2026-10-20).
- A restore target hours or days old; a database over 1 GB; a Free project
  parked longer than minutes; auto-pause.
- Direct 5432 (IPv6 only; no IPv6 route from the vantage).
- Why the PITR window at enable time ends before the create call.
- Restore time at production data sizes.

## 2026-10-20 - RP04 (Team daily-backup restore) and RP05 (migration rollback)

Same vantage (IPv4-only workstation), ap-southeast-1, default compute on
every project (Micro by default; size not read back). Question behind both: what a project with no PITR add-on
can use to recover from a deleted-data mistake or a bad release.

| run | module | start (UTC) | org | what | artifact |
|---|---|---|---|---|---|
| R10 | RP04 | 09:49 | Team | daily-backup restore route, retention recorded as the entitlement flag only | `out/2026-10-20/run-2026-10-20T09-49-42-217Z.json` |
| R11 | RP05 | 09:52 | Pro | migration rollback on the production project (RP05a-e) | `out/2026-10-20/run-2026-10-20T09-52-11-293Z.json` |
| R12 | RP05 | 09:53 | Pro | as R11, plus a git-less preview branch (RP05g) | `out/2026-10-20/run-2026-10-20T09-53-31-105Z.json` |
| R13 | RP04 | 09:53 | Team | as R10, with the retention value recorded | `out/2026-10-20/run-2026-10-20T09-53-54-870Z.json` |

The artifacts record lab commit `3a6ca0a`; RP04 and RP05 ran from the
working tree, revised between R10 and R13 (retention value recorded) and
between R11 and R12 (RP05g added), and the committed sources are the R12 and
R13 revisions.

Every project and the R12 branch were deleted in `finally` (`DELETE 200` in
each artifact). A `GET /v1/projects` after R13 listed no `rp-*` project
(author's check, no snapshot saved).

### RP04 - daily-backup restore on a Team org (R10, R13)

- Entitlements on the Team org: `project_cloning` true,
  `backup.restore_to_new_project` true, `pitr.available_variants` true,
  `backup.schedule` false, `backup.retention_days` 14 (R13; R10 recorded only
  the access flag). A manual call on the same day (no artifact) read 7 for
  `backup.retention_days` on the Pro org and the PITR variants
  `pitr_7, pitr_14, pitr_28` (the Team artifacts record only that
  `pitr.available_variants` is granted, not the set; the same manual call
  read the same set on Team).
- One COMPLETED physical backup was listed on the first read after the
  project reported healthy, in both runs.
- `POST database/backups/restore {id}` with that backup's id answered `400`
  "This endpoint is unavailable at the moment" on 4 attempts over 180 s in
  both runs; `GET database/backups/restore-point` answered the same. That is
  the RP01 answer on Pro (2026-10-10); sfp-platforms recorded the same body
  on Pro and a `400` status for restore points on Team (2026-09-03). No restore ran, so there is no downtime figure.
- Before the restore attempt the module rotated the db password (new one
  logged in, old one refused) and wrote a marker row and an object; with no
  restore those are unexercised.
- Observation, not explained: in R13 the project named from a timestamp of
  09:53:54.871Z (the module's create call) reported `created_at`
  09:48:11Z in `GET /v1/projects` (the author's manual call during the run,
  no artifact; the value is 09:48:11.168Z, within a second of R10's backup
  `inserted_at` 09:48:11.128Z), and its listed backup carried
  `inserted_at` 09:53:07.981Z (artifact). Both precede the create call. One reading is
  a pre-provisioned instance handed to the request; it was not tested. R10's
  backup also predates that run's start.

### RP05 - the migrations rollback route (R11, R12)

The published OpenAPI document lists `DELETE
/v1/projects/{ref}/database/migrations?gte=<version>` ("Rollback database
migrations and remove them from history table", no description) and an
optional `rollback` string on the apply and upsert bodies.

Production project (R11 and R12 agree on every row):

| step | answer |
|---|---|
| apply M1 (create table, `rollback` = drop table), M2 (add column, `rollback` = drop column), M3 (create table, no `rollback`) | `200` each; versions `YYYYMMDDHHMMSS` |
| `GET migrations/{M2}` | `statements` and `rollback` both returned as stored |
| `GET migrations/{M3}` | `rollback` null |
| `DELETE ?gte=M3`, `DELETE ?gte=M2` | `400` "You cannot rollback a production branch." each time; history, schema and M1's row unchanged |
| apply M4 (add column, `rollback` that errors), `DELETE ?gte=M4` | apply `200`; DELETE `400`, same message; column kept |
| apply M5 (`create table ...; select 1/0`) | `400` `Failed to apply database migration: ERROR:  22012: division by zero`; M5's table absent, M5 not in history |

Preview branch of the R12 project (`POST /projects/{ref}/branches`,
`with_data: false`), n=1:

- Branch create `201`, then `ACTIVE_HEALTHY` (10 s polling). The module's
  detail line reads "after 27s", but that figure is taken when the RP05g row
  is written, after the applies and the DELETE, so it bounds the time to
  healthy (at most 27 s) without measuring it. The module records
  `branch_healthy_s` from the next run on.
  Its history held the parent's M1-M4 when the module read it.
- Applied B1 (create table + row, `rollback` = drop table), B2 (add column,
  `rollback` = drop column), B3 (create table, no `rollback`): `200` each.
- `DELETE ?gte=B2`: `200`, body `[]`. History afterwards ended at B1 (B2 and
  B3 removed). B2's column was gone; B3's table was still there; B1's table
  and row were kept.
- Reading: the route removes every history row from the cut onward and runs
  the stored `rollback` SQL of those rows; a row with none stored leaves its
  change in place. Two rows were cut in one call; the order the rollbacks run
  in, and what happens when a stored rollback fails on a branch, were not
  run (M4's erroring rollback was only tried on production, where the route
  refuses before running anything).

Not measured: `supabase migration repair` and `supabase db push` against
the same history; a branch merge after a rollback; a rollback on a branch
created with git; a stored rollback that fails on a branch.

## 2026-10-22/23 - RP06 (PITR recovery point) and RP07 (restore time against size)

Questions: how far behind "now" the latest recoverable instant of a PITR
project sits, under a light writer and idle (the backups guide: WAL backed up
at two-minute intervals, worst-case RPO two minutes, and an idle database can
show a restore point far behind the current time); what a restore to that
instant keeps; and how restore time grows past 1 GB (RP02 stopped at 574 MB).

Same vantage (IPv4-only workstation), Pro org, ap-southeast-1, every project
created on Small by the module with `pitr_7` applied by the module. All runs
recorded lab commit `3a2f9bd` and ran from the working tree; the committed
sources are the final revisions (RP06 from R24, RP07 from R22/R23). Every
project was deleted in `finally`: `DELETE 200` in every published artifact
(R14's included), and in the local reports of R16 and R17 (local only, not
published); a `GET /v1/projects` at 01:04 UTC on 2026-10-23 listed no `rp-*`
project (author's check, no snapshot saved).

| run | module | start (UTC) | what | artifact |
|---|---|---|---|---|
| R14 | RP06 | 2026-10-22 22:38 | RP06a-c (20 min writer phase, 20 min idle phase); RP06d aborted (below) | `out/2026-10-22/run-2026-10-22T22-38-06-919Z-rp06-r1.json` |
| R15 | RP07 | 2026-10-22 22:38 | 3 GB then 10 GB; first revision (no target or WAL columns, no `rest_read` probe) | `out/2026-10-22/run-2026-10-22T22-38-06-919Z-rp07-r1.json` |
| R16, R17 | RP07 | 2026-10-22 23:16 | aborted after RP07a by the same socket error; local only, not published | (none) |
| R18 | RP07 | 2026-10-22 23:37 | 3 GB then 10 GB, target and WAL columns, `rest_read` probe | `out/2026-10-22/run-2026-10-22T23-37-21-953Z-rp07-r2.json` |
| R19 | RP07 | 2026-10-22 23:37 | as R18 with `RP07_WAIT_ARCHIVER=1` (control) | `out/2026-10-22/run-2026-10-22T23-37-21-953Z-rp07-r3-control.json` |
| R20, R21 | RP06 | 2026-10-23 00:17 | RP06d only (`RP06_PHASE_MIN=0`), second revision | `out/2026-10-23/run-2026-10-23T00-17-23-628Z-rp06-t1.json`, `...-626Z-rp06-t2.json` |
| R22 | RP07 | 2026-10-23 00:17 | 10 GB only, plus recovery log lines | `out/2026-10-23/run-2026-10-23T00-17-23-645Z.json` |
| R23 | RP07 | 2026-10-23 00:17 | 3 GB then 10 GB, plus recovery log lines | `out/2026-10-23/run-2026-10-23T00-17-23-754Z.json` |
| R24 | RP06 | 2026-10-23 00:55 | RP06d only, final revision, writer for 4 min before the restore | `out/2026-10-23/run-2026-10-23T00-55-48-026Z.json` |
| R25 | RP06 | 2026-10-23 00:56 | as R24, writer for 5 min | `out/2026-10-23/run-2026-10-23T00-56-12-266Z.json` |

Runs started together share a `startedAt` stamp to the millisecond (R14/R15,
R16/R17, R18/R19); the published copies carry a suffix to keep them apart.
R14's RP06d, R16 and R17 died on `The socket connection was closed
unexpectedly` from a Management API fetch (no retry on a thrown fetch then);
the modules now retry a throw on their own reads (`again()` in `lib/rp.ts`).
The orchestrator Mac was asleep from 23:17:28 UTC (host sleep audit below):
R14's RP06d died after that sleep, and R16 and R17, started at 23:16 (run
table above), ran across it (the times of their failures were not kept), so
the socket errors fit fetches cut by a sleep.

### A correction (2026-10-23) to the `rest` path in RP02 (RUNLOG 2026-10-10 table)

The sampler's `rest` probe is `GET /rest/v1/` with the anon key
(`platform-downtime/lib/probes.ts`); it answers `401` without reading the
database, and anything below 500 counts as up. RP02's "REST, Auth and
Realtime showed no failed 1 s sample" is therefore the HTTP tier answering,
not a Data API read succeeding. From R18 on, RP07 adds a `rest_read` probe
(`GET /rest/v1/rp_marker?select=*&limit=1` with the service_role key, up only
on `200`); RP06 points it at `rp_writes` from R24 (R20/R21 pointed it at a
table RP06 never creates: `404 PGRST205` throughout, so their `rest_read`
column is void). Every restore where `rest_read` was valid shows the read
failing with `503 PGRST002`: 15 s of R24's 30 s to healthy and 14 s of R25's
41 s, and 192 to 544 s in the seven RP07 restores that carried the probe
(R18, R19, R22, R23; tables below; R18's 211 s and R19's 202 s at 3 GB are
upper bounds, host sleep audit below), while `rest` in the same runs failed in
none of those 9 restores (R18's 3 GB 6 s is a sample cut by a sleep, void;
host sleep audit below).

### RP06 - lag of the latest recoverable instant (R14)

Archive settings read from Postgres (RP06a, identical in all five RP06 runs):
`archive_timeout=120 checkpoint_timeout=300 max_wal_size=4096 wal_level=logical
wal_segment_size=16777216`, `archive_mode=on`.

The upper bound was read every 15 s from the `restore-pitr` refusal for a
target a week ahead ("Recovery time target must be within range: <earliest>
<= t <= <latest>"); lag = local clock at the read minus `<latest>`.

| R14 | writer phase (RP06b) | idle phase (RP06c) |
|---|---|---|
| writer | 6115 rows acked, 4.97 rows/s, one session-pooler connection | stopped |
| samples | 80 | 75 |
| bound lag min / p50 / max | 1 / 47 / 227 s | 2 / 212 / 752 s |
| samples over 120 s | 1 (the first, 227 s) | 51 |
| series | 2 to 107 s rising in 15 s steps, back to 1 or 2 s every 8 samples (120 s) | two resets to 2 s in the first 25 samples, then climbs without a reset to 752 s |
| `GET database/backups` `physical_backup_data.latest_physical_backup_date_unix` lag min / p50 / max | 1 / 47 / 227 s | 2 / 212 / 752 s |
| `pg_stat_archiver.last_archived_time` lag min / p50 / max | 2 / 49 / 228 s | 2 / 212 / 752 s |

Reading: the quoted upper bound tracks the archiver's last archive time
(the three columns' min / p50 / max agree to within 2 s in both phases of
R14; R24 and R25 read the difference directly as 0 and -1 s). Under this writer the bound advanced once
per `archive_timeout` and its lag stayed at or under 107 s after the first
sample, which fits the documented two minutes; idle, nothing was archived
after the early resets and the lag grew for the rest of the phase. The
`latest_physical_backup_date_unix` field carries the same value as the
archiver time, not the time of a physical backup. One writer rate, one
region, n=1 per phase.

### RP06 - restore to the latest recoverable instant under a writer (R20, R21, R24, R25)

Writer as above (about 5 rows/s), the bound L read after 4 min (R25: 5 min) of
writes, `restore-pitr {L}` issued at once. "Acked" rows are those the writer
got a reply for, with `written_at` from the database clock; only rows
acknowledged before the restore request count. R20 and R21 ran a revision
whose writer kept writing after the restore was accepted (its later rows
landed in the restored database). Void in R20 and R21: `rows_restored`,
`restored_rows_after_target_plus_1s`, `newest_restored_minus_target_s`,
`acked_total` and `acked_after_target` (all include post-restore writes).
Standing: `acked_before_target`, `acked_before_target_missing` and
`acked_before_issue_lost` (6 and 27), because the writer's sequence numbers
only grew, so a post-restore row cannot fill a lost one, and both counts take
only rows acknowledged before the request.

| run | bound age at read | back `ACTIVE_HEALTHY` | acked rows written before L that were missing | ages of those rows before L | newest kept row before L | acked rows lost against the moment the restore was issued |
|---|---|---|---|---|---|---|
| R20 | 1 s | 40 s | 2 of 1189 | not recorded | not recorded | 6 |
| R21 | 4 s | 40 s | 4 of 1170 | not recorded | not recorded | 27 |
| R24 | 87 s | 30 s | 3 of 764 | 0.42, 0.22, 0.02 s | 0.62 s | 436, spanning 87.4 s |
| R25 | 111 s | 41 s | 4 of 939 | 0.79, 0.59, 0.39, 0.18 s | 0.99 s | 560, spanning 112.3 s |

- In R24 the archiver's last archived segment was `...05` with the writer
  in `...06`, and `postgres_logs` recorded `starting point-in-time recovery
  to WAL location (LSN) "0/501CA08"`: the platform restores to an LSN, not to
  the requested time. R22 and R23 logged `recovery stopping after WAL
  location (LSN) ...` for their restores too.
- No restore in R24 or R25 kept a row written after L
  (`restored_rows_after_target_plus_1s` 0; the newest restored row sat 0.6 s
  and 1 s before L).
- Reading (not separated by a probe): L is the time the last segment
  finished archiving, and the restore stops at the end of that segment's WAL.
  A commit that landed in the next segment between the segment switch and the
  archive finishing has a `written_at` before L and is not restored. Here
  the lost window ran from the newest kept row (0.62 s before L in R24,
  0.99 s in R25) to L; the missing rows were 0.02 to 0.42 s (R24) and 0.18
  to 0.79 s (R25) old at L. A restore issued at time T keeps nothing after
  L, so it loses the writes between L and T, the bound's age at T (87 and
  111 s here).
- Per path (R24, R25; 1 s probes): `rest_read` `503 PGRST002` for 15 and 14
  s; pooler 5 s each; Storage 15 and 24 s (`The operation timed out.`); `rest`,
  Auth and Realtime no failed sample.

### RP07 - restore time against database size (R15, R18, R19, R22, R23)

Disk grown once to 40 GB with `POST /config/disk` right after PITR was
enabled: `201`, the new size visible in `config/disk/util` after 302 s (R15,
R18, R19, R22) and 301 s (R23), polled every 20 s. Fill: 1M-row INSERTs of ~230 B rows over the session
pooler. After each fill the module waited for the quoted upper bound to pass
the fill's end plus 10 s, then restored to that bound. Every restore went
`ACTIVE_HEALTHY -> RESTORING -> ACTIVE_HEALTHY` (10 s polling).

| run | size | fill (s, MB/s) | bound wait (s) | target after fill end (s) | back `ACTIVE_HEALTHY` (s) | `rest_read` down (s) | pooler down (s) | Storage down (s) | rows before / after |
|---|---|---|---|---|---|---|---|---|---|
| R15 | 3111 MB | 130, 23.9 | 30 | not recorded | 222 | no probe | 182 | 18 | 11,000,000 / 11,000,000 |
| R15 | 10441 MB | 311, 23.6 | 30 | not recorded | 787 | no probe | 330 | 12 | 37,000,000 / 31,000,000 |
| R18 | 3210 MB | 129, 24.8 | 121 | 121 | 221 (upper bound, #234) | 211 (upper bound) | 322 (upper bound) | 12 | 11,000,000 / 11,000,000 |
| R18 | 10482 MB | 290, 25.1 | 31 | 26 | 555 | 417 | 400 | 15 | 36,000,000 / 36,000,000 |
| R19 control | 3210 MB | 128, 25 | 131 | 128 | 322 (upper bound, #234) | 202 (upper bound) | 315 (upper bound) | 18 | 11,000,000 / 11,000,000 |
| R19 control | 10482 MB | 291, 25 | 61 | 51 | 545 | 415 | 402 | 12 | 36,000,000 / 36,000,000 |
| R22 | 10482 MB | 1114, 9.4 (void, #234) | 152 | 123 | 697 | 544 | 531 | 12 | 36,000,000 / 36,000,000 |
| R23 | 3210 MB | 116, 27.6 | 208 (void, #234) | 170 (void, #234) | 232 | 192 | 176 | 12 | 11,000,000 / 11,000,000 |
| R23 | 10482 MB | 216, 33.7 | 31 | 29 | 475 | 320 | 320 | 15 | 36,000,000 / 36,000,000 |

"Down" is the longest contiguous failure window from the sampler at 1 s
(pooler: the 5 s login poll). R22's fill started from an empty table and was
the slowest of the runs; its artifact records `fill_error` `Connection
terminated unexpectedly` and 35 counted statements against 36,000,000 rows,
so one statement committed after the client lost its connection, and the
reconnect wait (15 s) sits inside the fill time; the rate itself is not
explained. The 10 GB rows in R15, R18, R19 and
R23 are a second fill on top of the restored 3 GB database; R22 filled to
10 GB in one pass.

- Time to `ACTIVE_HEALTHY` at 3111 to 3210 MB: 222 s (R15) and 232 s (R23)
  taken awake; R18 between about 67 and 221 s and R19 between about 59 and
  322 s, the 221 s and 322 s being the first polls after a sleep of the
  orchestrator Mac (host sleep audit below). 475 to 787 s at 10441 to 10482
  MB (n=5). Against RP02 (30 s at 10 MB, 81 s at 574 MB) time grows with size at
  this compute; n is small and the spread at each size is wide.
- What replay cost, from `postgres_logs` (R22, R23): `redo done ...
  elapsed: 166.13 s` (R23, 3 GB), `278.96 s` (R23, 10 GB), `512.03 s` (R22,
  10 GB); the rest of the time to healthy is outside replay.
- The Data API read (`rest_read`, the 7 restores in R18, R19, R22, R23) was
  down for 192 to 544 s, and the pooler for 176 to 531 s across all 9; the
  `rest` probe (anon on `/rest/v1/`) showed no failure in 8 of 9 restores
  and 6 s in one. Auth (`/auth/v1/health`) failed for 144 s in R19's 3 GB
  restore and not at all in the others; Realtime for 144 s in R18's 3 GB
  restore and 6 s in R19's 3 GB restore. **Void (host sleep audit below):**
  the 144 s Auth and Realtime windows are the 144 s sleep and the 6 s
  `rest` and Realtime windows are samples cut at a wake, so Auth, Realtime
  and `rest` failed in none of the 9 RP07 restores. R18's and R19's 3 GB
  `rest_read` and pooler windows are upper bounds; the range ends (192,
  544; 176, 531) are awake runs and stand.
- R18's 3 GB restore ended with the current password refused by the pooler
  (`cred_final_current` `refused`; pooler down 322 s against 221 s to
  healthy); every other RP07 restore ended `ok`. Not followed up. Void as a
  finding (host sleep audit below): the credential watch spanned both
  sleeps, and the pooler window closed 3 s after the second wake.
- **R15's 10 GB restore came back short**: 31,000,000 of 37,000,000 rows,
  and without the `filled-10gb` marker row written after the fill. The
  restore answered `201` and the project returned to `ACTIVE_HEALTHY`;
  nothing in the API said the target had not been reached. That revision did
  not record the target, the WAL position or the recovery log, so how far
  short it stopped is known only from the missing rows: the last 6 of 26 fill
  statements and everything after. The four later 10 GB restores (R18, R19,
  R22, R23) kept every row, and in each the archiver was caught up at the
  fill's end and at the restore (`segments_behind=1`: only the segment being
  written was unarchived). Untested reading: if the archiver falls behind,
  the quoted bound (last archive time) runs ahead of the archived WAL and a
  restore to it stops short. Nothing recorded in R15 shows a backlog: its
  fill rate (23.6 MB/s) sat below R18, R19 and R23 (24.8 to 33.7 MB/s), and
  its bound wait (30 s) and `wal_mb_before_restore` (4096) match the clean
  runs. R15 is 1 of 5 10 GB restores; the control (R19, waiting for the
  archiver to pass the fill-end segment) did not separate anything, because
  its archiver had already caught up when the wait began (`archiver_wait_s`
  0 at both sizes). The check before trusting a restore to "latest":
  compare `pg_stat_archiver.last_archived_wal` with
  `pg_walfile_name(pg_current_wal_lsn())`; a gap of 1 segment is caught up.

Not measured: which base backup each restore started from (the backups
endpoint listed no physical backup before any of the 9 RP07 restores, as
RP02 saw once PITR is on); other compute sizes; a heavy writer's effect on the bound lag;
restore-to-latest with the archiver measurably behind (the case R15
suggests; run as RP08 on 2026-10-23, below); the Dashboard's restore button, which may pick its target
differently.

### Host sleep audit (2026-10-26, #234)

The orchestrator Mac slept inside seven of this section's artifacts (R14,
R18, R19, R20, R21, R22, R23).
`harness/scripts/sleep-overlap.ts` against the sleep log
(`../platform-downtime/out/2026-10-26/host-sleep/overlap.txt`, the trimmed
`pm-events.tsv` beside it) walks each run's modules across the sleeps and
lands 4 to 9 s from `finishedAt`. A module's results share one duration, so
single restores are placed from their own fields: the fill end is
`target_unix` minus `target_minus_fill_end_s`, and a sampler path that was
up and first fails exactly at a logged sleep start, for that sleep's
length, marks when the call went in. Every timing in these modules is
wall-clock (`Date.now()`), so a sleep inside a window stretches it to the
first poll or sample after the wake. Times UTC.

| run | sleeps inside (s) | where they fell | outcome |
|---|---|---|---|
| R14 | 235, 184, 262 from 23:17:28 | RP06c's 75th sample is at 23:17:29 (the bound plus its lag), so the sleep stopped the idle phase 5 samples short of 20 min; RP06d died after it | RP06b unaffected; RP06c's values unaffected, its 752 s maximum a floor for a full 20 min; RP06d's abort fits the sleep |
| R18 | 144, then 100 after a 10 s dark wake (23:48:34 to 23:52:48) | 3 GB restore: Realtime first failed at 77 s for 144 s, the first sleep, so the call went in at about 23:47:17 and healthy was read at the wake | 3 GB: back healthy between about 67 and 221 s (10 s polls), `rest_read` down 66 to 211 s, pooler 65 to 322 s (bounded); Realtime 144 s, `rest` 6 s and the refused password void. 10 GB (fill from 23:54:05): unaffected |
| R19 | the same two | 3 GB restore: Auth first failed at 69 s for 144 s, so the call went in at about 23:47:25; healthy was read at 322 s, the second wake | 3 GB: back healthy between about 59 and 322 s, `rest_read` 59 to 202 s, pooler 58 to 315 s (bounded); Auth 144 s and Realtime 6 s void. 10 GB: unaffected |
| R20, R21 | 197, 262, 101, 104 (00:24:39 to 00:36:13) | Realtime first failed at 670 s for 100 s, the 00:32:38 sleep, so the call went in at about 00:21:28 and the project was back 40 s later, before the first sleep | the figures quoted above (bound age, 40 s, missing and lost rows) unaffected; the later Realtime, `rest` and Auth windows are sleeps (not quoted) |
| R22 | the same four | inside the 10 GB fill (00:22:34 to 00:41:08) | fill 1114 s and 9.4 MB/s void (at most 450 s of it ran awake); its `Connection terminated unexpectedly` fits a sleep (reading); the restore, called after 00:43, unaffected |
| R23 | the same four | 3 GB: the first inside the bound wait (fill end 00:24:29, wait 208 s); the call came after the last wake, because a call in any dark wake between the sleeps would put a sleep inside Storage's 12 s window | 3 GB bound wait (208 s) and target after fill end (170 s) void, the bound having been read at the wake; the 3 GB restore and all of 10 GB unaffected |

R15 (ended 23:14:42), R24 and R25 spanned no sleep. In R18 and R19 the
probes that failed were not the same per sleep (a sleep does not fail every
path), so a path with no failure does not show that no sleep fell in it;
the placements above rest on a failure that matches a logged sleep in start
and length, or on the poll that saw healthy landing at a wake.

## 2026-10-23 - RP08 (restore to the quoted latest instant while the archiver is behind)

Question: RP07 R15's 10 GB restore to the quoted upper bound answered `201`,
returned to `ACTIVE_HEALTHY` and kept 31,000,000 of 37,000,000 rows without
the post-fill marker. Can a short restore be reproduced, and does it follow
archiver lag? Three readings, each with the evidence only it predicts:

- H1, archiver lag: under heavy writes `last_archived_time` (the bound,
  RP06) keeps moving while segments wait to be archived, and a restore to the
  bound stops at the archive frontier. Predicts acked statements and the
  marker missing only when segments were waiting at the call, and a recovery
  stop LSN at or near the end of the last archived segment.
- H2, an earlier base backup or target: a stop LSN well below the frontier,
  loss with no backlog, or a recovery log naming an earlier target.
- H3, the fill had not committed: only unacknowledged statements missing.
  Every RP08 statement is acknowledged with its commit.

Same vantage, Pro org, ap-southeast-1, every project created on Small by the
module with `pitr_7` and the disk grown once to 40 GB (`POST /config/disk`
`201`, applied after 302 s in each published run). Postgres 17.11,
`archive_timeout=120 wal_compression=zstd max_wal_size=4096`. All runs ran
from the working tree on top of lab commit `661afdf`; R26 and R27 ran the
first revision (bulk load only, the log-timestamp defect and the frozen
pooler probe below, a 90 min restore wait), R29 and R30 the committed one. Each cycle writes with
N session-pooler connections; every statement commits its own `rp_ledger`
row in the same statement (ledger row present iff its writes are), a ticker
commits one `rp_tick` row per 250 ms, and a sampler reads
`pg_current_wal_lsn()`, `pg_stat_archiver` and the count of `.ready` files
every 10 s. Loads: `bulk` is RP07's rows (3 writers, 100,000-row INSERTs);
`wal` is the same bytes as one `pg_logical_emit_message` per statement (WAL
with no heap or index writes, a lever for a WAL rate above the archiver's).
Arms: `latest` stops the writers, inserts the marker, waits (30 s polls) for
the bound to pass the fill end plus 10 s and restores to the bound L (R15's
procedure); `explicit` does the same with the target `floor(now) - 2` read
just before the call; `live` inserts the marker and restores to L at once
with the writers running, halting them when the call is accepted.

| run | start (UTC) | load, writers | arms | artifact |
|---|---|---|---|---|
| R26 | 07:56 | bulk, 3 | latest, explicit | `out/2026-10-23/run-2026-10-23T07-56-08-998Z.json` |
| R27 | 07:56 | bulk, 3 | latest, live | `out/2026-10-23/run-2026-10-23T07-56-29-050Z.json` |
| R28 | 08:43 | wal, 4 | killed by the author during the first write phase (below) | (none; log local only) |
| R29 | 08:50 | wal, 4, 90 s writes | live x3 | `out/2026-10-23/run-2026-10-23T08-50-41-278Z.json` |
| R30 | 09:21 | wal, 8, 90 s writes | live x3 | `out/2026-10-23/run-2026-10-23T09-21-24-819Z.json` |

R28 used the default 480 s write cap; the archiver read 8 and 7 segments
behind at its 62 s and 93 s samples, and 480 s at that WAL rate would have
left roughly 30 GB of WAL to replay per cycle (reasoned, not measured), and the author killed it and restarted as
R29 with a 90 s cap. Its project's `pitr_7` and the project were deleted by
hand (`DELETE` `200` each). R26, R27, R29 and R30 deleted theirs in
`finally` (`DELETE` `200` in each artifact); a `GET /v1/projects/{ref}` of
all five refs answered `404` at 10:04 UTC (author's check, no snapshot).

WAL rate, derived from the first and last LSN of each cycle's sampled series
(evidence field, not a measurement column; MiB/s): 32.4 and 34.0 MiB/s for
R26's two bulk cycles, 68.8 to 71.6 MiB/s for R29 (4 writers) and 63.5 to
71.6 MiB/s for R30 (8 writers).

| run, cycle | arm | `ready` / segments behind at the call | stop segment minus last archived at the call | stop LSN written at minus target (s) | acked statements before the target missing | ticks before the target missing | marker (target minus marker, s) | back `ACTIVE_HEALTHY` (s) |
|---|---|---|---|---|---|---|---|---|
| R26 1 | latest | 0 / 1 | not logged | not logged | 0 of 219 | 4 of 1451 (oldest 1 s) | kept (119.9) | 414 |
| R26 2 | explicit | 0 / 1 | not logged | not logged | 0 of 222 | 0 of 1068 | kept (28.6) | 545 |
| R27 1 | latest | 0 / 1 | 1 (log read by hand) | not computed | 0 of 220 | 0 of 1314 | kept (23.3) | 465 |
| R27 2 | live | 1 / 2 | 1 (log read by hand) | not computed | 0 of 219 | 0 of 945 | kept (0.4) | 10 (below) |
| R29 1 | live | 3 / 8 | 9 | 0.1 | 0 of 306 | 1 of 314 (0.1 s) | kept (1.2) | 323 |
| R29 2 | live | 2 / 7 | 5 | -0.5 | 0 of 312 | 0 of 366 | kept (0.6) | 313 |
| R29 3 | live | 4 / 8 | 7 | 0.1 | 0 of 303 | 0 of 343 | kept (0.8) | 354 (upper bound, #234) |
| R30 1 | live | 9 / 12 | 8 | 0.2 | 1 of 278 (0.4 s) | 0 of 302 | absent (-0.3) | 283 |
| R30 2 | live | 14 / 33 | 33 | 0.4 | 0 of 312 | 0 of 321 | absent (-0.2) | 313 |
| R30 3 | live | 14 / 31 | 26 | 0.3 | 1 of 305 (0.2 s) | 1 of 331 (0 s) | kept (0.4) | 313 |

"Segments behind" is the gap between `pg_walfile_name(pg_current_wal_lsn())`
and `last_archived_wal`; `ready` counts completed segments not yet handed to
the archiver, so the difference is segments in flight. "Stop LSN written at"
interpolates the stop LSN from the recovery log over the cycle's (database
time, LSN) samples. R26 and R27 recorded no recovery log: the module parsed
the logs endpoint's zone-less timestamps as local time and filtered out every
line (fixed before R29; R29 and R30 carry the lines). R27's lines were read by
hand from the logs endpoint at 08:46 UTC while its project was up (local
only): cycle 1 `recovery stopping after WAL location (LSN) "2/91C7870"` and
`last completed transaction was at log time 2026-10-23 08:07:08.579569+00`
against a target of 08:07:09; cycle 2 `"4/2482A9B8"` and `08:25:32.598465`
against 08:25:33. The published R26 and R27 artifacts read `outside sampled
range` in `stop_lsn_written_at_minus_target_s`: that is the value the first
revision wrote when no stop LSN was found (the module now writes `no stop
LSN`). This branch's RP08 artifacts are the four in the run table; two other
2026-10-23 artifacts carrying RP08-prefixed result ids (07:58 and 08:17 UTC)
come from a parallel branch's slots module (RP09) and are not part of this
run.

- **R15 did not reproduce: 0 of 10 restores came back short**, where short
  means losing more than RP06's sub-second window: none lost more than 1
  acked statement, all within 0.4 s of the target (4 bulk with no backlog, 6
  WAL-load `live` restores with 7 to 33 segments unarchived at the call).
- The bound does run ahead of the archived WAL under load: in R29 and
  R30 the bound at the call sat 0 to 2 s behind the local clock and 0 to 1 s
  from `last_archived_time`, while 7 to 33 segments were unarchived. H1's
  premise holds on Small at 63.5 to 71.6 MiB/s of WAL (derived, above).
- **The restore did not stop at the archive frontier (H1 falsified for these
  backlogs: Small, `live` arm, 90 s writes).** In the 6 restores with a
  backlog, all `live`, the stop LSN lay 5 to 33 segments past the last segment
  archived at the call, and the same count past the last archived when the
  `201` came back; it sat -5 to +1 segments from the segment being written at
  the call, and its write time, interpolated over 10 s samples, was -0.5 to
  +0.4 s from the target. The recovery log's `last completed transaction`
  (its log time against the target, derived) was 0.26, 0.50 and 0.13 s before the target in R29 and 0.02, 0.32 and 0.27
  s in R30, and in R29 2 and R30 2 the newest kept tick (0.2 s before the
  target) is later than that logged commit, so sub-second placement is not
  established by either. The `latest` arm (R15's procedure) never had more
  than 1 segment behind at the call, so it was not tested under a backlog. Reading (not separated by a probe): the platform gets the WAL
  past the frontier before recovery, for instance from the old instance
  archiving its remaining segments as it shuts down.
- Acked statements lost sit inside RP06's window; one tick sits just
  outside it. Acked statements written before the target and missing: 0 in 8
  of 10 restores, 1 at 0.4 s (R30 1) and 1 at 0.2 s (R30 3); ticks: 4 in R26
  1 (oldest 1 s before the target, past RP06's 0.79 s), 1 in R29 1 (0.1 s),
  1 in R30 3 (0 s). RP06 measured
  0.02 to 0.79 s. The marker absences in R30 cycles 1 and 2 are markers
  committed 0.3 and 0.2 s after the target (the target is a whole unix
  second). No acked statement written after the target plus 1 s was kept
  (ticks after the target were not counted).
- H3 does not fit any of these restores: no acked statement older than
  0.4 s before the target was missing, and in the four bulk cycles `rp_bulk`
  held exactly the ledger's rows times 100,000 (21,900,000, 22,200,000,
  22,000,000, 21,900,000).
- In R29 and R30 each restore after the first started from a base backup
  whose redo LSN sat 2 segments past the previous restore's stop LSN (R26 and
  R27 logged no such line): `starting backup recovery with redo LSN
  1/A0000028 ... on timeline ID 2` after a stop at `1/9EC400C0` (R29 2),
  `3/44000028` after `3/42CE41A8` (R29 3), `1/7D000028` after `1/7B9BFE68`
  (R30 2), `3/21000028` after `3/1FCE2F00` (R30 3); R30's first restore
  started from `0/2000028` on timeline 1. Nothing here picked an earlier
  backup or target; H2 was not tested in R15's shape (a 10 GB fill on top of
  a restored 3 GB database).
- The archiver kept up with the bulk load: in the sampled series (10 s)
  `ready` never above 2 and segments behind at most 4 in R26 and R27 (32.4
  and 34.0 MiB/s of WAL in R26, derived). The WAL load peaked at 9 to 11 segments
  behind (`ready` 4 to 5) with 4 writers (R29) and 23 to 49 (`ready` 12 to
  26) with 8 (R30), and moved up and down rather than growing through the
  90 s writes (R30 2: 40 and 49 segments at the 62 s and 83 s samples, 33
  at the call).
- **R27 2: the project status read healthy before the database went down.**
  Statuses `RESTORING -> ACTIVE_HEALTHY` with `ACTIVE_HEALTHY` 10 s after the
  `201` (10 s polling, which stops at the first `ACTIVE_HEALTHY`);
  `rest_read` first failed at 58 s and stayed failed for 385 s, the pooler
  answered `the database system is shutting down` from 60 s (the credential
  watch saw it at 62 s), and `pg_postmaster_start_time()` read 08:32:52 UTC
  by hand, not in the artifact (the target L was 08:25:33 and the call went
  in 2 s later). The status was not read during the outage. In the other 9
  restores the status went back to healthy after 283 to 545 s. 1 of 10.
  (R29 3's 354 s is an upper bound, below; the range ends stand.)
- Password after the restore (R18 recurrence): no restore ended with the
  current password refused (0 of 10). 8 of 10 ended `ok` inside the
  credential watch; R27 2 and R29 3 ended `down` when the watch stopped and
  the next login after it succeeded (R29 3's watch spanned a sleep, below).
  The single 5 s poll that refuses the current password before it works
  showed in 7 of 10 (`cred_refused_until_ok_s` 5 in R26 1-2, R27 1, R29 2,
  R30 1-3).
- Harness defect found in R27 2: once the credential watch stopped, the
  pooler probe returned its last login result forever, so a restore that ended
  with the pooler down held the sampler's watchdog to its 93-minute cap (R27
  ran to 10:00 UTC; its pooler column after about 70 s is that frozen value).
  `lib/rp.ts` now logs in again on each probe after the watch stops, and RP08
  caps the restore wait at 30 min. There is no unit test for the fix (the
  probe opens a real pooler connection); the check is R29 3, which ended with
  the watch `down` (`pooler_window_s` 330) and still finished, its project
  living 0.50 h against R27's 2.13 h.
- **Host sleep audit (2026-10-26, #234).** The sleep log
  (`../platform-downtime/out/2026-10-26/host-sleep/overlap.txt`) has the
  orchestrator Mac asleep inside two of these artifacts. R29: one sleep,
  09:17:22 to 09:19:20 UTC (118 s), in cycle 3, whose target was 09:13:26;
  its `rest_http` probe first failed at 237 s for 117 s (the sleep) and
  healthy was read at 354 s, at the wake. R29 3's back-healthy time is
  bounded: between about 226 and 354 s (10 s polls). Its `rest_read`
  (258 s) and pooler (330 s) windows contain the sleep (upper bounds), the
  117 s `rest_http` window is void, and its watch ending `down` is not a
  clean observation. R29 1 and 2
  (targets 08:57:25 and 09:05:27, healthy by about 09:10:40) and every
  figure above from them are unaffected. R27: three sleeps from 09:17:22,
  all inside the frozen-pooler wait after cycle 2's outage had ended
  (08:32:58 by its `rest_read` window): unaffected. R26 and R30 spanned no
  sleep.

Not measured: a backlog that grows without bound (none of these loads built
one on Small); a heavier write than 8 WAL writers or a larger compute;
R15's exact shape (10 GB on top of a restored 3 GB database, one writer);
which base backup R15 used; the Dashboard's restore button. R15 stays
unexplained.

## 2026-10-23 - RP09 (logical slots across resize, read replica and restart; restore-point and undo)

Question: does a logical replication slot survive the platform operations the
docs say nothing about, and does its position hold. The docs require slots to
be dropped before a restore ("If your project uses subscriptions or
replication slots, you need to drop them before the restoration",
https://supabase.com/docs/guides/platform/backups) and before a major
upgrade ("Logical replication slots must be dropped",
https://supabase.com/docs/guides/platform/upgrading); they do not mention a
restart, a compute resize or creating a read replica. The compute guide
(https://supabase.com/docs/guides/platform/compute-and-disk, "Postgres
replication slots, WAL senders, and connections") lists 5 replication slots
and 5 WAL senders for Micro, Small and Medium and warns that a downgrade with
more slots than the new size allows stops the server starting. Docs read
2026-10-23 through the docs mirror.

Hypothesis: the slot survives each operation that keeps the disk, and a
clean shutdown persists its position. Competing: an operation that replaces
the instance or stops Postgres uncleanly loses the slot or rewinds
`confirmed_flush_lsn`, and a consumer sees duplicates (or, through the SQL
interface, gaps).

Shape (`tests/rp09-slots-platform-ops.ts`, `lib/slots.ts`): one Pro project
per run, created on Small (the read-replica minimum,
https://supabase.com/docs/guides/platform/read-replicas/getting-started),
ap-southeast-1, Postgres 17.11. One table, one row per transaction from a
writer through the session pooler every ~200 ms, and three slots on it:

- `pgo_sql`: `pgoutput`, read with `pg_logical_slot_get_binary_changes`
  (proto_version 1) through the session pooler every ~1 s;
- `w2j_sql`: `wal2json`, `pg_logical_slot_get_changes` (format-version 2),
  same cadence;
- `w2j_stream`: `wal2json` streamed by `pg_recvlogical --start --no-loop`
  over the direct host (`db.<ref>`, IPv6), respawned by the module after
  each disconnect, so the slot reads `active` while it runs.

An observer read `pg_replication_slots`, `pg_current_wal_lsn()` and
`pg_postmaster_start_time()` every ~2 s through the pooler. After a consumer
lost its connection it waited for an observer read taken after the server
answered again before consuming, so "first read after" is the slot's
position before any consumer moved it. Sequence per run, with a 60 s
baseline first and 90 s of settling after each step: resize Small to
Medium, Medium to Small, read replica create in the same region (wait until
it serves a query), replica remove, restart, then the restore-point and undo
routes. A duplicate counts as rewind-class when the redelivered
transaction ended at or before the position the consumer had already
confirmed; a gap is a writer-acknowledged id never received, counted after
the writer stopped and the consumers drained.

Vantage: the same macOS workstation, which had an IPv6 route on 2026-10-23
(the direct host answered); earlier sections of this log describe the
vantage as IPv4-only.

| run | start (UTC) | what | artifact |
|---|---|---|---|
| S1 | 2026-10-23 07:58 | full sequence; module under its working id RP08 (slots `rp08_*`) | `out/2026-10-23/run-2026-10-23T07-58-01-360Z.json` |
| S2 | 2026-10-23 08:17 | as S1, after two fixes (below); still RP08 | `out/2026-10-23/run-2026-10-23T08-17-52-950Z.json` |
| S3 | 2026-10-23 08:37 | as S2, renamed RP09 (another restore-paths module took RP08 the same day) | `out/2026-10-23/run-2026-10-23T08-37-26-434Z.json` |

Run ids S1 to S3 are a separate series from R1 to R25 above. RP08 is the
PITR archiver-lag module (`rp08-pitr-archiver-lag.ts`), whose artifacts may
also land in `out/2026-10-23/`, so read the RP08 rows in
`run-2026-10-23T07-58-01-360Z` and `run-2026-10-23T08-17-52-950Z` as RP09. All three
recorded lab commit `661afdf` and ran from the working tree. Fixes between
S1 and S2: the `wal2json` SQL consumer did not pass `include-lsn`, so its
confirmed position stayed `0/0` and S1's `w2j_sql_consumer_confirmed_at_loss`
and `w2j_sql_rewind_bytes` columns are void (its duplicate and gap counts are
not affected: they count ids); and the hold before a stream respawn timed out
at 120 s, shorter than S1's resize outages, so in S1 RP08b and RP08c the
stream had reconnected before the first observer read (its "first read
after", `0/70004D8` and `0/B0004F8`, is ahead of what it confirmed at the
loss, `0/4021088` and `0/8003E10`). Every project was deleted in `finally`
(`DELETE HTTP 200` in RP08i/RP09i of each artifact), and a `GET
/v1/projects` at 08:54 UTC listed none of the four projects this card
created (the three runs plus a Micro feasibility project; author's check, no
snapshot saved).

### Settings (RP08a / RP09a, identical in S1 to S3)

`wal_level` `logical`, `max_replication_slots` 10, `max_wal_senders` 10,
`max_slot_wal_keep_size` `2GB`, `wal_sender_timeout` `1min`,
`sync_replication_slots` `off`, `hot_standby_feedback` `off`, and the
`postgres` role has `rolreplication` true: the slots were created as
`postgres` through the Management API SQL endpoint and read through the
session pooler. `max_replication_slots`
read 10 before and after every step, on Small and on Medium (the compute
table says 5 for both). A Micro project the same morning (feasibility probe,
no artifact) read `max_replication_slots` 10 and `max_slot_wal_keep_size`
`512MB`. Creating a slot with the `wal2json` plugin succeeded without the
module creating any extension.

### Per operation (S1, S2, S3)

| step | status sequence | back to healthy (s), S1 / S2 / S3 | Postgres restarted | slots present after | duplicates, gaps |
|---|---|---|---|---|---|
| resize Small to Medium | `RESIZING>ACTIVE_HEALTHY` | 61 / 37 / 36 | yes (3 of 3) | 3 of 3 in each run | 0, 0 on all three consumers |
| resize Medium to Small | `RESIZING>ACTIVE_HEALTHY` | 67 / 101 / 36 | yes (3 of 3) | 3 of 3 | 0, 0 |
| read replica create | `ACTIVE_HEALTHY` throughout | served a query at 199 / 198 / 139 | no (0 of 3) | 3 of 3 | 0, 0 |
| read replica remove | `ACTIVE_HEALTHY` throughout | gone from the pooler config at 0 / 16 / 0 | no (0 of 3) | 3 of 3 | 0, 0 |
| restart | `ACTIVE_HEALTHY>RESTARTING>ACTIVE_HEALTHY` | 62 / 56 / 61 | yes (3 of 3) | 3 of 3 | 0, 0 |

"Postgres restarted" is `pg_postmaster_start_time()` differing between the
read before the step and the read at its end. Totals after the drain
(RP08g / RP09g): the writer acknowledged 3421, 3767 and 3143 rows, and each
of the three consumers received every one of them exactly once in each run
(`distinct` equal to `writer_acked_total`, `duplicates_total` 0,
`gaps_total` 0).

Slot position across the steps that restarted Postgres (resize up, resize
down, restart): the slot's `confirmed_flush_lsn` at the first read after the
outage equalled the position the consumer had confirmed when it lost the
connection in every case where both were recorded: `pgo_sql` 9 of 9 (3 steps
x 3 runs), `w2j_sql` 6 of 6 (S2, S3), `w2j_stream` 7 of 9 (S1's two resizes
are the stream case above). Examples, consumer at loss = slot after:
S2 resize up `0/40162D0` (both SQL slots) and `0/40164F8` (stream); S3
restart `0/F0181E8` and `0/F018358`. Nothing rewound, so nothing was
redelivered. `restart_lsn` moved forward in each step; WAL retained by the
slots at each step's end read was 896 to 16,711,576 bytes (S2 resize up, S1
resize up) and `wal_status` read `reserved` throughout.

The streaming slot was `active` again at the end of every step, because the
module respawned `pg_recvlogical`; a consumer that does not reconnect leaves
the slot inactive and retaining WAL. `pg_recvlogical` exited with `error:
disconnected` exactly three times per run, at the two resizes and the
restart (four spawns in each artifact; exit times in the RP08g/RP09g
evidence, and the stream's stall columns are non-zero only for those three
steps); the replica create and remove did not drop the walsender
connection.

Read replica: the replica answered `pg_is_in_recovery()` true,
`max_replication_slots` 10, `hot_standby_feedback` `off`, and listed no
replication slots (`slots=(none)`) in all three runs; the logical slots
stay on the primary (`sync_replication_slots` is `off`). The primary listed
the same 3 slots before and after the replica was created and while it
served, so no physical slot for the replica appeared in
`pg_replication_slots` (reading: the replica does not hold a slot on the
primary; not separated from one being hidden from the `postgres` role).

Writer and consumer pauses per step (`writer_max_stall_s`,
`*_max_stall_s`) ran 49 to 155 s against 36 to 101 s to healthy. They are not
outage figures: every client reconnected through the session pooler about
once a second, and the pooler answered `(ECIRCUITBREAKER) too many
authentication failures, new connections are temporarily blocked` in all
three runs (writer errors in the RP08g/RP09g evidence), the hazard RP02
describes. The consumers' hold for the observer read adds to them as well.
LO05 and compute-disk D09 measure restart and resize outages.

### Restore point and undo on Pro (RP08h / RP09h)

On each of the three Small Pro projects, with the three slots present:
`GET database/backups/restore-point`, `POST database/backups/restore-point
{"name": "rp08-mark"}` (`rp09-mark` in S3), `GET ...restore-point?name=` and
`POST database/backups/undo {"name": ...}` all answered `400` `{"message":"This
endpoint is unavailable at the moment"}`. Undo was sent with a name the POST
had not created, since the POST was refused. Same answer as RP01 on
2026-10-10 and RP04 (Team) on 2026-10-20. Not run on an Enterprise org: none
was available to the lab, so whether the routes work there is open.

Not measured: an unclean stop (a crash, an OOM kill), where the slot's
on-disk position can lag what the consumer was told; PITR restore and major
upgrade (documented as requiring the slots dropped); resizes other than
Small and Medium; a downgrade with more slots than the target size's limit
(the limit read 10 here, so the docs' 5 was not reachable with 3 slots); a
consumer that stays down long enough for `max_slot_wal_keep_size` to
invalidate the slot; replica lag; the replica in another region.
