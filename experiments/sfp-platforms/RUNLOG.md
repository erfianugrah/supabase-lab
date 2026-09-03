# sfp-platforms RUNLOG

Chronological record of what was actually run. The org under test is supplied
via `PVLAB_ORG_SLUGS`; org slugs are not recorded here (the org classes are).

## 2026-08-24 - initial battery (platform-plan org, ap-southeast-1)

- S01 (13:10-19:39, four revisions): SfP-path create lands on
  `infra_compute_size: nano` (224MB shared_buffers). Three corrections along
  the way: addon shape (`type`/`variants[].id`), read-only query endpoint,
  and the big one - the addon catalogue lists upgrades, not the default, so
  the earlier "nano absent" reading (instance-sizing I01) measured the wrong
  surface. Control arm on a Pro org: default create = micro (256MB).
- S03: restore point `400` - not enabled on this org; undo unreachable (skip).
- S04: migrations `200`; transactional rollback verified; recorded in
  `supabase_migrations.schema_migrations`. Also `200` on a Pro org - NOT
  SfP-gated.
- S05: OAuth project-claim / apps / transfer all `404` - BYO bridge off.
- S06: plan = `platform`; pausing ENFORCED (pause `200` -> INACTIVE,
  restore reverses; Pro org answers `400 not free-tier`); `project_cloning`
  declared but endpoint `404`; realtime 10000 / branching+functions
  unlimited / audit 366d; PITR, private_link, HA off.
- S07: read-replica setup `400` despite `instances.read_replicas: true`.
- S08: disk gp3 2GB/3000 IOPS/125 MiB/s; grow is async (`201` empty);
  gp3 floor makes 2->4GB impossible, first valid grow 6GB+.
- S09: readonly `{enabled:false, override_enabled:false}`; temporary-disable
  `201`.
- S10: org members: full objects (Owner), not a stub.
- S11: backup schedule `402` structured `entitlement_required`
  (`error.feature=backup.schedule`).
- S12: migration create returns `[]`; version is a `YYYYMMDDHHMMSS` timestamp
  recovered from `supabase_migrations`; GET/PATCH by version `200`.
- S13: branch create `201` (UUID id); delete is top-level
  `DELETE /v1/branches/{id}` `200` (corrected from delete-by-name `404`).
- S14: `secret_jwt_template` accepted + echoed (`201`); minted key opaque
  (`sb_secret_...`) - claim binding NOT yet verified (see later entry).
- S15: JIT invite `200` (invite_id), delete `200`.

## 2026-08-25 - key-facts consolidation

AGENTS.md gains the validated key-facts section (platform plan = entitlements
tier decoupled from the form-gates and the OAuth bridge).

## 2026-08-25 - control arm (Pro org): S07 gate hunt + S14 exchange probe

Artifacts: `out/2026-08-25/` (raw run dirs stay local under `evidence/`).

- S07 (gate hunt, new S07d/S07e rungs): baseline setup `400` with the gate
  NAMED in the body - `"Read replicas require a minimum size of small"`.
  After a `ci_small` upgrade the refusal changes shape: `406 "Failed to
  check for latest completed physical backup"` - a fresh project has no
  completed physical backup to seed a replica from (same mechanism that
  blocks a fresh project as a clone source). So the S07 `400` is infra
  prerequisites (compute floor, then physical-backup existence), NOT the
  entitlement flag. The addons endpoint also answers `429 "still processing
  addon changes"` right after a compute change - the PITR rung now retries
  with backoff.
