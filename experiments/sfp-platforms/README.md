# sfp-platforms

What a Supabase for Platforms (SfP) org unlocks, measured empirically against
the entitlement surfaces the public guide marks as gated. Self-provisioning:
each module creates its own throwaway project on the org under test and
deletes it in `finally`. No OpenTofu state.

The org under test is supplied at run time (`PVLAB_ORG_SLUGS`), so the same
module answers both "an SfP org" and "a control org" depending on which slug
is passed - that is how the entitlement delta is read. A measured 4xx on a
gated surface is data (info), never a failure.

Sibling context: `instance-sizing` (I01) measured that a normal paid org
rejects Nano; this experiment measures the entitled counterpart.

## Modules

| id | claim |
|---|---|
| S01a | SfP-path create (no `desired_instance_size`) comes up healthy; what compute does it actually land on |
| S01b | database migrations endpoint applies a schema change |
| S01c | restore point is accepted |
| S01d | undo-to-restore-point reverts a post-point schema change |
| S03 | restore points + undo semantics (entitled path) |
| S04 | migrations endpoint transactional semantics (rollback + bookkeeping) |
| S05 | project claim/transfer surface (BYO-backend bridge) |
| S06 | platform-plan entitlements snapshot + pausing enforcement |
| S07 | read replicas (setup/remove; Beta surface) |
| S08 | disk modification (config/disk GET + async grow) |
| S09 | read-only mode (status + 15-min temporary-disable override) |
| S10 | organization members (populated listing) |
| S11 | backup schedule (entitlement_required boundary) |
| S12 | migration versioning (create returns []; version is a timestamp) |
| S13 | branch lifecycle (create/list/delete) |
| S14 | secret_jwt_template on API keys (accepted + echoed; key is opaque) |
| S15 | JIT database access invitations (invite/delete) |

## Measured (org under test, live run)

Every figure below comes from our own throwaway-project runs on the org under
test.

The `platform` plan is an entitlements tier, DECOUPLED from the "contact us"
feature gates (migrations / restore-points / scale-to-zero) and from the OAuth
BYO-backend bridge. On this org:

| surface | result |
|---|---|
| plan | `platform` |
| compute catalogue (purchasable addons) | 18 variants, floor `ci_micro`, ceiling `ci_48xlarge_high_memory`; `ci_nano` not listed because nano is the default, not an upgrade |
| compute update path (resize) | 10 sizes, `ci_micro`..`ci_16xlarge` (no nano - you cannot resize TO nano) |
| project_pausing | ENFORCED (pause 200 -> INACTIVE; normal paid org = 400) |
| project_cloning | DECLARED but no Management API endpoint (404) |
| migrations endpoint | 200, transactional rollback verified, recorded in supabase_migrations |
| restore points | 400 (not enabled on this org) |
| OAuth project-claim / apps / transfer | 404 / 404 / 404 (BYO bridge not enabled) |
| scale-to-zero / nano | **DEFAULT create tier**: SfP-path create (no `desired_instance_size`) provisions `infra_compute_size: nano` (224MB shared_buffers, vs 256MB on the paid micro default); pausable. Nano is NOT in any catalogue because it is the default, not a purchasable variant |
| realtime ceiling / branching / functions | 10000 concurrent / unlimited / unlimited |
| audit_logs_days / PITR / private_link / HA | 366 / off / off / off |
| read replicas | setup 400 despite `instances.read_replicas:true` (entitlement is not the endpoint gate) |
| disk | gp3 2GB / 3000 IOPS / 125 MiB/s base; async grow (`201` empty, reflects ~15s); gp3 IOPS floor 3000 + max `min(500x size,16000)` makes a 2->4GB grow impossible |
| read-only mode | `enabled:false, override_enabled:false`; temporary-disable `201` |
| members | full member objects (Owner), not a read-only stub |
| backup schedule | `402` structured `entitlement_required` error with `error.feature=backup.schedule` |
| migration version | create returns `[]`; version is `YYYYMMDDHHMMSS` in `supabase_migrations.schema_migrations`; GET/PATCH by that version `200` |
| branches | create `201` (returns a UUID `id`); delete is the top-level `DELETE /v1/branches/{id}` (`200`), not `/projects/{ref}/branches/{name}` (`404`) |
| secret_jwt_template | accepted + echoed (`201`); minted key is opaque (`sb_secret_...`, not a JWT) |
| JIT database access | invite `200` (returns `invite_id`), delete `200` - time-boxed network-restricted role-scoped grants |

## Running

```
SUPABASE_ACCESS_TOKEN=<org PAT> \
SUPABASE_MGMT_BASE_URL=<control-plane base> \
PVLAB_ORG_SLUGS=<org slug> \
.pi/probe-sfp-platforms.sh S01
```
