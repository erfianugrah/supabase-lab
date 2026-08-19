# rls-policy-cost RUNLOG

Question set: does `(select auth.uid())` hoist, what does an index do to that
win, and what actually happens with a joined table inside an EXISTS policy.
Synthetic fixtures only (100k items / 2k threads / 300 posts,
two fake user UUIDs); nothing customer- or account-specific.

Environment: one `supabase_project` (micro, ap-southeast-1), PG 17.6,
proven via `make up` (init -> plan -> apply -> wait-ready -> test).
Executed through the Supavisor SESSION pooler (port 5432): the matrix relies
on `SET ROLE` + `request.jwt.claims`, which are session-scoped and would not
survive transaction-mode (6543). Timings are single-sample on a micro; plan
shapes are the durable findings, numbers are directional.

Lifecycle gate notes hit during the first run: `make up` hung in wait-ready
because REF resolution emitted tofu's "no outputs" warning into the REF var
while outputs were not yet materialised; ran `make test` manually after the
project reached ACTIVE_HEALTHY. Also: the decrypted `secrets.tfvars` carried
an UNCOMMENTED placeholder `supabase_access_token` line on line 1, which makes
plan/apply fail with "Mismatch between input and plan variable value" - the
root AGENTS.md convention (comment the placeholder out locally) was
re-applied and this file's plan/apply then succeeded. If sibling experiments
start failing the same way, check line 1 of the decrypted copy.

## Results (evidence/20260819-130847/rls-cost.out)

A. Bare vs wrapped, UNINDEXED (100k rows, subject owns 90k):

- bare `auth.uid()`: 252.9ms, Seq Scan, per-row Filter
- `(select auth.uid())`: 22.2ms, Seq Scan with `Filter: (owner = (InitPlan 1).col1)`
- call counts (PL/pgSQL `f_uid()` + sequence): bare 100,001 calls vs wrapped 1
- row digests identical both directions (count 90000, sum 4500010000) - the
  wrap is access-control-neutral; only plan shape changes

B. After `create index items_owner_idx`:

- bare: Bitmap Heap Scan (no Index Only - fresh table, no VACUUM), 24.1ms
- wrapped: Bitmap Heap Scan, 24.2ms
- call counts: bare 2 vs wrapped 1 - the index already removes the per-row
  evaluation; the wrap's remaining gain is noise-level

C. EXISTS policy (`posts.topic` -> `threads.topic`,
`threads` itself RLS-protected by the wrapped form):

- planner DECORRELATED the EXISTS into a hashed subplan (loops=1) even at
  300x2000 scale; the joined table's own RLS appears as `InitPlan 3` inside
  the subplan - recursive RLS confirmed structurally
- visibility matrix: caller with threads sees 180 entries, second caller 120,
  caller with no threads 0, anon 0 (SELECT granted but no anon policy)
- call counts inside EXISTS: bare 2,003 (per subplan-scanned threads row)
  vs wrapped 1 - the wrap hoists INSIDE the EXISTS too, into the subplan's
  InitPlan
- with `create index threads_user_idx`: subplan build becomes an indexed scan (Bitmap on micro at this scale) with
  `Index Cond: (user_id = (InitPlan 3).col1)`, narrowing the hashed build to
  the caller's rows

D. Client-side filter under `owner = auth.uid() OR tag = 'public'` (B owns
250 public rows): A unfiltered 90,250; A filtered `owner = B` returns exactly
B's 250 public rows - never more; `owner = B AND tag = 'private'` returns 0.
Client drift hides rows; it cannot reveal them.

E. Grant target: the identical predicate `tag = 'public'` as `TO public` lets
anon read 5,250 rows; as `TO authenticated` anon reads 0. Predicate alone
does not decide; the grant target does.

## What this does not settle (state explicitly)

- The hashed-subplan form is a PLAN choice. At other sizes/statistics the
  same EXISTS may come out as a correlated SubPlan evaluated per outer row;
  there the bare form is per-message-row and the wrap's win shape may differ.
  The matrix proves mechanism (recursion, hoisting, grant semantics), not a
  universal timing law.
- Realtime per-subscriber authorization is a public-docs statement
  (/docs/supabase/guides/realtime/postgres-changes.md, "authorizes every
  event against each subscriber"); it is NOT exercised by this matrix, which
  is read-path only.
