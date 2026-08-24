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

## Running

```
SUPABASE_ACCESS_TOKEN=<org PAT> \
SUPABASE_MGMT_BASE_URL=<control-plane base> \
PVLAB_ORG_SLUGS=<org slug> \
.pi/probe-sfp-platforms.sh S01
```
