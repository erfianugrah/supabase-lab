# RUNLOG - upgrade-integrity

Chronological record of what was run. Org and project identifiers are not
recorded; the org class is (Pro). Each run provisions one throwaway project
through `POST /v1/projects` with `postgres_engine: "15"`,
`desired_instance_size: micro`, region ap-southeast-1, upgrades it in place
with `POST /v1/projects/{ref}/upgrade` and deletes it in UI99. Vantage: this
lab's Mac in Singapore over the public internet. Offsets written `+N s` are
seconds after the upgrade POST returned, taken from the client clock at the
START of each write attempt (an attempt can be acknowledged several seconds
later, for instance a pooler insert that waited for its connection).
Database timestamps are UTC and quoted as the artifact holds them.

## 2026-10-23 - probe: can a fresh project start on Postgres 15?

Before the experiment existed, a scratch probe (not committed) sent `POST
/v1/projects` with `postgres_engine: "15"` and `desired_instance_size:
micro`. The OpenAPI document read the same day (`/api/v1-json`) types both
`postgres_engine` and `release_channel` on that body as deprecated and
`null`, and platform-facts F06 had recorded that the upgrade window is not
measurable on a throwaway project, from that typing plus a fresh project
sitting at the latest version. The probe's create answered 201; `GET
/projects/{ref}` read `database.version` `15.19.0.003`, `postgres_engine`
`15`, `release_channel` `ga`; `select version()` answered `PostgreSQL 15.19
on aarch64-unknown-linux-gnu`; `GET /upgrade/eligibility` answered
`eligible: true` with one target (`postgres_version` 17, `app_version`
`supabase-postgres-17.11.0.003`), `duration_estimate_hours: 1`, empty
validation errors and warnings. The probe project was deleted (DELETE 200).
The upgrade body comes from the spec: `UpgradeDatabaseBody` `{
target_version (required), release_channel }`, status from `GET
/upgrade/status` (`databaseUpgradeStatus.progress`, `0_requested` ...
`10_completed_post_physical_backup`). The spec marks the upgrade endpoint
experimental and Beta.

## 2026-10-23 - dev run (UI01, UI02, UI99; not published)

`make run ONLY=UI01,UI02,UI99 PVLAB_UI_WARMUP_S=60`. Shook out the fixture:
amcheck 1.3 is creatable by `postgres` and lands in `pg_catalog`, and
`postgres` (not a superuser) can run `verify_heapam`, `bt_index_check` and
`bt_index_parent_check` on its own tables and on pg_cron's
`supabase_admin`-owned ones; pg_cron 1.6.4 accepted `'5 seconds'`; one
catalog query needed a `relkind::text` cast. Project deleted.

## 2026-10-23 - run 1 (Management API writer only)

Harness: `make run`, lab commit 661afdf plus this experiment uncommitted.
Published: `out/2026-10-23/run-2026-10-23T07-58-02-745Z.json` and its
`.facts.md`, 23 results. UI05's two public-table rows failed on a harness bug
(the age query returned `ui_events` without its schema, so the lookup by
`public.ui_events` found nothing); the three cron and pgmq rows are valid.

- UI01: create 201, `database.version` 15.19.0.003, `server_version` 15.19;
  eligibility `eligible true`, target `17:supabase-postgres-17.11.0.003`,
  estimate 1 h.
- UI02 (180 s warm-up): pg_cron 1.6.4, pgmq 1.5.1, amcheck 1.3; 36 ticks,
  median gap 5.01 s; job_run_details 39, all `succeeded`. amcheck before:
  heap 9/9, `bt_index_check` 16/16, `bt_index_parent_check` 16/16 clean.
  Sequences 8/8 at or above their column max.
- UI03: eligibility with the extensions enabled unchanged (unsupported
  extensions `[]`, objects to be dropped 0, warnings 0). POST 201; progress
  `1_started` at +31 s, `2_launched_upgraded_instance` +122 s,
  `4_attached_volume_to_original_instance` +137 s,
  `5_initiated_data_upgrade` +152 s, `6_completed_data_upgrade` +243 s,
  `8_attached_volume_to_upgraded_instance` +259 s, `9_completed_upgrade`
  +274 s (15 s polling, so each is "first seen at"); first acknowledged
  write on 17.11 at +272 s; ACTIVE_HEALTHY on 17.11 at +289 s. `version()`
  after: `PostgreSQL 17.11 on x86_64-pc-linux-gnu`. The run did not record
  the 15.19 architecture (the probe above, a different project, read
  aarch64), so whether the upgrade changed architecture was not measured.
- UI03c Management API writer: 110 attempts, 106 acknowledged, 4 failed (1x
  `57P03: the database system is shutting down`, 3x `ECONNREFUSED` to the
  database host); first failure +209 s; largest gap between acknowledged
  writes 12 s (seq 76 at +215 s to seq 80).
- UI04: amcheck after (1.4): heap 9/9, `bt_index_check` 16/16,
  `bt_index_parent_check` 16/16 clean. Sequences 8/8. Acknowledged writes
  present 91/106; lost seqs 80 to 94, every write acknowledged after the
  failure burst and before the first write on 17.11. Baseline rows kept:
  ticks 36/36, archive 54/54, job_run_details 39/39. cron.job identical
  (jobid 1 `ui-tick` `5 seconds`, jobid 2 `ui-minute`, both active), cron and
  pgmq relation lists identical.
- UI05: `cron.job_run_details` age 1133 -> 1, relfrozenxid 1196 -> 2335;
  `pgmq.q_ui_q` 8 -> 1; `pgmq.a_ui_q` 1132 -> 0; all as `postgres` through
  the session pooler, no warning.
- UI06: last tick on 15 at +208.6 s (`2026-10-23 08:04:55.950982+00`), first
  on 17 `2026-10-23 08:05:48.325306+00`, gap 52.4 s (about 9 runs of the
  5-second job never started); `ui-minute` gap 120.0 s (one minute skipped);
  job_run_details since POST-60 s: `ui-tick` `succeeded` 94, `ui-minute` 8, no
  other status; 40/40 ticks on 17 sent and read; direct send, read and
  archive worked.
- UI99: DELETE 200, gone from `GET /projects` at the first check.

The 15 missing acknowledged writes were the reason for run 2: run 1 did not
record which server answered each write.

## 2026-10-23 - run 2 (Management API and session pooler writers)

UI03 changed to record `server_version` and `pg_postmaster_start_time()` in
every acknowledged write and to run a second writer through the session
pooler (one connection, reconnect after any error, 15 s client timeout);
UI04c checks both; UI05's lookup fixed. Published:
`out/2026-10-23/run-2026-10-23T08-11-11-740Z.json` and `.facts.md`, 24
results. The POST returned at `2026-10-23T08:14:34.804Z`.

- UI01, UI02: as run 1 (36 ticks, median 5.01 s, 39 runs `succeeded`;
  amcheck heap 9/9, btree 16/16 and 16/16; sequences 8/8).
- UI03b: POST 201; `1_started` +31 s, `2_launched_upgraded_instance` +137 s,
  `4_attached_volume_to_original_instance` +152 s, `5_initiated_data_upgrade`
  +167 s, `6_completed_data_upgrade` +259 s,
  `8_attached_volume_to_upgraded_instance` +274 s, `9_completed_upgrade`
  +289 s; first Management API write on 17.11 at +299 s; ACTIVE_HEALTHY on
  17.11 at +304 s.
- UI03c (Management API, 115 attempts, 94 acknowledged, 21 failed) and UI03d
  (session pooler, 111 attempts, 108 acknowledged, 3 failed). Outcome runs
  from the artifact (failure texts condensed; the artifact has one line per
  run):

  ```
  mgmt   seq 1-78    (+-10..221 s) ok 15.19 postmaster 2026-10-22 20:42:42.557855+00
  mgmt   seq 79-83   (+224..236 s) FAIL: ECONNREFUSED; 57P01 terminating connection due to
                                   administrator command; Database is possibly not accessible
  mgmt   seq 84-85   (+239..242 s) ok 15.19 postmaster 2026-10-23 08:18:32.950481+00
  mgmt   seq 86-96   (+245..275 s) FAIL: Database is possibly not accessible at the moment
  mgmt   seq 97      (+278 s)      ok 15.19 postmaster 2026-10-23 08:18:32.950481+00
  mgmt   seq 98      (+281 s)      FAIL: Database is possibly not accessible at the moment
  mgmt   seq 99      (+284 s)      ok 15.19 postmaster 2026-10-23 08:18:32.950481+00
  mgmt   seq 100-103 (+287..296 s) FAIL: Database is possibly not accessible at the moment
  mgmt   seq 104-112 (+299..323 s) ok 17.11 postmaster 2026-10-23 08:19:25.013963+00
  mgmt   seq 113-115 (+326..332 s) ok 17.11 postmaster 2026-10-23 08:19:59.093268+00
  pooler seq 1-78    (+-10..221 s) ok 15.19 postmaster 2026-10-22 20:42:42.557855+00
  pooler seq 79      (+224 s)      FAIL: Client has encountered a connection error
  pooler seq 80-97   (+227..289 s) ok 15.19 postmaster 2026-10-23 08:18:32.950481+00
  pooler seq 98      (+292 s)      FAIL: Client has encountered a connection error
  pooler seq 99-108  (+295..323 s) ok 17.11 postmaster 2026-10-23 08:19:25.013963+00
  pooler seq 109     (+326 s)      FAIL: Client has encountered a connection error
  pooler seq 110-111 (+329..332 s) ok 17.11 postmaster 2026-10-23 08:19:59.093268+00
  ```

  The restarted 15.19 postmaster (the first restart seen) started about
  238 s after the POST returned (derived from the two timestamps above),
  between `5_initiated_data_upgrade` (+167 s) and `6_completed_data_upgrade`
  (+259 s) as polled.
- UI04c: acknowledged writes present: Management API 90/94, session pooler
  90/108. The 22 lost writes are exactly the 22 acknowledged by the 15.19
  postmaster that started at `2026-10-23 08:18:32.950481+00` (Management API
  seqs 84, 85, 97, 99; pooler seqs 80 to 97), attempts started +227 s to
  +289 s. No write acknowledged by the original postmaster or by either 17.11
  postmaster is missing. Baseline rows kept: ticks 36/36, archive 54/54,
  job_run_details 39/39.
- UI04a/b: amcheck 1.4 heap 9/9, `bt_index_check` 16/16,
  `bt_index_parent_check` 16/16 clean; sequences 8/8 (cron `jobid_seq` and
  `runid_seq`, the pgmq queue sequence, also checked against the archive's
  max msg_id, and the public ones).
- UI04d: cron.job identical before and after; cron relations (`job`,
  `job_run_details`, their indexes, `jobid_seq`, `runid_seq`) and pgmq
  tables (`a_ui_q`, `meta`, `q_ui_q`) identical by name.
- UI05, all through the session pooler as `postgres`, no warning, each 8 to
  14 ms: `cron.job_run_details` (owner `supabase_admin`) age 1239 -> 1,
  relfrozenxid 1197 -> 2436, VERBOSE `aggressively vacuuming`, `new
  relfrozenxid: 2436, which is 1239 XIDs ahead of previous value`, 102 tuples
  frozen; `pgmq.q_ui_q` 62 -> 1 (36 dead tuples removed); `pgmq.a_ui_q`
  1238 -> 0; `public.ui_events` 1230 -> 0; `public.ui_ticks` 1239 -> 0.
  mxid_age 0 before and after on all five.
- UI06: last tick on 15 `2026-10-23 08:18:14.320389+00` (+219.5 s), first on
  17 `2026-10-23 08:19:13.557709+00`, gap 59.2 s, about 11 runs never
  started; `ui-minute` last on 15 `2026-10-23 08:18:00.016714+00`, first on
  17 `2026-10-23 08:20:00.236346+00` (gap 120.2 s, one run missing).
  job_run_details since POST-60 s: `ui-tick` `succeeded` 95, `ui-minute` 8, no
  failed or other status anywhere in the table. 40/40 ticks on 17 sent and
  read (archived 60, deleted 60); direct send / read / archive / metrics
  answered.
- UI99: DELETE 200, gone at the first listing.

Reading (inference, not measured): the original 15.19 postmaster stopped near
+221 s, a second 15.19 postmaster then served reads and writes for about 50 s
on a data directory that was not the one carried into 17.11, and the cutover
to 17.11 discarded everything it committed. Whether that postmaster ran on the
original instance or elsewhere, and why it was started, was not observed. The
first 17.11 tick predates the earliest 17.11 postmaster start seen by a
client write, and a further 17.11 start followed: the 17.11 side restarted at
least once after taking writes, and those writes survived.

`cron.job_run_details` kept relfrozenxid 1197 across the upgrade (UI02d 1197,
UI05 before 1197) together with all 39 baseline history rows and the same
jobids. That is what pg_upgrade's carrying of relfrozenxid produces; a table
re-created by DDL during the upgrade would take a fresh relfrozenxid
(inference: the run did not compare OIDs or filenodes).

Not run: compute above Micro, any other region, a larger database (the
fixture was a few MB), Postgres 17 to a newer major, direct connections
(IPv6) and the transaction pooler as write paths, the Data API as a write
path, whether pg_cron fired on the short-lived 15.19 postmaster (its writes
would have been discarded with the rest), a repeat beyond n = 2, the
dashboard upgrade button.

## 2026-10-23 - run 3 (four write paths, 1 s writes, 5 s status polling, server identity per write)

Purpose: name every lost write and the server that acknowledged it. Changes:
writers on every path reachable from this Mac, each every 1 s with its own
seq - Management API query endpoint (`mgmt`), session pooler 5432
(`pooler`), transaction pooler 6543 (`txn`), direct connection (`direct`).
Each write is one `insert ... returning` whose column defaults capture
`server_version`, `pg_postmaster_start_time()`, `system_identifier` (from
`pg_control_system()`), `inet_server_addr()` (published as a label,
`addr#1`, `addr#2`), `pg_current_wal_lsn()`, `txid_current()` and
`pg_is_in_recovery()`; attempt start and acknowledgement times are kept per
write. `GET /upgrade/status` every 5 s. UI03e reads the same identity once
before the POST and once after. UI04e groups acknowledged writes by server
identity; UI04f counts pg_cron rows in the restarted postmaster's window;
UI06e re-reads every acknowledged write after the settle through a fresh
session-pooler connection and the direct connection. Published:
`out/2026-10-23/run-2026-10-23T08-34-39-938Z.json` and `.facts.md`, 31
results. POST returned at `2026-10-23T08:38:08.673Z`.

