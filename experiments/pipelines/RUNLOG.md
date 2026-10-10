# pipelines RUNLOG

Chronological record of what was run. Project refs, organisation slugs and
credentials are not recorded; the org class is (Pro).

Sources for the documented claims quoted below, all read 2026-10-10:
https://supabase.com/changelog/pipelines,
https://supabase.com/docs/guides/database/replication,
https://supabase.com/docs/guides/database/replication/pipelines,
https://supabase.com/docs/guides/database/replication/pipelines/ducklake,
https://supabase.com/docs/guides/database/replication/pipelines-faq,
https://supabase.com/docs/guides/database/replication/pipelines-monitoring,
https://supabase.com/docs/guides/platform/manage-your-usage/pipelines.
Source of the Dashboard route names and request bodies (read, not run): the
open-source Studio data layer under `apps/studio/data/replication` in the
public supabase/supabase repository.

## What entity was measured

The task brief asks about the managed service. A destination that needs no
third-party credentials exists: DuckLake, whose Postgres catalog and object
store can both be Supabase projects (docs, "Select Supabase projects"). The
managed service could not be driven: its control plane is the Dashboard's
`/platform/replication/{ref}/...` route family and a personal access token is
refused there (PL01). Creating a pipeline with the Dashboard needs a human
session and was not done. Also, the changelog of 2026-07-21 lists DuckLake as
"available on request via early access form" while the docs read on
2026-10-10 list it as public alpha and say "an eligible plan does not guarantee
access"; whether the Pro org used here has DuckLake access was not observed.

Every behaviour figure below therefore comes from the open-source engine that
the docs say the managed service runs (the supabase/etl repository), run as its
public container image from a laptop:

- engine commit pinned in `lib/stack.ts` (`3fc88dd52a55...`, the main branch
  head on 2026-10-09; which commit the managed service runs was not observed);
- DuckLake destination with a local Postgres 16 catalog and a local
  S3-compatible store (VersityGW), not Supabase projects;
- source: one Pro-org project, eu-central-1, Micro compute, IPv4 add-on
  (direct 5432 is IPv6-only otherwise and the replicator container has no IPv6),
  PostgreSQL `17.11`;
- vantage: a laptop in Singapore. `select 1` round trip to the source, over 15
  calls (PL02a): p50 `171` ms, max `176` ms. The managed service documents that
  its pipelines run in eu-central-1, next to this source, so copy time and lag
  here include a transcontinental round trip that the managed topology does not
  have. Read them as pessimistic bounds on the engine, not as managed figures.

Two earlier development runs (same day) are not quoted except where named:
they used a SeaweedFS object store that stalled the first large write for about
19 minutes and returned HTTP 500 before volumes existed; it was replaced by
VersityGW before the runs below.

## 2026-10-10 - run 1 (PL01-PL08), run 2 (PL07 repeat), PL99

Run 1: `PL01,PL02,PL03,PL04,PL05,PL06,PL07,PL08` in one invocation, project
created by PL02, 4 pass, 1 fail, rest info. Run 2: PL07 alone on the same
project. PL99 deleted the project; `GET /v1/projects` then listed none with the
`pl-` prefix (PL99: DELETE 200, 0 left). Local containers and volumes
removed. No AWS or Cloudflare resource was created. Figures are pasted from
`pvlab --facts` of the run artifacts (untracked `evidence/`).

### PL01 - API surface (n = 1 probe per route)

- PL01a: `GET /api/v1-json` 200, 115 paths, 0 match
  `pipeline|replication|etl|destination|ducklake|warehouse` (read-replica
  routes excluded).
- PL01b: `GET /platform/replication/{ref}/{sources,destinations,pipelines}`
  with the PAT: 401 `{"message":"Unsupported access token"}` on all three, for
  an unused ref. Control: `GET /v1/projects` with the same PAT 200. The probe
  against the lab's own project ref did not run in run 1 (no project existed
  when PL01 ran); an earlier development run against a live project of the lab
  gave the same 401 on all three routes.
- Not measured: whether a Dashboard session token reaches those routes; the
  request bodies are known only from the Studio source (a `ducklake` destination
  config with `catalog.type: supabase_project` and `storage.type:
  supabase_storage`, posted to `/platform/replication/{ref}/destinations-pipelines`).

### PL02 - source facts and initial copy (n = 1 run, 1,000,000 rows)

