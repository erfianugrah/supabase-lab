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

## 2026-08-17 - I02 green: smart region selection works on a normal paid org

Run artifact: `evidence/run-2026-08-17T22-53-13-608Z.{json,md}` (local).

`region_selection: { type: "smartGroup", code: "apac" }` on POST /v1/projects
is accepted on the Pro org: HTTP 201, the platform picked `ap-northeast-2`,
healthy in 135s. So the capacity-driven placement knob is not SfP-gated - a
platform on a normal paid org can defer the city choice to the platform
instead of pinning a concrete region per tenant.

## 2026-08-18 - I03: legacy free-era project lifecycle on a Pro org

Subject: a pre-existing project created while the org was on the free plan,
found INACTIVE (paused) in the now-Pro org. Run artifact:
`evidence/run-2026-08-18T00-19-19-226Z.{json,md}` (local).

| Probe | Result | Read |
|---|---|---|
| I03-control | initial_status INACTIVE | a legacy paused project keeps its paused state after the org upgrade |
| I03a: restore | HTTP 200 accepted, but NOT ACTIVE_HEALTHY within the 20-min bound (wake_s = -1) | the legacy wake is slow; the project did reach ACTIVE_HEALTHY later (observed ~30 min after the restore call). Compute while healthy: no selected addon |
| I03b: pause | not attempted by the module (project not healthy in-bound) | attempted directly afterwards: HTTP 400, verbatim below |

The pause attempt, verbatim:

```
POST /v1/projects/{ref}/pause
400 {"message":"Project is not free-tier. Please downgrade it to free-tier first and try again."}
```

Read: pause eligibility follows the org's CURRENT plan, not the project's
creation lineage. A legacy paused project is a one-way door: once woken it
cannot be re-paused and joins the always-on compute floor. For a platform
carrying dormant tenants, "wake on demand" for a legacy/free-era project
permanently changes its cost basis.

## 2026-08-24/25 addendum - I01's "Nano absent" reading scoped by sfp-platforms

I01 stands for Pro orgs, but its "Nano absent" generalization measured the
addon/upgrade catalogue, not the create default. On a `platform`-plan org the
SfP-prescribed create (no `desired_instance_size`) provisions
`infra_compute_size: nano` (224 MB shared_buffers) and the project can pause -
nano is the platform plan's create default, absent from every catalogue
because it is not a purchasable or resize target on any plan. See
`experiments/sfp-platforms/` (S01, RUNLOG 2026-08-24/25).