### Measured

- UI01, UI02 as runs 1-2 (15.19.0.003; 36 ticks, median 5.01 s; amcheck
  heap 9/9, btree 16/16 and 16/16; sequences 8/8). UI03a unchanged.
- UI03b progress timeline (first seen, 5 s polling):

  | step | offset | time (UTC) |
  |---|---|---|
  | `1_started` | +21 s | 08:38:29.893Z |
  | `2_launched_upgraded_instance` | +129 s | 08:40:18.140Z |
  | `4_attached_volume_to_original_instance` | +145 s | 08:40:33.584Z |
  | `5_initiated_data_upgrade` | +160 s | 08:40:49.088Z |
  | `6_completed_data_upgrade` | +253 s | 08:42:21.840Z |
  | `7_detached_volume_from_original_instance` | +269 s | 08:42:37.308Z |
  | `8_attached_volume_to_upgraded_instance` | +274 s | 08:42:42.414Z |
  | `9_completed_upgrade` | +289 s | 08:42:57.812Z |
  | ACTIVE_HEALTHY on 17.11 | +305 s | 08:43:13.479Z |

- UI03e: before the POST, 15.19, postmaster `2026-10-23 06:36:19.007333+00`,
  sysid `7692130795874382474`, `addr#1`, LSN `0/60616A8`, xid 1462. After:
  17.11, postmaster `2026-10-23 08:43:22.298534+00`, sysid
  `7699780795292339104`, `addr#2`, LSN `0/16044E78`, xid 2898. Both:
  `synchronous_commit` on, `fsync` on, `wal_level` logical.
