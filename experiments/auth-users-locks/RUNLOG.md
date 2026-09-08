# auth-users-locks - RUNLOG

One project, no AWS. Lock contention on auth.users, the shape behind the
"a migration on auth.users took Auth down" class of outage and the
customer-side "my foreign key blocked every sign-in" one. Each module measures
the actual lock mode a statement took (read from pg_locks in the same
transaction) and, where the claim is about a blocked write, holds the lock open
on one connection and proves a second connection's sign-in-shaped UPDATE either
blocks or does not.

auth.users DDL is platform-restricted, so nothing here modifies the auth
schema. The foreign key lives on a public table that REFERENCES auth.users
(the customer scenario), and the migration-shaped ACCESS EXCLUSIVE change in
AL03 is modelled on a public table - the lock arithmetic is identical, the
table is one the probe is allowed to alter.

Everything runs through the SESSION pooler (port 5432): the modules hold a
transaction open, which transaction mode would break by moving the backend
between statements. A `lock_timeout` is set on every blocking probe on purpose,
so a real block surfaces as `55P03 lock_not_available` in seconds rather than
hanging the run - the opposite of a real GoTrue migration, which runs with no
lock_timeout and waits forever.

## Modules

| id   | mode        | question |
| ---- | ----------- | -------- |
| AL01 | destructive | The lock a foreign key to auth.users takes (docs: SHARE ROW EXCLUSIVE on the referenced table), and whether a sign-in-shaped UPDATE on auth.users is blocked while the ADD CONSTRAINT holds it. AL01c signs in for real as the observable. |
| AL02 | destructive | NOT VALID + VALIDATE: the lock VALIDATE takes on auth.users (docs: ROW SHARE, weaker than SHARE ROW EXCLUSIVE), and that a sign-in-shaped UPDATE SUCCEEDS while VALIDATE holds it - the mirror of AL01b. |
| AL03 | destructive | An idle-in-transaction reader holding ACCESS SHARE blocks an ACCESS EXCLUSIVE ADD COLUMN, and the same change succeeds once the reader commits (control). |

## Run it

```
make apply           # provision the throwaway project
make probe           # AL01,AL02,AL03 through the session pooler
make destroy         # tear the project down
```

Needs `make secrets-decrypt` at the repo root first (PAT + db password). The
probe target derives the pooler host from the region output and fetches the
anon + service_role keys at run time.

## Validated 2026-09-08 (micro on Pro + Team orgs, and a Free-org project)

Ran AL01-AL03 through the session pooler on one throwaway project in each of a
Free, a Pro and a Team org (all ap-southeast-1), then destroyed all three. 9
pass / 0 fail per tier; every lock mode identical across the three, as expected
for a Postgres-level property. Evidence held locally (refs redacted by not
committing it).

| Row | Result, identical on Free / Pro / Team |
|---|---|
| AL01a | FK add to auth.users holds `ShareRowExclusiveLock` (plus AccessShare + RowShare) on auth.users - matches the docs. |
| AL01b | a sign-in-shaped `UPDATE auth.users` on a second connection blocked with `55P03 canceling statement due to lock timeout` while the ADD CONSTRAINT held the lock. |
| AL01c | the real password sign-in (`POST /auth/v1/token`) hung until the 15s client timeout while the lock was held - the observable a customer sees as "sign-in frozen". |
| AL02a | `ADD CONSTRAINT ... NOT VALID` held `AccessShareLock, ShareRowExclusiveLock` briefly (no scan). |
| AL02b | `VALIDATE CONSTRAINT` held only `AccessShareLock, RowShareLock` on auth.users - NOT ShareRowExclusive, matching the docs. |
| AL02c | the sign-in-shaped `UPDATE auth.users` SUCCEEDED through VALIDATE's lock - the workaround the FK-add path lacks. |
| AL03a | an idle-in-transaction reader holding `AccessShareLock` blocked an `ADD COLUMN` (`55P03`). |
| AL03b | the same `ADD COLUMN` succeeded once the reader committed (control). |

Takeaway: adding a foreign key to auth.users blocks every sign-in for the scan;
NOT VALID + VALIDATE does not; and an abandoned transaction is enough to wedge a
migration-shaped change. Tier-independent.
