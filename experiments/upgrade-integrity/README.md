# upgrade-integrity

What an in-place Postgres major upgrade on a hosted project does to data that
pg_cron and pgmq are writing while it runs: do amcheck's heap and B-tree
checks pass afterwards, do sequences sit at or above their columns' max, does
`VACUUM (FREEZE, VERBOSE)` on the pg_cron and pgmq tables work and advance
`relfrozenxid`, and what happens to cron runs and queue traffic across the
window. The output is a post-upgrade checklist with the evidence for each
line; a clean result is a valid finding.

Self-provisioning, no OpenTofu state. UI01 creates one Pro-org project on
Postgres 15 (`postgres_engine: "15"` on `POST /v1/projects`, Micro,
ap-southeast-1); UI02-UI06 work on it in id order; UI99 deletes it. The
upgrade is `POST /v1/projects/{ref}/upgrade` with the first target from
`GET /v1/projects/{ref}/upgrade/eligibility`. Catalog queries go through the
Management API query endpoint; VACUUM goes through the session pooler, since
VERBOSE output arrives as INFO notices that the query endpoint does not return.
Run from source with bun; `harness/dist/pvlab` is built for linux-x64.

## Modules

| id | claim |
|---|---|
| UI01 | A fresh project can be created on Postgres 15 through the Management API, and it is eligible for an in-place upgrade to 17 |
| UI02 | Fixture: pg_cron job `ui-tick` every 5 s (insert, update, delete, 3 pgmq sends, read, archive or delete), job `ui-minute` every minute, warm-up; baseline amcheck (verify_heapam, bt_index_check, bt_index_parent_check), sequences against max(column), relfrozenxid ages |
| UI03 | Eligibility with the extensions enabled; the upgrade with status polled every 5 s (15 s in runs 1-2); client writers every 1 s (3 s in runs 1-2) through the Management API query endpoint (runs 1-4), the session pooler (runs 2-4), the transaction pooler and the direct connection (runs 3-4) and the Data API (run 4), each write returning server version, postmaster start, system_identifier, server address (published as a label), WAL LSN, txid and recovery state; the same identity before the POST and after |
| UI04 | After: amcheck, sequences, every acknowledged write (per path) and every baseline row present, lost and kept writes grouped by server identity, pg_cron rows in each restarted old-version postmaster's window, cron and pgmq catalog before and after |
| UI05 | After: `VACUUM (FREEZE, VERBOSE)` on `cron.job_run_details`, the pgmq queue and archive tables and the two busy public tables; relfrozenxid and age before and after |
| UI06 | After a settle: the last cron run on 15, the first on 17, the runs the gap skipped, job_run_details by status, pgmq send / read / archive on 17, every acknowledged write re-read through a fresh pooler connection |
| UI99 | Delete the project and wait until `GET /v1/projects` stops listing it |

## Run

```bash
# PVLAB_ORG_PRO is an org slug; SUPABASE_ACCESS_TOKEN is a PAT.
make run                         # UI01-UI06, UI99
make run PVLAB_UI_KEEP=1         # leave the project running (UI99 skips)
make clean                       # list leftovers named pvlab-ui-*; DELETE=1 removes them
make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
```

Knobs: `PVLAB_UI_WARMUP_S` (default 180), `PVLAB_UI_SETTLE_S` (default 180),
`PVLAB_UI_SIZE` (default micro), `PVLAB_UI_ENGINE` (default 15),
`PVLAB_UI_UPGRADE_TIMEOUT_MIN` (default 120).

## Result (2026-10-23 runs 1-3 and 2026-10-26 run 4, Micro, 15.19 to 17.11)

| check | before | after |
|---|---|---|
| `verify_heapam`, every table in public, cron, pgmq (all four runs) | 9/9 clean | 9/9 clean |
| `bt_index_check` / `bt_index_parent_check` (heapallindexed) | 16/16, 16/16 | 16/16, 16/16 |
| sequences at or above max(column) | 8/8 | 8/8 |
| `VACUUM (FREEZE, VERBOSE)` as `postgres` on job_run_details, queue, archive | n/a | run 1: 3/3 cron and pgmq tables, runs 2-4: 5/5 including the two public ones; relfrozenxid advanced, age to 0 or 1 |
| cron jobs, jobids, run history | 2 jobs, 39 runs | identical, 39/39 kept, jobs resumed on 17 |
| writes acknowledged during the window | n/a | lost in all four runs: run 1 15 of 106; run 2 the 22 a restarted 15.19 postmaster acknowledged; run 3 the 88 (44 session pooler, 44 transaction pooler) acknowledged by the third restart of the original 15.19 cluster (same system_identifier), none from any other postmaster; run 4 the 88 (44 + 44) acknowledged by the second restart seen, Data API 36/36 and Management API 48/48 kept (both refused writes for most of the window) |

The integrity checks were clean; the data-loss row is the finding. Numbers,
offsets and the per-write evidence are in RUNLOG.md; published artifacts
under `out/2026-10-23/` and `out/2026-10-26/`.