- Direct connection: `getaddrinfo ENOTFOUND` from this vantage on all 5
  attempts (UI03g, skip) and again in UI06e. Not tested.
- Management API (UI03c): 345 attempts, 45 acknowledged. Seqs 14 to 312
  (+3 s to +301 s) all answered `400 Database is possibly not accessible at
  the moment`; acknowledgements resumed at +302 s on 17.11. At 3 s cadence
  in runs 1-2 the same path was answered by the original 15.19 postmaster
  until about +221 s and then intermittently by a restarted 15.19 postmaster
  (run 2 seqs 84, 85, 97, 99, +239 s to +284 s; run 1 seqs 80 to 94, all
  lost); why run 3 was refused from the start of the window was not
  separated.
- Session pooler (UI03d) and transaction pooler (UI03f): 338 attempts each,
  330 acknowledged, 8 failed. Both show the same identity sequence:

  | postmaster start | sysid | addr | acknowledged (start offset) | LSN range | xid range | after the upgrade |
  |---|---|---|---|---|---|---|
  | 06:36:19.007333 (original 15.19) | ...382474 | addr#1 | seq 1-238 (to +227 s) | 0/605E000..0/808D9A0 | 1459..2274 | 489 of 489 kept (all paths) |
  | 08:41:57.845663 (15.19) | ...382474 | addr#1 | seq 240-242 (+229..232 s) | 0/900C000..0/9017410 | 2278..2290 | 6 of 6 kept |
  | 08:42:02.353886 (15.19) | ...382474 | addr#1 | seq 244 (+234 s) | 0/A000710..0/A001D50 | 2291..2292 | 2 of 2 kept |
  | 08:42:13.830604 (15.19) | ...382474 | addr#1 | seq 249-292 (+243..288 s, acks +246..288 s) | 0/C00E648..0/C05D168 | 2296..2434 | 0 of 88 kept |
  | 08:42:58.070774 (17.11) | ...339104 | addr#2 | seq 294-316 (+290..312 s) | 0/112B2000..0/13065260 | 2716..2804 | 57 of 57 kept |
  | 08:43:22.298534 (17.11) | ...339104 | addr#2 | seq 318-338 (+314..334 s) | 0/14000988..0/16044D10 | 2805..2897 | 63 of 63 kept |

  (UI04e; the 06:36 and 17.11 rows include Management API writes.) Failures
  between them: `Client has encountered a connection error`, and seqs
  246-248 `Failed to connect to database: {:error, :econnrefused}` on both
  the session pooler and the transaction pooler.
