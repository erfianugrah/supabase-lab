# stripe-sync-schema

Does the Stripe Sync Engine integration's projected Postgres schema stay in
agreement with the Stripe API version its data actually arrives at?

Short answer: no. A controlled version toggle proves it for one field; how
many other fields are affected is still open, and nothing surfaces any of it.

## Status

Scaffolded, not yet run against its own project. The mechanism is settled (see
"The FDW is the control"); the SCOPE is not. `make seed` is a stub - the
fixture matrix below is the next piece of work. Everything in **Prior
observation** was measured on a pre-existing project and is what motivates the
experiment; it is not a result of this experiment and is not sufficient on its
own.

## The mechanism under test

The integration maintains two version-dependent things and reconciles neither.

**The schema** is projected from a Stripe OpenAPI spec. The pin is recorded in
`stripe._migrations` as `openapi:stripe:<date>:<hash>`.

**The data** arrives through a managed webhook that records
`api_version = null`, meaning it follows whatever version the Stripe *account*
currently defaults to.

An account's default version moves - Stripe rolls accounts forward, and a user
can change it. When it crosses a field relocation, a typed column silently
stops being populated and the value reappears under a key the projected schema
has no column for. It survives only inside `_raw_data`. There is no error, no
log line, and no advisory: a query that returned dates yesterday returns NULL
today.

## Prior observation (a different project, not this experiment)

Measured 2026-08-07 on a project where the integration had been installed 18
days earlier, plus a throwaway branch installed the same day as a control.

- Both installs recorded the **same** spec pin, byte-identical hash, dated
  **2020-08-27**. A fresh install does not get a newer projection.
- Both had a typed `subscriptions.current_period_end` column and **no** period
  column on `subscription_items`.
- On the fresh install, backfilled that day: 13 active subscriptions, **0**
  with `current_period_end` populated, and **13 of 13** carrying the value at
  `subscription_items._raw_data ->> 'current_period_end'`.
- Stripe's `2025-03-31.basil` release moved `current_period_start` / `_end`
  from the Subscription object to the Subscription Item.
  <https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end>

The older install had that column *populated* when it was first synced and
NULL two weeks later, with an unchanged schema pin - so the account's API
version crossed the relocation during that window, and a routine background
re-sync wrote NULL over rows that previously had values. Subscriptions in a
terminal state kept their values, because nothing re-synced them. That
accidental control is the clearest evidence that the data side moves
independently of the schema side.

A sampled column-vs-payload diff on the same project suggested the problem is
much wider than one field: roughly 40 typed columns never populated and 80
returned fields with no column, across 11 tables. The relational spine looked
worst - `invoices.subscription`, `invoices.charge`, `invoices.payment_intent`
and `charges.invoice` all unpopulated, while `invoices.parent` and
`payment_intents.latest_charge`, where modern Stripe puts those references,
had no column.

**Those numbers are not a finding yet.** They come from ~15 subscriptions and
17 customers in a single narrow state, and "absent from every sampled payload"
conflates three different things:

1. genuine version drift - the field moved or was removed
2. an expandable field that only materialises when a request expands it, which
   likely explains `customers.subscriptions`, `sources` and `tax_ids`
3. a field legitimately null for the few objects that happened to exist

Only (1) is a finding. Separating them is the entire reason this experiment
exists.

## The FDW is the control, and it changes the diagnosis

Measured 2026-08-07. The Stripe FDW (`wrappers` 0.6.2, `stripe_wrapper`) was
stood up on the SAME project, pointed at the SAME Stripe account, on the same
day. The prediction was that it would show the same drift, on the theory that
any schema pinned over a moving API rots the same way.

It does not. The FDW returns the renewal date on all 13 active subscriptions
while the Sync Engine's typed column is NULL on all 13, for the same
subscription ids.

One server option accounts for the entire difference:

| `api_version` on the FDW server | typed column | sub-level in payload | item-level in payload |
|---|---|---|---|
| `2025-03-31.basil` | 0 / 13 | 0 | 13 |
| unset (the FDW's own default) | 13 / 13 | 13 | - |

That is a one-variable controlled experiment, and it moves the finding off
inference entirely. Nothing about sampling, fixtures or object states is load
bearing for THIS claim: flip the version, the column empties; flip it back, the
column fills.

So the corrected diagnosis is narrower and more useful than "pinned schemas go
stale":

- The FDW pins **both** sides. It ships a schema and requests a matching API
  version, so its columns and its payloads agree by construction. It would
  break in exactly the same way if you pinned it forward past a relocation -
  the table above is that break, deliberately induced.
- The Sync Engine pins the **schema only**. The projection is frozen at a 2020
  spec while the managed webhook records `api_version = null` and therefore
  follows the account default, which moves on Stripe's schedule rather than
  yours.

The failure is not staleness. It is two version knobs that are supposed to move
together and are not connected to each other. That also names the fix, which
the earlier framing did not: pin the webhook's `api_version` to whatever spec
the projection was generated from, or advance the projection, but do not let
them float independently.

This does NOT retire the fixture matrix below. The version toggle proves the
mechanism for one field; it says nothing about how many other columns are
affected, which is still a counting problem and still needs controlled data.

## What this experiment adds

**A fixture matrix**, so absence is evidence. The observation project's Stripe
account contains one narrow slice of reality; seeding deliberately across
states makes "this column is never populated" mean something.

**A dedicated Stripe test account**, so the account's default API version can
be changed on purpose. Two runs either side of that change is the real
instrument: a column that changes bucket between runs is drift by
construction, with no inference about sampling required. Everything short of
that is a photograph of one side of a transition.

## Fixture matrix (what `make seed` must create)

Not yet implemented. Each row exists to make some column non-null that the
naive case leaves empty.

| Fixture | Why |
|---|---|
| subscription: trialing | `trial_start` / `trial_end` / `trial_settings` |
| subscription: past_due | dunning fields, `cancel_at_period_end` |
| subscription: canceled | `canceled_at`, `cancellation_details`, and a terminal row that never re-syncs |
| subscription: multi-item | more than one `subscription_items` row per subscription |
| subscription: metered / usage-based | `plan.meter`, usage records |
| subscription: with a discount | `discounts` on both subscription and item |
| subscription: scheduled | `subscription_schedules` |
| invoice: paid, open, void, uncollectible | `parent`, `payments`, tax totals |
| charge: refunded, disputed | `refunds`, `dispute`, `failure_balance_transaction` |
| payment_method: several types | the dozen per-type columns |
| customer: with tax IDs and multiple sources | tests the expandable-field hypothesis directly |

The expandable-field row matters most for honesty: if `customers.tax_ids`
stays empty even when tax IDs exist, it is an expansion artifact and belongs
in bucket (2), not in a bug report.

## Tests

| id | what |
|---|---|
| E01 | spec pin from `stripe._migrations`, plus the webhook's `api_version` |
| E02 | typed columns vs payload keys, split into `typed_never_seen` and `returned_untyped`, with tables under 5 rows reported as unconfirmed |
| E03 | for each unpopulated column, does the same field name appear in another table's payload - the candidate relocation map |

E03 is the actionable one: it turns two separate lists into
"`subscriptions.current_period_end` is dead AND the value is at
`subscription_items._raw_data`", which is the difference between a bug report
and a workaround. Its matches are hints, not proof - Stripe reuses field names
freely, so each still wants confirming against the changelog.

## Manual step

The install is Dashboard-only. Verified 2026-08-07 against CLI 2.111.0: no
`integrations` subcommand and none under `--experimental`; no matching route
string in the binary; the `supabase` Terraform provider exposes seven
resources and none is an integration; and the published Management API spec's
only `integration` routes are `config/auth/third-party-auth`. The Dashboard is
clearly calling something, but it is unpublished - wiring the harness to a
private endpoint would buy automation at the cost of a suite that breaks
silently when the endpoint moves. `make gate` therefore stops and prints
instructions instead.

## Running it

```sh
make apply                       # provision the project
make gate                        # prints the Dashboard step, then passes once installed
export STRIPE_SECRET_KEY=sk_test_...
make seed                        # NOT IMPLEMENTED YET
make probe                       # E01 E02 E03 -> evidence/<ts>/
# change the account's default API version in the Stripe Dashboard
make probe
make diff                        # the actual experiment
make destroy
```