- PL02a: PostgreSQL `17.11`, `wal_level` logical, `max_replication_slots` 10,
  `max_wal_senders` 10, `max_slot_wal_keep_size` 512MB, `wal_keep_size` 0,
  `checkpoint_timeout` 5min, no slot and no `etl` schema before the first
  start, `postgres` role `rolbypassrls` true. Project create 201; the IPv4 add-on
  record resolved 10 s after the PATCH.
- PL02b: table of 1,000,000 rows (heap `101.1` MB, `123.7` MB with indexes)
  seeded server-side in `5.4` s. From `compose up` to `sync_done`: 53 s, of
  which `data_sync` to `finished_copy` took `13.3` s (`7.61` MB/s of heap) and
  `finished_copy` to `sync_done` `1.2` s; the rest is engine start and slot
  creation over the `171` ms link. State timeline from the source's
  `etl.replication_state`: init, data_sync, finished_copy, sync_done. `ready`
  came `13.5` s after a one-row update, not on its own: a table sits at
  `sync_done` until the apply loop sees later WAL. Slots seen during the copy:
  at most 2 (`supabase_etl_apply_<id>`, `supabase_etl_table_sync_<id>`).
  Destination count, `sum(id)`, `sum(qty)` and `sum(length(note))` equal the
  source.
- First start installed in the source an `etl` schema (state, schema and
  progress tables plus helper functions) and the event trigger
  `supabase_etl_ddl_message_trigger`, as the FAQ documents.
- Not measured: copy time of the managed service, copy of tables above 1M rows,
  the effect of the managed "Initial sync connections per table" and "Table
  sync workers" settings (engine defaults used), the doc-cited initial sync
  price (0.60 USD per GB).

### PL03 - steady lag (n = 65 and 63 probe rows, 90 s windows)

A writer inserted a row every 0.8 to 1.6 s; a DuckDB session on the destination
polled `max(id)` (poll duration p50 `10`-`11` ms, p95 `14` ms). Lag = laptop
clock at first poll that sees the row minus laptop clock at commit
acknowledgement.

| batch wait (`batch.max_fill_ms`) | min | p50 | p95 | max |
|---|---|---|---|---|
| 10000 ms (engine default; docs list "Batch wait time" 10000 ms) | 235 ms | 5577 ms | 10177 ms | 10940 ms |
| 1000 ms | 90 ms | 1131 ms | 1880 ms | 1928 ms |

All 65 and 63 rows were seen. Lag tracks the batch wait; the engine's own
processing and the laptop link add under about 1 s on top. Not measured: lag
under sustained high write rates, lag with the managed topology.

### PL04 - RLS (n = 1 run each)

- PL04a control: as `authenticated` the source table reads 0 of 1000 rows.
- PL04b: engine connecting as `postgres` (BYPASSRLS): destination 1000 of 1000
  after the initial copy; after 200 inserts and 20 deletes 1180 of 1180; 50 of
  50 updates present. RLS filtered neither the copy nor the change stream.
- PL04c: publication `(id, owner) where (owner = 'keep')`: destination 500 of
  1000 rows, columns `id owner`, owner values `keep`.
- PL04d: engine connecting as a role with REPLICATION, NOBYPASSRLS and SELECT,
  whose only policy exposes 100 of 1000 rows: the initial copy reached
  `sync_done` with no error and the destination held 100 of 1000 rows. The
  change stream was not tested in this configuration.
- The docs read on 2026-10-10 do not mention RLS; the brief's "RLS does not
  apply" is therefore measured here, not doc-verified. Which database role the
  managed service connects as was not observed.

### PL05 - DDL, DuckLake destination (n = 1 statement each, batch wait 1000 ms)

Each statement ran on a `ready` table; one row shaped for the new schema was
inserted after it. "Visible" is the time until that row appeared at the
destination. A plain row at the same batch wait showed a p50 of 1131 ms (PL03b),
so the schema change itself added about 4 s in these single probes. The
visible times are quantised: the check loop sleeps 700 ms between polls (5.7 s
is 5 s plus one poll), and the near-constant 5 s may be a fixed engine or poll
interval rather than a per-statement cost; n = 1 per statement cannot tell.