- UI04c: present after the upgrade: mgmt 45/45, session pooler 286/330,
  transaction pooler 286/330; the 88 lost writes are exactly the 44 + 44
  acknowledged by the postmaster started `2026-10-23 08:42:13.830604+00`.
  Baseline rows kept: ticks 36/36, archive 54/54, job_run_details 39/39.
- UI06e: after the 180 s settle, a fresh session-pooler connection saw
  617/705 acknowledged writes (617 rows): the same 88 absent.
- UI04e: highest txid in any acknowledged write 2897; `txid_current()` on
  17.11 after the upgrade 2898. The lost writes' xids (2296..2434) are below
  the first xid seen on 17.11 (2716).
- UI04f (one window, `2026-10-23 08:41:57.845663+00` to
  `2026-10-23T08:42:56.793Z`, the last acknowledgement from the 08:42:13
  postmaster): job_run_details 3, ui_ticks 2, ui_minute 1 rows present.
  UI06a/b: last tick on 15 `2026-10-23 08:41:52.427149+00`, first on 17
  `2026-10-23 08:42:46.169776+00` (gap 53.7 s, about 10 runs never started);
  `ui-minute` last on 15 `2026-10-23 08:42:00.033325+00`, first on 17
  `2026-10-23 08:43:00.063663+00` (gap 60.0 s, none skipped). Those place
  the 2 ticks on 17.11 and the minute row on the 08:41:57 postmaster, so no
  pg_cron row survives from the 08:42:13 postmaster's span (derived from the
  three counts; the window was too wide to show it directly, and UI04f now
  counts per postmaster for later runs).
