# tenant-consolidation - run log

Three throwaway projects in one org: two sources that each played
project-per-customer, one target that plays the consolidated multi-tenant
project. No AWS, no runner - every question here is about what the auth tier
and the SQL surface accept over the public API.

The corpus already covers the other direction (shared -> dedicated, one tenant
promoted out, in the shared-tenancy guide). Merging is not that runbook read
backwards. Splitting one project can never produce a collision; merging two
projects that were provisioned independently produces one for every namespace
they both allocated from - addresses, surrogate keys, sequences.

`fail` here means the platform did the unsafe thing, not that the harness
broke. One result is a `fail` and it is the most useful line in the run.

## Run 2026-08-04, 3 projects, ap-southeast-1, micro

33 pass, 1 fail, 0 skip. Evidence in `evidence/` (gitignored - it carries
project refs).

### Moving the users

- **auth.users copies many-to-one, over 34 non-generated columns.** Enumerating
  columns from both catalogs and landing them with `json_populate_recordset` -
  the shape the promotion runbook prescribes - works unchanged in the merge
  direction. 3/3 rows.
- **The uuid survives, so `user_id` columns in the customer's data keep
  resolving.** This is the difference between a migration and a
  re-registration, and it holds on both paths tested here.
- **The password survives.** `encrypted_password` travels with the row and the
  moved user logs in at the target with the password they already had. No
  reset email, no forced rotation.
- **`auth.identities` was not needed.** Login worked with 0 identity rows on
  the target for the copied users. The four-table copy in the promotion runbook
  is about porting a live SESSION; a consolidation that accepts a re-login does
  not need it.
- **The copy is not a cut.** The source still authenticates the same user
  afterwards, so a consolidation can be abandoned after the first customer.
- **The tenant claim has to be added during the move.** Source rows have no
  `tenant_id` at all - the project WAS the tenant - so there is a step here
  with no counterpart in the promotion direction. Stamping
  `raw_app_meta_data` on the copied rows put it in the issued token.

### The collision that has no analogue in the other direction

- **The uniqueness is `users_email_partial_key`: `UNIQUE (email) WHERE
  (is_sso_user = false)`.** A btree over the raw column.
- **One shared address costs the whole customer, not the row.** A single INSERT
  is atomic, so the second source contributed **0 of its 2** users when one of
  them collided. A merge written the obvious way loses a customer's entire user
  base to one duplicate.
- Excluding the conflict lets the rest through, at the price of that human
  being absent from the consolidated platform for that customer. Rewriting the
  address admits the row and the original password still works, but the string
  the human types has changed, which is a product decision.
- **The index is case-SENSITIVE, and that is the finding (C02g).** A copy of the
  same address in a different case is ACCEPTED: two `auth.users` rows for one
  human, differing only by case, and no SQL merge notices. Signup normalises;
  a SQL copy does not.
- **Which of those two rows a login reaches is not stable (C02h).** Five
  attempts at each casing, all HTTP 200, both accounts reachable from BOTH
  input strings, and the mapping changed mid-sequence:

  ```
  lower -> f163,f163,f163,ae87,ae87
  upper -> ae87,ae87,f163,f163,f163
  ```

  So a merge that lands a case-variant duplicate does not produce a cosmetic
  double account. It produces a user whose session lands in one tenant or the
  other depending on the attempt, with a different `tenant_id` claim each way.
  Measured twice, same conclusion. This was worth repeating: the first two runs
  of this test disagreed with each other, and a single observation of either
  cannot tell "case-insensitive login" apart from "unstable".

### The supported path does the whole job

The auth-schema copy is unsanctioned. It turns out not to be necessary:

- `POST /auth/v1/admin/users` **accepts `password_hash`** and took the `$2a$`
  bcrypt string straight from the source (HTTP 200). The plaintext is never
  needed.
- It **honours a supplied `id`**, so uuids are preserved on the documented
  surface too.
- It sets `app_metadata` at creation, so the tenant claim needs no follow-up
  write.