| step | visible | destination result |
|---|---|---|
| add nullable column | 5 s | column present, nullable |
| add column default 42 | 5 s | column nullable, default `'42'`; old row 1 reads 42 |
| add column default `gen_random_uuid()` | 5 s | column present, no default; WARN "skipping unsupported source column default" |
| add NOT NULL column default 7 | 5.7 s | column nullable, default `'7'`; WARN "adding a source not null column as nullable" |
| rename column | 5 s | renamed |
| drop column | 5 s | column absent |
| drop NOT NULL | 5 s | nullable |
| set NOT NULL | 11.4 s | destination stays nullable; WARN "does not tighten an existing nullable column" |
| set default 9 | 5 s | default `'9'`; a row without the column reads 9 |
| drop default | 5 s | default removed |
| type change int to bigint, then row b=1 | 5.7 s | destination stays INTEGER; WARN "column type changes are currently unsupported ... may fail or behave unpredictably"; the row replicated |
| row b=5000000000 after the type change | not seen in 60 s | 62 WARN/ERROR lines, first `error append row ... Call to EndRow before all columns have been appended to!`; destination INTEGER |
| a later row b=1 | not seen in 120 s | the replicator process had exited: `[DestinationAtomicBatchRetryable] DuckLake atomic table batch sequence failed after retries`; `etl.replication_state` still said `ready` |

Final column lists: source `id a b c2 e f g h` with `e`, `h` and `b` NOT NULL;
destination same names, all nullable except `id` and `b`. The attribution of
the failure to the out-of-range value is an inference from the pair (row b=1
passed, row b=5000000000 failed after the same type change); the separating
probe (a bigint destination) cannot be run because the destination cannot take
the type change. The docs line "Data type changes are skipped with a warning in
every destination" holds for the schema change and does not cover the rows
that follow.

### PL06 - duplicates after a forced restart (n = 11 trials)

Two tables written at about 100 rows/s each (20-row inserts every 150 ms), one
with a primary key and one without (insert-only). Trials: four SIGKILLs at
25-34 s and one SIGTERM at 30 s with the default batch wait; six SIGKILLs at
8-19 s with a 1000 ms batch wait. After each trial the destination was waited
to hold every source id and be stable for 20 s.

Result: 0 duplicate rows in either table in all 11 trials (distinct ids equal
row count; every source id present). SIGKILL returned in 106-364 ms (the 10 SIGKILL trials); restart
to converged destination took 43-56 s. The destination was behind the source at
the moment of the kill (for example 2086 of 2146 rows in default trial 1), so
the kills landed with data in flight. This does not show that replay cannot
duplicate: the docs claim at-least-once and the engine ships a
`__etl_replay_epochs` table in the DuckLake catalog (seen in its start-up log
notices, not studied), which may suppress replay on this destination. Eleven
kills sample a narrow window (between the destination commit and the slot
acknowledgement) a few times; zero events in 11 is "none observed", not a
bound.

### PL07 - stopped pipeline and retained WAL (run 1, run 2, plus one dev run)

Source `max_slot_wal_keep_size` 512MB, which is `536.9` MB (10^6-byte MB used
throughout). The invalidation part used a table of 100,000 rows of about 1 KB.

- PL07a: running slot `reserved`, retained 1 MB (run 1) and 0 MB (run 2),
  unconfirmed 0, `safe_wal_size` `552.5` MB (run 1) and `547.7` MB (run 2).
- PL07b: SIGTERM stop took `0.6` s (run 1) and `0.8` s (run 2); slot `active`
  false. With no writes for 30 s retained WAL did not grow (0 KB). Writing
  75,000 rows (5000 per 10 s for 150 s) raised retained WAL to `47.2` MB (run 1)
  and `30.7` MB (run 2): 616 and 409 bytes per row written. Growth was linear
  in run 2 (`2 4 6 8 ... 30.7`) and stepped in run 1 (`3 5 7 18.6 20.6 ...
  33.3 ...`). The 616 vs 409 bytes per row spread between the runs is
  unexplained. Slot stayed `reserved`;
  `safe_wal_size` fell to `506.3` MB (run 1) and `517` MB (run 2).
  `pg_ls_waldir()` is readable by the `postgres` role: 18 files, `285.2` MB
  before and after (run 1).
- PL07c: restart to destination equal to source and unconfirmed WAL under 1 MB:
  `41.4` s (dev run), `43.6` s (run 2); run 1 did not drain in 180 s
  (destination stuck at 100,000 of 175,000 rows with `116.3` MB unconfirmed).
  The run-1 stall was not diagnosed. n = 3, one fail.