- UI04a/b, UI05, UI06c/d: amcheck heap 9/9, btree 16/16 and 16/16 after;
  sequences 8/8; VACUUM FREEZE as `postgres` on all five tables with
  relfrozenxid advanced (`cron.job_run_details` age 1710 -> 1, relfrozenxid
  1195 -> 2905); job_run_details since POST-60 s `ui-tick` 98 and
  `ui-minute` 9, all `succeeded`; 41/41 ticks on 17 moved queue messages;
  direct pgmq round trip worked.
- UI99: DELETE 200, gone at the first listing.

### Readings

The loss reproduced (third run of three), on both pooler paths, with every
lost write identified. Two hypotheses were named before the run:

1. A pre-upgrade instance restarted after the snapshot. Supported. The
   postmaster that acknowledged all 88 lost writes reports the original
   cluster's system_identifier (`...382474`) and the original address label
   (`addr#1`), its WAL positions continue past the last kept write on that
   cluster (0/A001D50 kept, 0/C00E648 lost onward), and it was the third
   restart of that cluster during the window. The 17.11 instance has a
   different system_identifier (`...339104`, a new cluster, as pg_upgrade
   produces) and address. The 15.19 data carried into 17.11 ends between
   the 08:42:02 postmaster's last write (+234 s, kept) and the 08:42:13
   postmaster's start (about +245 s from the two timestamps).
