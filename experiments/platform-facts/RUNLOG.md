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

**F04b - 2 distinct regions across 4 projects** on this account (aggregate only;
refs deliberately not recorded).

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
