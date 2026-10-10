# restore-paths RUNLOG

Throwaway projects in ap-southeast-1, all on 2026-10-10 (UTC), driven from an
IPv4-only workstation over the Management API and the shared pooler. Every
project was named `rp-*` and deleted at the end of its module (or by
hand when a run was killed); a final `GET /v1/projects` listed none (author's
observation at the end of the session; no snapshot was saved). Raw
artifacts carry project refs and stay off-repo (`evidence/`).

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
module; artifact `rp01/run-2026-10-10T01-22-13-170Z.json` in the off-repo
evidence copy, `fresh_physical_backups=0`) found the listing empty at the same
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
| REST, Auth, Realtime paths (1 s probes) | no failed sample during any of the 9 restores; one simultaneous timeout on all three 338 s after R5's first request, no recovery recorded, not explained |
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

- Restore to a new project (clone): Dashboard only, refused a PAT; password and
  Storage behaviour after a clone are unread. The docs list what is not copied
  (Storage objects and settings among them); not tested.
- The Dashboard's physical-backup restore, and `backups/restore` on any
  project where it answers.
- A restore target hours or days old; a database over 1 GB; a Free project
  parked longer than minutes; auto-pause.
- Direct 5432 (IPv6 only; no IPv6 route from the vantage).
- Why the PITR window at enable time ends before the create call.
- Restore time at production data sizes.