- S14 (exchange probe, S14c rewritten): three findings on the way to the
  measurement. (1) The api-keys create response REDACTS `api_key` (masked
  with U+00B7 dots) unless `?reveal=true` is passed. (2) A fresh RPC 404s
  (`PGRST202`) until PostgREST's schema cache reloads - `notify pgrst,
  'reload schema'` plus retry. (3) The measurement itself: **the
  `secret_jwt_template` claims DO reach the exchanged token** - a
  `jwt_probe()` RPC returning `auth.jwt()`, called with the minted
  `sb_secret_` key as bearer, reports `role=authenticated` and
  `tenant_id=probe-tenant` exactly as templated (Pro org). `key_hash` is now
  a real sha256 (the old `hash_not_implemented` stub is gone). Platform-arm
  confirmation pending.

## 2026-08-25 - platform arm: S07 + S08 + S14 (non-default control plane via SUPABASE_MGMT_BASE_URL / SUPABASE_API_HOST_SUFFIX env)

Raw artifacts kept off-repo (internal control plane); statuses and findings
recorded here.

- S07: baseline setup `400 "Read replicas require a minimum size of small"` -
  IDENTICAL to the Pro-org message, which retroactively explains the
  2026-08-24 reading: the nano-default project sits below the replica compute
  floor, so the 400 was the floor speaking, not the entitlement. After
  `ci_small`: `400 "A completed backup needs to be done following either a
  point in time recovery, change in compute size, or database upgrade. It is
  currently in progress"` - the physical-backup prerequisite, in progress
  after the resize. S07e surfaced a real entitlement boundary: PITR enable is
  refused with `400 "Organization is not entitled to the selected PITR
  duration"` (consistent with S06's `PITR: off`).
- S08: grow CONFIRMED LANDED - `201` async accept, size after poll = 8GB.
- S14: **claims reach the exchanged token on the platform org too** -
  `data_plane_status: 200`, `role_bound: 1`, `tenant_claim_present: 1`.
  Same result as the Pro arm; `secret_jwt_template` binding is now measured
  end-to-end on both org classes.

## 2026-08-25 - full A/B battery (platform arm vs Pro control arm)

Control-arm artifact + status diff: `out/2026-08-25/ab-control-run.json` +
`out/2026-08-25/AB-DIFF.tsv` (raw run dirs stay local under `evidence/`). Platform-arm raw artifacts kept
off-repo (internal control plane); every platform reading matched the
2026-08-24 battery.

Deltas the diff surfaced:

- **S07e closed the replica gate chain on Pro**: after `pitr_7` (physical
  backups), setup is ACCEPTED (`204`). Replica prerequisites are exactly the
  compute floor + physical backups. On the platform arm the same rung is the
  PITR entitlement refusal.
- **S15 JIT database access is a real platform differentiator**: invite `200`
  with an `invite_id` on the platform org; the identical invite on Pro is
  REJECTED - and with a `500`, not a clean 4xx.
- **S11 backup schedule 402s on BOTH org classes** (`entitlement_required`,
  `error.feature=backup.schedule`) - consistent with the OpenAPI spec's 402
  description ("requires the Enterprise organization plan").
- S06c/S06d: pause enforced platform-side (INACTIVE -> restore -> healthy);
  Pro answers `400 "Project is not free-tier"`. S01a: control default create
  is micro (126 s provision), no nano anywhere in its catalogue.

<!-- Append new runs below: date, org class, module ids, artifact path. -->

## 2026-09-03 - Pro AND Team orgs, restore surface: S03 + S11 per org, plus a curl replay

Prompted by a customer report of three refusals on the backups routes. S03 and
S11 ran through `.pi/probe-sfp-platforms.sh` on the Pro org and again on the
Team org (four artifacts under `evidence/20260903-restore-gate/{pro,team}/`,
all four PROBE PASS; S03b `restore_point_status=400`, S11b
`schedule_status=402` on both). The wider route matrix below is a curl replay
against an existing Pro-org project and a fresh Pro-org project created and
deleted for the run. Same PAT (owner role) throughout.

- All four restore-family routes answer the SAME `400 {"message":"This endpoint
  is unavailable at the moment"}` once the body passes schema validation:
  `POST backups/restore` (`{id}`), `POST backups/restore-point` (`{name}`),
  `GET backups/restore-point`, `POST backups/undo` (`{name}`). Identical on the
  existing project and the fresh one. With S03 on Pro and Team today and on the
  platform-plan org on 2026-08-24, that is three org classes with the same 400.
- The gate fires AFTER validation and BEFORE any lookup: an empty body gets
  `400 "Invalid input: expected object, received undefined"`, a wrong field gets
  `400 "id: Invalid input: expected number"`, a 21-char name gets `400 "name: Too
  big"`, and a bogus `{id:999999}` on a project whose only backup has a different
  id still gets "unavailable" rather than a not-found. A customer who sees
  "unavailable" therefore sent a well-formed request.
- The message is specific to this gate. An unknown path answers
  `404 "Cannot GET ..."`, and `POST backups/restore-pitr` with a valid body on a
  non-PITR project answers `400 "PITR is not enabled for this project."`.
- All eight backups operations are in the published OpenAPI document,
  `POST backups/restore` (`v1-restore-physical-backup`, body `{id: integer}`)
  and `GET backups/restore-point` (`v1-get-restore-point`, returns
  `{name, status: AVAILABLE|PENDING|REMOVED|FAILED, completed_on}`) included.
  Neither documents a 400 or a 402; only the two `schedule` operations
  document 402.
- The entitlements list (`GET /organizations/{slug}/entitlements`) carries NO
  restore-point key on the Pro, Team or Free lab orgs (64 features; the
  backup-family keys are `backup.retention_days`, `backup.restore_to_new_project`,
  `backup.schedule`, `pitr.available_variants`, `project_restore_after_expiry`).
  Restore-point access is not readable from that endpoint; the 400 above is
  the only signal. `backup.schedule` is `hasAccess: false` on Pro AND Team, and
  `GET`/`PATCH backups/schedule` both 402 with `feature: backup.schedule`,
  consistent with S11.
- A fresh project reported `ACTIVE_HEALTHY` on the first poll (10 s) and already
  listed one COMPLETED physical backup.
