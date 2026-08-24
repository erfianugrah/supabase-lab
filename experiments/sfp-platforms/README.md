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

## Measured (org under test, live run)

Every figure below comes from our own throwaway-project runs on the org under
test.

The `platform` plan is an entitlements tier, DECOUPLED from the "contact us"
feature gates (migrations / restore-points / scale-to-zero) and from the OAuth
BYO-backend bridge. On this org:

| surface | result |
|---|---|
| plan | `platform` |
| compute catalogue | 10 sizes, floor `ci_micro`, ceiling `ci_16xlarge`; `ci_nano` ABSENT |
| project_pausing | ENFORCED (pause 200 -> INACTIVE; normal paid org = 400) |
| project_cloning | DECLARED but no Management API endpoint (404) |
| migrations endpoint | 200, transactional rollback verified, recorded in supabase_migrations |
| restore points | 400 (not enabled on this org) |
| OAuth project-claim / apps / transfer | 404 / 404 / 404 (BYO bridge not enabled) |
| scale-to-zero / nano | absent (not in entitlements, not in catalogue) |
| realtime ceiling / branching / functions | 10000 concurrent / unlimited / unlimited |
| audit_logs_days / PITR / private_link / HA | 366 / off / off / off |

## Running

```
SUPABASE_ACCESS_TOKEN=<org PAT> \
SUPABASE_MGMT_BASE_URL=<control-plane base> \
PVLAB_ORG_SLUGS=<org slug> \
.pi/probe-sfp-platforms.sh S01
```
