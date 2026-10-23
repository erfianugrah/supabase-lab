# restore-paths

Which restore paths a Pro org can use through the Management API, what each
costs per connection path, and which database password and whether Storage
survive them. Questions behind it: the changelog entry "Fixed stale database
credentials left behind after a restore" (2026-07-30,
https://supabase.com/changelog/restore-credential-resync) says current
credentials are reapplied after every physical restore, including an unpause
and a clone; and whether Storage returns 5xx after a restore.

Self-provisioning, no OpenTofu state: each module creates a throwaway project
named `rp-*` on the org it needs and deletes it in `finally`
(PITR add-on removed first). Run from source with bun; `harness/dist/pvlab`
is built for linux-x64.

## Modules

| id | claim |
|---|---|
| RP01 | Pro surface: pause and unpause refused; `backups/restore` and `restore-point` answer "unavailable"; `restore-pitr` without PITR refused; no clone path in the OpenAPI document; the dashboard clone route rejects a PAT |
| RP02 | PITR restore on a Small Pro project: time until a target is accepted, per-path outage, which password the pooler accepts afterwards, Storage, plus a control restore to an instant after a second password rotation. `RP02_SEED_MB` grows the database first |
| RP03 | Free-plan pause and unpause (two cycles): timing, password change while paused, password after unpause, Storage |
| RP04 | Daily (physical) backup restore without PITR on a Team-org Micro project (`RP04_ORG_ROLE=pro` for Pro): retention entitlement, first backup listed, whether `backups/restore` runs; if it does, per-path outage, password and Storage as in RP02 |
| RP05 | What `DELETE database/migrations?gte=` and the stored `rollback` SQL do to schema, data and history, on the production project and on a git-less preview branch; plus a failing apply |
| RP06 | PITR recovery point on Small: lag of the platform's latest recoverable instant under a light writer and idle (`RP06_PHASE_MIN`, default 20; 0 skips to the restore), then a restore to that instant with the writer running and a count of acknowledged rows kept and lost |
| RP07 | PITR restore time against database size past 1 GB (`RP07_SIZES_GB`, default 3,10; `RP07_COMPUTE`, default small; disk grown once to `RP07_DISK_GB`, default 40): fill, archive catch-up, restore to the latest instant, per-path outage including a Data API read, rows kept, Postgres recovery log lines. `RP07_WAIT_ARCHIVER=1` also waits for `pg_stat_archiver` to pass the fill-end segment |
| RP09 | Logical slots (`pgoutput` and `wal2json` via the SQL interface over the session pooler, `wal2json` streamed by `pg_recvlogical` over direct IPv6) across compute resize Small to Medium and back, read-replica create and remove, and restart: slot present, `active`, `confirmed_flush_lsn` before vs after, retained WAL, duplicates and gaps against a steady writer; then `restore-point` and `undo` |

## Run

```bash
# PVLAB_ORG_PRO / PVLAB_ORG_TEAM / PVLAB_ORG_FREE are org slugs; SUPABASE_ACCESS_TOKEN is a PAT.
make surface   # RP01, minutes
make pitr      # RP02, ~10 minutes; RP02_SEED_MB=500 make pitr for a bigger database
make pause     # RP03, ~15 minutes, Free org (2 active projects allowed)
make daily     # RP04, ~4 minutes while backups/restore refuses, up to ~30 if a restore runs; PVLAB_ORG_TEAM
make rollback  # RP05, ~1-2 minutes including the preview branch; PVLAB_ORG_PRO
make rpo       # RP06, ~50 minutes (RP06_PHASE_MIN=0: ~10 minutes, restore only); PVLAB_ORG_PRO
make size      # RP07, 36.6 to 46.5 minutes per run on Small (2026-10-22/23); PVLAB_ORG_PRO
make slots     # RP09, about 18 minutes on Small (2026-10-23); needs pg_recvlogical and an IPv6 route; PVLAB_ORG_PRO
```

Output lands in `evidence/<timestamp>/` (gitignored: reports carry project
refs and hostnames).

## Measured

See RUNLOG.md (2026-10-10, 2026-10-20, 2026-10-22/23, and RP09 on 2026-10-23). Short form, from one vantage (an IPv4-only
workstation; it had an IPv6 route for RP09), ap-southeast-1 projects:

| finding | value | module |
|---|---|---|
| Pro: pause | `400`, "Project is not free-tier" | RP01 |
| Pro: in-place physical-backup restore (`backups/restore`) | `400`, "This endpoint is unavailable at the moment" (also `restore-point`) | RP01 |
| Pro: `restore-pitr` without the add-on | `400`, "PITR is not enabled for this project." | RP01 |
| Pro: restore to a new project (clone) | no path in the OpenAPI document; the Dashboard's route answers a PAT `401 Unsupported access token`; not run | RP01 |
| PITR restore, Small, 10 MB database | status back to healthy in 30 s (30 to 41 s for the controls); Storage path fails for 12 s; pooler 5 to 13 s; REST (anon `GET /rest/v1/`, which never reads the database; see the 2026-10-23 correction in RUNLOG.md), Auth, Realtime no failed 1 s sample | RP02 |
| PITR range upper bound | equals `pg_stat_archiver.last_archived_time`; lag 1 to 107 s under one INSERT per ~200 ms (120 s `archive_timeout` sawtooth), up to 752 s idle over 20 min | RP06 |
| Restore to the quoted latest instant under a writer | restores to an LSN; 2 to 4 acked rows written before the target missing in each of 4 runs (R20, R21, R24, R25), 0.02 to 0.79 s before it where ages were recorded (R24, R25); nothing after the target kept; back to healthy in 30 to 41 s with a Data API read `503 PGRST002` for 15 and 14 s (R24, R25) | RP06 |
| PITR restore, Small, 3111 to 3210 MB / 10441 to 10482 MB | healthy in 221 to 322 s (n=4) / 475 to 787 s (n=5); Data API read `503 PGRST002` for 192 to 544 s in the 7 restores that carried the probe (R15 had none); one 10 GB restore of five kept 31,000,000 of 37,000,000 rows with no error | RP07 |
| PITR target just past "now" | refused with the allowed range until the platform's upper bound moves; accepted on a 60 s or 121 s retry | RP02 |
| Password after a PITR restore | the current password works, the replaced one is refused; the verifier is set again (a value matching neither earlier one); the current password was refused for about one 5 s poll in 6 of 7 restores observed with the new poller | RP02 |
| Storage after a restore | list, download (bytes equal) and upload `200`; no `500`; an object written after the target reads `404` after a restore to before it | RP02, RP03 |
| Free-plan pause then unpause | `INACTIVE` after 62 or 63 s (5 of 6 cycles; 276 s once); unpause to healthy 183 to 212 s (5 of 6; 444 s once) | RP03 |
| Password change while paused | refused, `400` "Cannot reset password for non-active projects" | RP03 |
| Password after unpause | the one set before the pause works; the verifier is set again | RP03 |
| Team: in-place physical-backup restore (`backups/restore`), no PITR | `400` "This endpoint is unavailable at the moment" on 4 attempts over 180 s, and on one `GET restore-point`, 2026-10-20; no downtime figure exists | RP04 |
| Backup retention as an entitlement | `backup.retention_days` 14 on the Team org (RP04); 7 on the Pro org (manual call, no artifact), 2026-10-20 | RP04 |
| Migration rollback route on a production project | `400` "You cannot rollback a production branch."; schema and history unchanged; the stored `rollback` SQL is returned by `GET migrations/{version}` | RP05 |
| Migration rollback route on a git-less preview branch | `200`; history rows from the cut onward removed; the one stored `rollback` ran (column dropped); a migration with none stored kept its table (n=1) | RP05 |
| Failing migration apply | `400` with the Postgres error; the first statement's table absent and no history row | RP05 |
| Logical slots across resize Small to Medium and back, read-replica create/remove, restart | all 3 slots present after every step in 3 of 3 runs (2026-10-23, S1 to S3); `confirmed_flush_lsn` after each Postgres restart equal to what the consumer had confirmed; every acked row (3421, 3767, 3143) delivered once to each consumer, 0 duplicates, 0 gaps; the replica listed no slots | RP09 |
| Slot limits on Small and Medium | `max_replication_slots` and `max_wal_senders` 10 (the compute guide says 5); `max_slot_wal_keep_size` `2GB` on Small | RP09 |
| Pro: `restore-point` and `undo` | `400` "This endpoint is unavailable at the moment" for GET, POST and undo, 3 of 3 projects, 2026-10-23; Enterprise not run | RP09 |

Not measured: restore-to-new-project, the Dashboard's physical-backup restore (so no daily-backup restore downtime),
direct 5432 during restores, restore time at production data sizes, and any
restore on a project older than a few minutes.
