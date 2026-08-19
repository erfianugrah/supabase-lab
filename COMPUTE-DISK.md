# Compute & Disk Reference

Every load-bearing claim about Supabase compute sizing, disk behaviour, and
upgrade/downgrade paths, across every plan tier you have access to
(Free / Pro / Team). Numbers were measured on throwaway projects in
supabase-lab (experiment `compute-disk`, ids D01-D09); where a number could
not be measured it is labelled. Labels:

- `measured` - ran on a live project here, paste evidence in the experiment files.
- `doc-verified` - from the Supabase docs; cited, not run.
- `doc-not-reproduced` - docs claim X; runtime disagreed. The divergence is the finding.

## TL;DR - hard answers

| Question | Answer | Evidence |
|---|---|---|
| Does compute auto-upgrade? | No. Manual addon PATCH; ~2min downtime doc-cited, ~107s measured (micro->small) | D01 (measured) |
| Does the disk ever shrink? | No (measured; decrease rejected HTTP 400). Only "right-sized" to 1.2x db size (min 8GB) on a Postgres version upgrade | D02 (measured), doc-verified |
| Disk modification quota on paid plans | Runtime enforces 429 "Database disk can only be modified once per four hours. Last modified at <UTC>." Docs say "4 modifications per rolling 24h". One round burst of 5 accepted, another rejected the 2nd - the quota message contradicts the docs and enforcement is nondeterministic | D03 (measured) |
| Free plan read-only trigger | Docs: 500MB db size. Runtime: writes accepted to 726MB db size, then read-only kicks in. Verbatim error `ERROR: 25006: cannot execute INSERT in a read-only transaction` | D06 (measured) |
| Read-only recovery | Docs: delete data + vacuum, or override GUC. Runtime: TRUNCATE is rejected WITH HTTP 400 - use DELETE then vacuum | D06b (measured) |
| Autoscale config editable via API? | NO. GET /config/disk/autoscale returns an empty shape; PUT/POST/PATCH all 404 on Pro AND Team orgs. Dashboard edits it somewhere else | D04/D07 (measured) |
| Disk IOPS/throughput gate | Dashboard: "LARGE compute or above". Runtime: POST config/disk with elevated IOPS/throughput accepted AND subsequent GET showed it stuck on Micro. The gate is dashboard-only | D08 (measured) |
| Spend cap is a request-path breaker? | No - measured in W21: all render calls past quota returned 200. Its consequences ride the billing path (notify, grace, Fair Use restriction) | W21 (measured) |

## 1. Compute

### Sizes (doc-verified; per-size pg_limits measured D01)

| Size | Hourly | Monthly | CPU | Memory | Max DB recommended |
|---|---|---|---|---|---|
| Nano | $0 | $0 | shared | up to 0.5 GB | 500 MB |
| Micro | $0.01344 | ~$10 | 2-core shared | 1 GB | 10 GB |
| Small | $0.0206 | ~$15 | 2-core shared | 2 GB | 50 GB |
| Medium | $0.0822 | ~$60 | 2-core shared | 4 GB | 100 GB |
| Large | $0.1517 | ~$110 | 2-core dedicated | 8 GB | 200 GB |
| XL | $0.2877 | ~$210 | 4-core dedicated | 16 GB | 500 GB |
| 2XL | $0.562 | ~$410 | 8-core dedicated | 32 GB | 1 TB |
| 4XL | $1.32 | ~$960 | 16-core dedicated | 64 GB | 2 TB |
| 8XL | $2.562 | ~$1,870 | 32-core dedicated | 128 GB | 4 TB |
| 12XL | $3.836 | ~$2,800 | 48-core dedicated | 192 GB | 6 TB |
| 16XL | $5.12 | ~$3,730 | 64-core dedicated | 256 GB | 10 TB |
| >16XL | - | - | custom | custom | custom |

Micro through 2XL is shared/burstable (once burst credits drain, baseline
prevails). Large and above are dedicated (doc-verified).

Nano on paid orgs: rejected with `400 Minimum instance size on paid plans is
Micro` (measured I01) - the Nano floor applies only to free orgs.
Free org Nano lifecycle: pause/restore live, ~162-204s wake (measured I04).

Per-size pg_limits (D01 measured, micro vs small):

| | micro | small | note |
|---|---|---|---|
| max_connections | 60 | 90 | Supavisor pools more |
| max_wal_senders | 10 | 10 | replication senders |
| max_replication_slots | 10 | 10 | cap on subs/physical replicas |
| shared_buffers | 32768 (256MB) | 65536 (512MB) | cache size |

