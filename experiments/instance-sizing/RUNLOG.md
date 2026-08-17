# instance-sizing RUNLOG

One question: is the Nano compute tier reachable on a normal paid (Pro) org?
The public Supabase-for-Platforms guide describes scale-to-zero pricing as
Nano-only and gated, and says not to pass `desired_instance_size` on creation -
but never says what a normal paid org's API surface does with Nano. This
experiment measures that surface instead of quoting the docs.

No tofu state: I01 provisions and deletes its own projects (the W21 pattern),
so there is no `make up` and no drill pair. Run it with:

```
.pi/probe-instance-sizing.sh I01
```

## 2026-08-17 - I01 green: Nano is unreachable three different ways on a Pro org

Run artifact: `evidence/run-2026-08-17T11-10-14-202Z.{json,md}` (local;
evidence/ is gitignored). Reproduced earlier the same day at 10:28 with
identical statuses.

| Probe | Result | Evidence (verbatim) |
|---|---|---|
| I01a control: create with no `desired_instance_size` | pass - healthy in 134s, compute `none(micro)` (no selected addon = micro default) | `ci_nano_available: 0` - `ci_nano` is NOT in the project's `available_addons` entitlement list |
| I01b: create with `desired_instance_size: "nano"` | HTTP 400 | `{"message":"Minimum instance size on paid plans is Micro"}` |
| I01c: PATCH billing/addons `ci_nano` on the control project | HTTP 400 | `{"message":"addon_variant: Invalid input"}` |

Read: on a normal paid org, Nano is rejected at project creation AND at the
addon mutation, and the variant is absent from the entitlement catalogue the
GET returns - the gating is enforced at all three layers, not just documented.
The floor on a paid org really is Micro ($10/mo class, always-on; paid projects
cannot be paused), which is the number the tenant-placement cost model stands
on. Scale-to-zero economics require whatever gated arrangement makes Nano
available; none of these three doors opens without it.