2. A harness or visibility artifact. Not supported. Each lost write returned
   its txid and LSN from a completed autocommit insert (node-postgres
   resolves a query only at ReadyForQuery, after commit; `synchronous_commit`
   on, `fsync` on); the writes were absent through the Management API
   (UI04c) and again three minutes later through a fresh pooler connection
   (UI06e); and loss splits exactly by server identity, not by path: 0 lost
   from the two earlier restarts of the same cluster or from either 17.11
   postmaster.

Inference, not measured: the lost postmaster acknowledged writes until about
+288 s (client clock), after `7_detached_volume_from_original_instance`
(+269 s) and `8_attached_volume_to_upgraded_instance` (+274 s), while the
first 17.11 tick is stamped `2026-10-23 08:42:46.169776+00` (server clock):
on those clocks a 15.19 and a 17.11 postmaster accepted writes at the same
time for about 10 s. Client-server clock skew was not measured.

Not run: the direct connection (no DNS answer here), the Data API, compute
above Micro, repeats beyond n = 3.

## 2026-10-26 - run 4 (five write paths: Data API added; UI04f per postmaster)

Purpose: the run 3 code with UI04f counting pg_cron rows per restarted
postmaster (never run before), a fourth repeat of the loss, and the Data API
as a write path. Changes since run 3: UI03h writes every 1 s through
PostgREST (`POST /rest/v1/ui_client?select=...` with the legacy service_role
key, `Prefer: return=representation`, 15 s client timeout); the fixture
grants `select, insert` on `ui_client` and sequence usage to `service_role`
explicitly, and `ui_sysid()` / `ui_lsn()` are SECURITY DEFINER so the
PostgREST role reads the same identity. Harness: `make run`, lab commit
adc597c plus this experiment staged. Vantage as above; other agents ran live
work from the same Mac at the time. Published:
`out/2026-10-26/run-2026-10-26T05-45-51-382Z.json` and `.facts.md`, 32
results (17 pass, 2 fail, 2 skip, 11 info; the fails are UI04c and
UI06e-session, the lost writes). POST returned at
`2026-10-26T05:49:17.646Z`.

### Measured

- UI01, UI02 as runs 1-3: create 201, 15.19.0.003, eligible, one target
  `17:supabase-postgres-17.11.0.003`; 36 ticks, median gap 5.01 s, 39
  runs `succeeded`; amcheck 1.3 heap 9/9, `bt_index_check` 16/16,
  `bt_index_parent_check` 16/16; sequences 8/8. UI03a unchanged.