Downgrading REJECTED if you already use more replication slots than the
target tier allows (doc-verified - server won't start).

### Compute ops: upgrade/downgrade, downtime (measured)

- PATCH /v1/projects/{ref}/billing/addons {addon_type:"compute_instance", addon_variant}
- D01 measured micro->small settled in 107s.
- D09 (this lab, local vantage, REST-anon-read + Auth health sampled every
  250ms):
  | op | settle time | max contiguous REST outage | max Auth outage |
  |---|---|---|---|
  | upgrade micro->small | 105 s | 1.0 s | 0 s |
  | upgrade small->large | 61 s | 17.0 s | 0 s |
  | downgrade large->small | 61 s | 0 s | 0 s |
  | downgrade small->micro | 73 s | 0 s | 0 s |
- Consecutive resize PATCHes are themselves rate-limited: a second resize
  immediately after the previous one settled returns 429
  `We are still processing addon changes, please try again in 1-2 minutes`
  (measured D09).
- platform-downtime (measured): restart ~75s on Auth (HTTP 521), resize up
  ~2x restart (Auth 131s vs 75s). Doc-verified: "typically less than 2 minutes."

### Billing (doc-verified)

Compute-hours billed hourly (paused doesn't count), NOT covered by spend cap
(only eligible usage items are; see cost-control).

## 2. Disk

### Types (doc-verified)

| | gp3 | io2 |
|---|---|---|
| Price/GB-mo | $0.125 | $0.195 |
| IOPS price | $0.024/IOPS-mo | $0.119/IOPS-mo |
| Throughput price | $0.95/MBs | scales with IOPS |
| Max IOPS | 16,000 | 80,000 |
| Max size | 16 TB | 60 TB |
| Default | gp3, 3000 IOPS / 125 MBs | opt-in |
| Effective limit | min(compute baseline, provisioned disk) | |

### Data vs disk (measured D05/D06)

- db size = pg_database_size() sum - tables/indexes/MViews.
- disk = db + WAL + system. Monitor via /config/disk/util (OK on free and
  pro - D05 measured).
- Deletes do NOT shrink db size automatically (dead tuples -> vacuum needed;
  TRUNCATE frees instantly) - measured.

### Autoscale (D04/D07 measured; values doc-verified)

- Trigger at 90% disk usage, growth 50%, min increment 1GB, max 8GB if spend
  cap on (Pro). Autoscale still grows even when it would land you past a
  documented plan limit.
- CRITICAL finding: the autoscale config is unreadable AND unmodifiable via
  the public Management API (D04/D07: GET returns empty, mutation verbs all
  404, on Pro AND Team). Dashboard exposes it. Same pattern as
  http-tier-lockdown's Data API toggle.
- Free project started with 2GB disk, not the documented 1GB, and autoscale
  did not flip during fill (D05 measured).

### Manual expansion + quota (D02/D03 measured)

- Decrease attempt rejected HTTP 400. Increase accepted 201 (single change
  +200GB cap - doc-verified). So the "increase only" rule holds.
- Quota: docs name "4 modifications per rolling 24h". Runtime emits 429
  "Database disk can only be modified once per four hours. Last modified at
  <UTC>" - measured D03. The doc's window is 4/day; the runtime message
  contradicts it. Burst of 5 accepted once, then the cooldown kicked in:
  enforcement is nondeterministic; plan for a cooldown you cannot schedule.

### Read-only mode (D06/D06b measured)

- Free plan: writes accepted well past the documented 500MB (D06), then
  read-only kicked in at ~726MB db size with the verbatim error
  `ERROR: 25006: cannot execute INSERT in a read-only transaction`. The
  500MB claim was not the boundary at runtime.
- In read-only: TRUNCATE is rejected too (D06b). SELECT still answered on
  the management query endpoint (201). Recovery: DELETE + vacuum
  (doc-verified) or the override GUC `set default_transaction_read_only='off'`.
- Paid plans: read-only at 95% disk util (doc-verified; not tested here -
  prohibitive fill).

### IOPS/throughput gate (D08 measured)

- Dashboard: "Adjusting your disk configuration requires LARGE Compute or
  above" (verified in evidence).
- Management API: accepted AND applied on Micro (verified via follow-up
  GET). Gate is dashboard-only; API provisioning is unguarded, which also
  means a PAT can raise IOPS on Micro beyond what the dashboard shows.

### Spend cap (edge-resilience W21 measured)

- Spend cap off: overages are billed past quotas; on: infill blocked status.
  Consequences are billing-path: notification -> grace period -> Fair Use
  restriction. Not a request-/API-path breaker.
- Verified exclusions (doc-verified): compute hours, disk throughput, disk
  IOPS-hours, custom domains, PITR, read replicas, IPv4, branching, advanced
  MFA/SSO, log drains.

## 3. Measured evidence (this lab)

| id | finding |
|---|---|
| D01 | micro/small pg_limits table; resize 107s settled |
| D02 | decrease 400/increase 201 - increase-only |
| D03 | quota: 429 once-per-four-hours measured |
| D04 | autoscale GET empty + verbs 404 (Pro) |
| D05 | free db starts 2GB; no autoscale observed through block |
| D06 | free read-only at 726MB db; verbatim 25006 |
| D06b | TRUNCATE rejected in read-only |
| D07 | same autoscale surface gap on Team |
| D08 | IOPS/throughput accepted + applied on Micro |
| D09 | upgrade/downgrade timings + sampled window (see report) |

## Ops playbook

- Bulk import >1.5x current db size: raise disk FIRST with manual POST or the
  quota caps you and the write path goes read-only (measured).
- Track autoscale settings in IaC manually: you cannot read or write them
  through the API (D04/D07). The dashboard retains them.
- Sizing cues: CPU util, Disk IO % consumed (burst-budget drain indicator;
  >0 means past baseline) (doc-verified).
- On Pro: compute bursts back, then IOPS throttle hits; on small tiers the
  HTTP read path can survive several kinds of platform operations with no
  failed samples (platform-downtime - measured).
