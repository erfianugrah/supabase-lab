# RUNLOG - platform-facts

One project, no AWS. This experiment does not test a behaviour; it harvests
the platform constants that published docs quote as bare numbers, so that
"is this still true?" is a command rather than a re-read.

The docs it serves quote compute prices, per-tier connection counts, RAM
figures, plan entitlements, key shapes and the default Postgres major - and
between them carry one measurement date, several undated numbers, and one
guide with no date anywhere in 597 lines. Those are the cheapest claims in
the corpus to re-measure and the most likely to rot.

Built to be re-run and DIFFED, not run once. Two runs of `make probe` and a
diff of the two `REPORT.md` files is the intended use.

## Preconditions that are not resources

`PVLAB_ORG_SLUGS` (via `make probe ORGS=slug-a,slug-b`). The supabase provider
has no organization resource and a plan change is a billing action, so the
orgs are supplied, not provisioned. Ideally one Pro and one Team: F01's value
is the rows that DIFFER between plans. With no slugs, F01 skips with a reason
and F02/F03 still run.

## What each test is for

| id | question | doc claim it dates |
|---|---|---|
| F01 | what does each plan grant | the Pro-vs-Team entitlements table |
| F02a | compute prices, RAM, connection counts | the per-hour compute rates and connection counts |
| F02b | does a new project carry both key shapes | the PGRST301 provisioning trap |
| F02c | signing key algorithms and statuses | "new projects sign with ES256, HS256 demoted" |
| F02d | does health report per service | the "poll this, not project status" advice |
| F02e | Postgres major on a new project | "the current platform default major" |
| F03 | is a PAT still unscoped | "there is no token-scoping surface to reach for" |

Most results are `info`, not `pass`: there is no correct value for a price or
an entitlement, so asserting one would manufacture a failure every time the
platform changed something legitimate. Three have a genuine right answer and
do assert - F02b (both key shapes present), F02d (per-service reporting), and
F03 (no scoping surface reachable, with a live-token control).

F03's control is the part worth not removing. 404 on every scope candidate
also describes a dead token, a wrong base URL, or an outage; without
`/organizations` and `/profile` returning 200 in the SAME run, the negative
result is uninterpretable, and the test reports `skip` rather than a
confident wrong `pass`.

## Runs

### 2026-08-04 - F04 only, no project provisioned

F04 reads the account, not a project, so it ran on `requires: ["pat"]` alone with
no `make apply` and no spend.

**F04a - there is no region catalogue endpoint.** `/regions`, `/platform/regions`
and `/projects/regions` all 404, while `/projects` and `/organizations` answered
200 in the same run. The control is what makes that mean something: without it,
three 404s equally describe a dead token or an outage.

So the set of creatable regions is documentation-only. `region` is accepted at
project creation, but nothing lets you enumerate what may legally be passed.
That matters for anyone building per-customer region placement: you can place a
project programmatically, you cannot discover where you are allowed to place it,
and a region added or withdrawn upstream is invisible to a caller until a create
fails.

**CORRECTION 2026-08-20 - the conclusion above is WRONG, and the error is
instructive.** residency-facts R01 found the real endpoint:
`GET /v1/projects/available-regions?organization_slug=<slug>` answers 200 with
`{ recommendations, all: { smartGroup[], specific[] } }` (17 specific regions +
3 smart groups on a Team org; a bare call without the org slug answers 400).
F04a's three probes were name-guessed paths, and all three 404 - the catalogue
sat on a differently-named path the whole time. This is exactly the failure
mode F05's read-the-whole-spec method exists to avoid, and F04 fell into it
two days before F05 was written down. The three original probes are kept in
the module as a historical record; F04c is the corrected measurement and
passes. The `recommendations` block is a bonus finding: it is the platform's
capacity pick per org (americas/us-west-2 observed from a Singapore vantage),
i.e. smart-group behaviour made visible.

**F04b - 2 distinct regions across 4 projects** on this account (aggregate only;
refs deliberately not recorded).

### 2026-08-04 - F05, also no project

