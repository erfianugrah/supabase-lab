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
(R18, R19, R22, R23; tables below), while `rest` in the same runs shows no
failure in 8 of those 9 restores and 6 s in one (R18, 3 GB).

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
| R18 | 3210 MB | 129, 24.8 | 121 | 121 | 221 | 211 | 322 | 12 | 11,000,000 / 11,000,000 |
| R18 | 10482 MB | 290, 25.1 | 31 | 26 | 555 | 417 | 400 | 15 | 36,000,000 / 36,000,000 |
| R19 control | 3210 MB | 128, 25 | 131 | 128 | 322 | 202 | 315 | 18 | 11,000,000 / 11,000,000 |
| R19 control | 10482 MB | 291, 25 | 61 | 51 | 545 | 415 | 402 | 12 | 36,000,000 / 36,000,000 |
| R22 | 10482 MB | 1114, 9.4 | 152 | 123 | 697 | 544 | 531 | 12 | 36,000,000 / 36,000,000 |
| R23 | 3210 MB | 116, 27.6 | 208 | 170 | 232 | 192 | 176 | 12 | 11,000,000 / 11,000,000 |
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

- Time to `ACTIVE_HEALTHY`: 221 to 322 s at 3111 to 3210 MB (n=4), 475 to
  787 s at 10441 to 10482 MB (n=5). Against RP02 (30 s at 10 MB, 81 s at
  574 MB) time grows with size at this compute; n is small and the spread at
  each size is wide.
- What replay cost, from `postgres_logs` (R22, R23): `redo done ...
  elapsed: 166.13 s` (R23, 3 GB), `278.96 s` (R23, 10 GB), `512.03 s` (R22,
  10 GB); the rest of the time to healthy is outside replay.
- The Data API read (`rest_read`, the 7 restores in R18, R19, R22, R23) was
  down for 192 to 544 s, and the pooler for 176 to 531 s across all 9; the
  `rest` probe (anon on `/rest/v1/`) showed no failure in 8 of 9 restores
  and 6 s in one. Auth (`/auth/v1/health`) failed for 144 s in R19's 3 GB
  restore and not at all in the others; Realtime for 144 s in R18's 3 GB
  restore and 6 s in R19's 3 GB restore.
- R18's 3 GB restore ended with the current password refused by the pooler
  (`cred_final_current` `refused`; pooler down 322 s against 221 s to
  healthy); every other RP07 restore ended `ok`. Not followed up.
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
suggests); the Dashboard's restore button, which may pick its target
differently.

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