- UI03b progress timeline (first seen, 5 s polling): `1_started` +16 s,
  `2_launched_upgraded_instance` +129 s,
  `4_attached_volume_to_original_instance` +144 s,
  `5_initiated_data_upgrade` +165 s, `6_completed_data_upgrade` +252 s,
  `8_attached_volume_to_upgraded_instance` +273 s, `9_completed_upgrade`
  +299 s, ACTIVE_HEALTHY on 17.11.0.003 +330 s; UI03b done (healthy and a
  Management API write on 17.11) after 335 s.
- UI03e: before, 15.19, postmaster `2026-10-24 11:35:35.234318+00`, sysid
  `7692130795874382474`, `addr#1`; after, 17.11, postmaster `2026-10-26
  05:54:34.656441+00`, sysid `7700850537018948818`, `addr#3`.
  `synchronous_commit` on, `fsync` on. The pre-upgrade sysid is the same
  value run 3's fresh project reported. The postmaster started about 42 h
  before this run's `POST /v1/projects`, and the create response's own
  `created_at` (`2026-10-24T11:33:40.62798Z`) is earlier still. Every run's
  UI01a evidence shows the same pattern: `created_at`
  `2026-10-22T20:27:25.129144Z` (run 1), `2026-10-22T20:40:49.010231Z` (run
  2), `2026-10-23T06:34:10.648021Z` (run 3), 2 h to 42 h before each run
  started, and healthy 3 s after the POST in all four (inference: the create
  returned a project provisioned ahead of the request; not examined
  further).
- Management API (UI03c): 370 attempts, 48 acknowledged; seqs 14 to 335
  (+3 s to +329 s) all `400 Database is possibly not accessible at the
  moment`, as in run 3; acknowledgements resumed at +330 s on 17.11.
- Data API (UI03h): 253 attempts, 36 acknowledged, 217 failed. Seqs 1-27
  acknowledged on the original 15.19 postmaster up to +16 s; seqs 28-231
  (+17 s to +287 s) `503 upstream connect error or disconnect/reset before
  headers ... remote connection failure`; then 525 (seq 232), 521 (seqs
  233-240, +289 s to +296 s) and client timeouts; acknowledged on 17.11 from
  +312 s. No Data API write was acknowledged by a restarted 15.19
  postmaster. PostgREST's writes carry their own address label (`addr#2` in
  this run, on both clusters; labels are assigned per run, so run 3's
  `addr#2` was 17.11), so the address column separates paths, not instances,
  for that writer.
- Session pooler (UI03d) 358 attempts, 344 acknowledged, 14 failed;
  transaction pooler (UI03f) 356 attempts, 344 acknowledged, 12 failed.
  Identity sequence (UI04e; the original and 05:54:34 rows include
  Management API writes, the original, 05:54:04 and 05:54:34 rows Data API
  writes):

  | postmaster start | sysid | acknowledged (start offset) | LSN range | xid range | after the upgrade |
  |---|---|---|---|---|---|
  | 2026-10-24 11:35:35.234318 (original 15.19) | ...382474 | pooler/txn seq 1-238 (to +227 s), mgmt seq 1-13, rest seq 1-27 | 0/11044000..0/13045248 | 1462..2310 | 489 + 27 of 516 kept |
  | 05:53:06.497835 (15.19) | ...382474 | seq 240-242 (+229..231 s) | 0/1400BAF8..0/14013648 | 2314..2319 | 6 of 6 kept |
  | 05:53:21.302392 (15.19) | ...382474 | pooler seq 249-292, txn seq 248-291 (+243..288 s, acks +246..288 s) | 0/1700F338..0/1706CA48 | 2323..2472 | 0 of 88 kept |
  | 05:54:04.798837 (17.11) | ...948818 | pooler/txn from +303 s, rest seq 242-243 | 0/1C2E0A00..0/1C3121B8 | 2760..2798 | 24 + 2 kept |
  | 05:54:34.656441 (17.11) | ...948818 | to +364 s | 0/1D000990..0/1F07EB90 | 2799..2998 | 129 + 7 kept |

- UI04c: present after the upgrade: mgmt 48/48, session pooler 300/344,
  transaction pooler 300/344, Data API 36/36; the 88 lost writes are
  exactly the 44 + 44 acknowledged by the postmaster started
  `2026-10-26 05:53:21.302392+00`. Baseline rows kept: ticks 36/36, archive
  54/54, job_run_details 39/39. UI06e: after the 180 s settle a fresh
  session-pooler connection saw 684/772 acknowledged writes, the same 88
  absent. Direct connection: `getaddrinfo ENOTFOUND` again (UI03g,
  UI06e-direct skip).
