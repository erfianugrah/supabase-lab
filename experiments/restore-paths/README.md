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

## Run

```bash
# PVLAB_ORG_PRO / PVLAB_ORG_FREE are org slugs; SUPABASE_ACCESS_TOKEN is a PAT.
make surface   # RP01, minutes
make pitr      # RP02, ~10 minutes; RP02_SEED_MB=500 make pitr for a bigger database
make pause     # RP03, ~15 minutes, Free org (2 active projects allowed)
```

Output lands in `evidence/<timestamp>/` (gitignored: reports carry project
refs and hostnames).

## Measured

See RUNLOG.md (2026-10-10). Short form, from one vantage (an IPv4-only
workstation), ap-southeast-1 projects:

| finding | value | module |
|---|---|---|
| Pro: pause | `400`, "Project is not free-tier" | RP01 |
| Pro: in-place physical-backup restore (`backups/restore`) | `400`, "This endpoint is unavailable at the moment" (also `restore-point`) | RP01 |
| Pro: `restore-pitr` without the add-on | `400`, "PITR is not enabled for this project." | RP01 |
| Pro: restore to a new project (clone) | no path in the OpenAPI document; the Dashboard's route answers a PAT `401 Unsupported access token`; not run | RP01 |
| PITR restore, Small, 10 MB database | status back to healthy in 30 s (30 to 41 s for the controls); Storage path fails for 12 s; pooler 5 to 13 s; REST, Auth, Realtime no failed 1 s sample | RP02 |
| PITR target just past "now" | refused with the allowed range until the platform's upper bound moves; accepted on a 60 s or 121 s retry | RP02 |
| Password after a PITR restore | the current password works, the replaced one is refused; the verifier is set again (a value matching neither earlier one); the current password was refused for about one 5 s poll in 6 of 7 restores observed with the new poller | RP02 |
| Storage after a restore | list, download (bytes equal) and upload `200`; no `500`; an object written after the target reads `404` after a restore to before it | RP02, RP03 |
| Free-plan pause then unpause | `INACTIVE` after 62 or 63 s (5 of 6 cycles; 276 s once); unpause to healthy 183 to 212 s (5 of 6; 444 s once) | RP03 |
| Password change while paused | refused, `400` "Cannot reset password for non-active projects" | RP03 |
| Password after unpause | the one set before the pause works; the verifier is set again | RP03 |

Not measured: restore-to-new-project, the Dashboard's physical-backup restore,
direct 5432 (IPv6-only), restore time at production data sizes, and any
restore on a project older than a few minutes.