- PL07d: with the replicator stopped, three full-table UPDATE passes (25-35 s)
  took retained WAL to `773.6` MB (run 1) and `688.5` MB (run 2), over the
  `536.9` MB limit; `wal_status` read `unreserved` before any checkpoint
  (`safe_wal_size` `-220.1` and `-140.8` MB); `CHECKPOINT` is refused for the
  `postgres` role (`permission denied to execute CHECKPOINT command`); the slot
  became `lost` (`invalidation_reason` `wal_removed`) 368 s (run 1) and 215 s
  (run 2) after. No checkpoint was observed; the attribution to an automatic
  checkpoint is inferred from `checkpoint_timeout` 5min, which both delays are
  consistent with.
  The WAL directory peaked at `822.1` MB (50 files). `extended` was not seen:
  the first sample after each pass was already `unreserved`.
- PL07e: restart with the default `invalidated_slot_behavior`: the container
  exited within 60 s with `[ReplicationSlotInvalidated] Replication slot has
  been invalidated`; `etl.replication_state` still said `ready`.
- PL07f: restart with `invalidated_slot_behavior: recreate` after deleting 50
  rows at the source while the slot was lost: destination reached the new count
  (174,950) after `47.5` s (run 1) and `43.3` s (run 2), table states init,
  data_sync, finished_copy, sync_done, new slot `reserved` and active. The
  deletes could not have come from the lost WAL, so the table was rebuilt
  rather than caught up.

### PL08 - billing add-on (n = 1)

- PL08a: `GET /v1/projects/{ref}/billing/addons` lists `etl_pipeline` variant
  `etl_pipeline_default`, listed as 39 USD per month, `price.amount` `0.053`,
  interval hourly, type usage. `0.053` x 730 is `38.69` USD, which matches the
  docs' per-hour figure and the "ETL Pipeline Hours 730 Hours" example line in
  the usage page.
- PL08b: `PATCH /v1/projects/{ref}/billing/addons` with
  `{addon_type: "etl_pipeline", addon_variant: "etl_pipeline_default"}` answered
  400 `{"message":"addon_variant: Invalid input"}`; the same call shape worked
  for `ipv4`/`ipv4_default` on the same project. Nothing was attached, so no
  detach ran.
- Not measured: whether charges continue while a pipeline is stopped (docs:
  pipeline-hour billing continues while stopped; deleting ends it). That needs a
  managed pipeline and an invoice or usage export.

## Docs claims and their status

| claim (source) | status |
|---|---|
| at-least-once; recovery can replay acknowledged data (FAQ) | engine, DuckLake: 0 duplicates in 11 trials (PL06); claim neither confirmed nor refuted |
| add/drop/rename column, nullability, defaults replicated (changelog, DuckLake guide) | engine: measured per statement (PL05); tightening NOT NULL and volatile defaults skipped with a WARN as documented |
| type changes skipped with a warning (pipelines page) | engine: WARN seen; a value outside the old range then failed writes and the process exited (PL05) |
| RLS does not apply | engine, role with BYPASSRLS: confirmed on copy and change paths (PL04b); role without BYPASSRLS: copy delivered 100 of 1000 rows (PL04d) |
| stopped pipeline accumulates WAL | engine: confirmed; linear in run 2, stepped in run 1 (PL07b) |
| stopped pipeline billed 0.053 USD/h | doc-cited-not-tested; rate matches the API listing (PL08a) |
| managed pipelines run in eu-central-1 | doc-cited-not-tested |
| plan and access: "Pro, Team, or Enterprise plan" (FAQ), "availability varies by organization" | doc-cited-not-tested; DuckLake access of this org unknown |

## Unmeasured, with the missing prerequisite

- Everything on the managed service: a Dashboard session (human login) to
  create, stop and restart a pipeline, plus an invoice or usage export for
  billing while stopped.
- The Supabase-backed DuckLake catalog and Storage (docs, "Select Supabase
  projects"): needs the Dashboard flow; the engine accepts a catalog URL and S3
  credentials, which this lab pointed at local containers.
- BigQuery, ClickHouse, Snowflake: accounts this lab does not have.
- Engine runs from the managed topology (a host in eu-central-1): not run.