**F05a - organization membership is read-only on the stable API.** Enumerated
rather than probed: the published OpenAPI document lists 169 operations, of
which exactly ONE touches membership (`GET /v1/organizations/{slug}/members`).
The only two org-scoped writes are `POST /v1/organizations` and the
project-claim callback. No create, no update, no delete, no invitation
endpoint, no roles endpoint.

The method matters more than the number. Probing four plausible paths and
finding 404s would have been the same mistake a previous investigation made on
a different question - it concluded an API could not do something after
searching only the paths named after the thing, and the lever turned out to
live on a differently-named path. So F05 reads the whole document. The absence
is stated across all 169 operations or not at all. The parse count doubles as
the control: a document that half-arrived would make the absence an artifact.

**The near-miss worth recording.** A keyword search for "invite" DOES return
endpoints - `POST /v1/projects/{ref}/database/jit/invite` and friends. They
grant temporary DATABASE access, not organization seats. Anyone grepping the
spec for membership provisioning will find them, and reading them as
membership would produce a confidently wrong claim.

This agrees with the conclusion a sibling gateway project reached from the
inside, by watching its own proxy refuse those writes. Two routes, same answer;
the enumeration is the stronger of the two because it does not depend on that
proxy's routing table being complete.

**F05b - the documented read answers** (200, against a 200 control), so the
absence above is of writes specifically, not of the whole surface.

Both branches were exercised before the negative was trusted: widening the
member filter so the two org writes match flips the detail to "the read-only
finding has changed", and raising the control threshold above the real
operation count produces the intended `fail` rather than a quiet pass.

### 2026-08-04 - F06, the upgrade window, and why it was not measured

The intent was to add the upgrade to the downtime matrix. In-place major
upgrades are widely described as costing HOURS, and that is unquantified in
exactly the way the restart number was before it was measured. The instrument
already existed - the sampler, the five probes and the verdict logic are all
committed - so it should have been one more module with a different operation
closure.

**It cannot be done on a throwaway project.** A freshly created project comes up
already at the latest app version: `eligible: false`, current == latest,
`target_upgrade_versions: []`, `duration_estimate_hours: 0`. There is nothing to
upgrade to.

**And the conditions cannot be arranged.** `postgres_engine` and
`release_channel` on `POST /v1/projects` are BOTH deprecated and typed `null` in
the published schema, so a created project takes the current default and there
is no way to ask for an older one. Measuring a real client-visible upgrade
window therefore requires a project that has aged past the current version -
which means being willing to upgrade something real. That is the structural
reason this number stays folklore, and it is worth stating plainly rather than
leaving the gap looking like laziness.

**What IS readable, for free: the platform's own estimate.** The eligibility
payload carries `duration_estimate_hours`. Across the aged projects on this
account, three were eligible for `17.6.1.141 -> 17.6.1.155` and each reported
`duration_estimate_hours: 1`, with one target and zero validation errors. So the
platform itself budgets an hour for a PATCH-level app upgrade on small projects.

Two caveats on that number, and they matter:

- It is a published ESTIMATE, not a measured outage. platform-downtime showed
  those are different things - an operation's duration and its client-visible
  window differ per connection path, sometimes by 2x, and REST stayed up through
  every operation measured there.
- All three eligible projects returned exactly `1`, which reads like a coarse
  or rounded figure rather than a per-project computation.

One project returned `eligible: null` with no version fields at all - a state
where eligibility is not computable. Not investigated; noted so the next reader
does not treat the field as always-boolean.

`POST /v1/projects/{ref}/upgrade` exists and F06 deliberately never calls it.
The only projects on which it would do anything are real ones.

**Diff mode, first real exercise.** Two F04 runs 11 seconds apart, then
`make diff` with `SUPABASE_ACCESS_TOKEN` explicitly unset: `no change across 12
measurements`. Diffing the two rendered reports instead gives 8 lines, all of
them timestamps - which is the whole argument for comparing at the measurement
level rather than by eye.

## Cost / teardown

One Micro project, minutes. `make destroy`. Re-provisioning per run is
deliberate: a long-lived project would accumulate state and stop answering
"what does a NEW project look like", which is what F02b, F02c and F02e are
actually asking.