- A duplicate address is refused with **422 `email_exists`**, and - unlike the
  raw index - **so is a case-variant of one**. The endpoint normalises. The
  documented path is immune to the trap C02g walks into silently.
- Control: created without password material, the same user cannot log in with
  the old password (400 `invalid_credentials`), so the password preservation
  above is attributable to `password_hash` and not to something else.

Consequence: consolidation does not need writes into the `auth` schema. It
needs admin-API creates carrying `id` + `password_hash` + `app_metadata`, and
an answer for the duplicate addresses.

### The data half

- Both sources allocated orders `{1,2,3}`, as project-per-customer guarantees.
- Keeping `id` as the primary key refuses the second customer: 23505 on
  `orders_naive_pkey`.
- `primary key (tenant_id, id)` admits both with **6 rows over 3 distinct
  ids** - each customer keeps 1..3, so order numbers already printed on
  invoices still resolve.
- Control: uuid keys merge with no handling at all, which is what makes the
  above a property of key ALLOCATION rather than of merging.
- **The first write AFTER the merge collides** (23505 on `orders_scoped_pkey`):
  the merged table's own sequence starts at 1, which is a live id for every
  tenant that came in. `setval` past the highest migrated id fixes it. This
  fails on the first real write, not during the migration.

### The isolation the consolidated project now rests on

Before consolidation, isolation was an instance boundary. Afterwards it is a
predicate on a claim.

- RLS enabled with no policy returns 0 rows to a tenant, HTTP 200. Correct
  failure, and the one that reads as "the application went blank".
- **The management query endpoint connects as `postgres` and saw all 3 rows
  while the tenant saw 0.** "I checked and the data is there" and "isolation
  works" are answers to different questions.
- With the policy: tenant A reads 2 of 3, tenant B filtering explicitly for
  A's rows gets `[]`.
- **A FOR ALL policy with only `using` governs writes too.** The forged insert
  was refused and left 0 rows - Postgres reuses the USING expression as the
  check when no WITH CHECK is given. The usual advice ("using is reads, with
  check is writes, omit it and writes are open") is wrong for this policy
  shape.
- **The write hole that does exist is `with check (true)`**: tenant B's row
  attributed to tenant A landed (201, 1 row) while every read test kept
  passing.
- **PostgREST's default `return=representation` reports that allowed write as
  403 42501**, because RETURNING is filtered by the SELECT policy and the
  statement rolls back. So an RLS write test written against PostgREST defaults
  reports the hole as closed. Ask for `return=minimal` and count rows
  server-side.
- **A table nobody enabled RLS on is readable by every tenant** - tenant B read
  2 of 2 rows from one. "On every table" is the load-bearing phrase in the
  advice. The run also reports how many `public` tables still have
  `relrowsecurity = false`; that query belongs in a pre-cutover check.

## Harness lessons from this run

Three verdicts flipped between runs before the numbers above were stable, and
all three were the same mistake: a test that left state behind and then
measured its own artefact.

1. The cleanup used `email like 'c02-%'`, which is case-sensitive, so it missed
   the upper-case row its own case-variant test had inserted. The next run's
   insert collided with that leftover, returned a perfectly real 23505, and the
   test concluded "the constraint is case-insensitive" - the opposite of the
   truth, from the right error code. Assertions now check the resulting row
   COUNT, not just the status.
2. `truncate` without `restart identity` left the sources seeding ids `{4,5,6}`
   on the second run. The collision still reproduced, but the assertion that
   explains WHY it collides did not.
3. `create sequence if not exists` survived the table being recreated, so by
   run three nextval was already past the migrated ids and the
   sequence-collision test silently stopped reproducing - it reported a pass
   for the write succeeding.

Generalisation for anything in this repo that provokes a uniqueness failure:
the cleanup must cover every value the test can WRITE, not every value it
reads, and the assertion must distinguish "collided with the other source"
from "collided with my own leftover".