- UI04f (per postmaster, first run of this form): 05:53:06 window
  (postmaster start to its last acknowledgement, `2026-10-26T05:53:08.972Z`,
  2.5 s; the postmaster's later span to about 05:53:21 is not counted)
  job_run_details 0, ui_ticks 0, ui_minute 0; 05:53:21 window (to
  `2026-10-26T05:54:05.748Z`) job_run_details 3, ui_ticks 2, ui_minute 1.
  UI06a/b: last tick on 15 `2026-10-26 05:53:04.34057+00` (+226.7 s), first
  on 17 `2026-10-26 05:53:53.711784+00` (gap 49.4 s, about 9 runs never
  started); `ui-minute` last on 15 `2026-10-26 05:53:00.110189+00`, first on
  17 `2026-10-26 05:54:00.109457+00` (gap 60.0 s, none skipped). `ui_ticks`
  records `server_version`, and the last surviving 15.19 tick predates both
  restarts, so the rows UI04f counts in the 05:53:21 window are 17.11 rows
  (the first 17 tick and minute fall inside it): no pg_cron row from either
  restarted 15.19 postmaster survives. Whether pg_cron fired on the lost one
  is not observable from the upgraded data.
- UI04a/b, UI04d: amcheck 1.4 heap 9/9, `bt_index_check` 16/16,
  `bt_index_parent_check` 16/16 clean after; sequences 8/8; cron.job,
  cron relations and pgmq tables identical.
- UI05, all five pass as `postgres` through the session pooler, 8 to 13
  ms, no warning: `cron.job_run_details` (owner `supabase_admin`) age
  1812 -> 1, relfrozenxid 1200 -> 3012, VERBOSE `aggressively vacuuming`,
  `new relfrozenxid: 3012, which is 1812 XIDs ahead of previous value`,
  113 tuples frozen; `pgmq.q_ui_q` 246 -> 1; `pgmq.a_ui_q` 1811 -> 0;
  `public.ui_events` 1797 -> 0; `public.ui_ticks` 1812 -> 0; mxid_age 0
  before and after.
- UI06c/d: job_run_details since POST-60 s `ui-tick` `succeeded` 104,
  `ui-minute` 9, no other status in the table; 46/46 ticks on 17 sent and
  read (archived 69, deleted 69); direct send / read / archive / metrics
  answered.
- UI99: DELETE 200, absent from `GET /projects` at the first check; `make
  clean` afterwards listed 0 projects with the prefix (console output, not
  in the artifact).

### Readings

The loss reproduced in the fourth run of four, with the same shape as run 3:
client writes saw two restarts of the original 15.19 cluster (same
system_identifier, same address label) inside the window, writes on the
first restart were kept, and every write acknowledged by the second one
(started about +244 s, derived from the postmaster start and the POST time,
between `5_initiated_data_upgrade` and `6_completed_data_upgrade` as polled)
is absent on 17.11 while its LSNs continue past the last kept write. The
15.19 data carried into 17.11 ends between +231 s (last kept write) and
+244 s.

The two HTTP paths were not exposed in this run: the Management API query
endpoint refused from +3 s and the Data API from +17 s until 17.11 answered,
so neither had a write acknowledged by a restarted 15.19 postmaster.
Whether that refusal is a deliberate guard, and why the poolers keep
connecting meanwhile, was not examined.

Inference, not measured: the lost postmaster acknowledged until +288 s
(client clock) while the first 17.11 tick is stamped
`2026-10-26 05:53:53.711784+00` (+276 s on the server clock), an apparent
overlap of about 12 s (run 3: about 10 s); client-server clock skew was not
measured. As in run 2, the first 17.11 tick predates the first 17.11
postmaster start any client write saw (05:54:04.798837).

Not run: the direct connection (no DNS answer from this vantage), compute
above Micro, a larger database, other regions, 17 to a newer major, n > 4.
