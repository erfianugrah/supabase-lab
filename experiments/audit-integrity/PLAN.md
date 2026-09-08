# experiments/audit-integrity - PLAN

The tenant of a managed Supabase project is also its administrator. That makes
every "is your audit trail tamper-proof?" question - SOC 2 CC7.2, ISO 27001
A.12.4.2/.3, HIPAA 164.312(b), or a customer's own security review - resolve to
one structural fact: **which side of the tenant boundary does the evidence live
on?**

An auth event is recorded in more than one place. One of those places is a
table inside the tenant's own Postgres, which the tenant's most privileged
credential owns. The others belong to the platform. This experiment measures the
split: who can erase what, what trace erasing leaves, and which copy survives.

Everything runs against a FRESH project on purpose. A privilege or a logging
default measured on a project that has been alive for months is a fact about
that project; the same measurement on a project minutes old is a fact about the
platform.

## Modules

### A00 - control

Per-service health (auth, rest, db), Postgres version, project age at first
probe. A red A00 invalidates the run rather than producing a finding: the point
of the experiment is that these are platform defaults.

### A01 - the privilege map (read-only)

`auth.audit_log_entries`: owner, ACL, columns, constraints, triggers, and
`has_table_privilege` for every role a tenant can reach against all five write
privileges. Then the platform's logging defaults - `log_statement`,
`log_connections`, `log_min_duration_statement`, whether pgaudit is installed.
A01 says who HOLDS a privilege; A02 exercises it.

### A02 - the tamper matrix (destructive)

The statements themselves, each role driven with `set local role` inside one
subtransaction per cell so a denial isolates. Insert (forge an entry GoTrue
never wrote, backdated, with a chosen actor and source IP), update (rewrite an
existing entry's IP and action in place), delete, truncate.

### A03 - what erasing leaves behind (destructive)

A DELETE and a TRUNCATE, each carrying a nonce, searched for in
`postgres_logs`. A DDL statement with its own nonce is the POSITIVE CONTROL:
without it, "not found" is indistinguishable from ingestion lag. Also records
what the logged control line carries - role, `application_name`, and any
provenance the platform appends to a statement it ran on the tenant's behalf.

### A04 - the levers that make it visible (destructive, restores everything)

`log_statement` on the Management API's Postgres config (present or absent, and
what a PUT answers). pgaudit in session mode (`alter role postgres set
pgaudit.log to 'write'`) and in object mode (an auditor role granted on the
audit table and set as `pgaudit.role`, with session logging off) - the scoped
form is the one worth running continuously. `log_connections` through the API.

### A05 - two stores, one event (destructive)

The reconciliation control. k auth events, then: the rows in
`auth.audit_log_entries`, the same events in the `auth_audit_logs` source with
the ingestion lag, a forged row that appears in the table and not in the
stream, and finally a DELETE of every event row - after which the count pair
(table, stream) for one window IS the tamper check.

### A06 - is the in-database copy on by default (destructive, restores config)

Settles a contradiction in our own corpus: a published guide says the table
"arrives empty because Postgres writes are off by default", while a project
from June holds rows. Reads the documented auth config for any audit key,
PATCHes the undocumented `audit_log_disable_postgres`, and then answers the only
question that settles it - does a NEW auth event still land in the table.

### A07 - retention and export, per plan (read-only)

`GET organizations/{slug}/entitlements` for each org role supplied:
`security.audit_logs_days`, `log.retention_days`, `backup.retention_days`,
`audit_log_drains`, `log_drains`, `pitr.available_variants`. Plus how many /v1
paths mention audit at all - which is the answer to "can we pull the platform
audit log into our SIEM".

### A08 - the GoTrue admin audit endpoint (destructive)

`GET /auth/v1/admin/audit` is the read a service-key holder can make without
touching Postgres. Is it a second copy, or a window onto the table the tenant
can empty? Delete the rows, re-read the endpoint. Also whether the endpoint has
a write or delete route at all.

### A09 - the hash-chained mirror, and its honest limit (destructive)

The pattern people reach for once they learn the table is writable: mirror every
entry into an append-only chained table, fed by a trigger on
`auth.audit_log_entries` (possible only because the ACL grants `postgres` the
TRIGGER privilege on a table owned by `supabase_auth_admin`). Prove a real
GoTrue write fires it, prove deleting a mirror row breaks the chain and the
verifier names the break - then rebuild every hash as the same identity and
watch the verifier go quiet. The chain is evidence only if the head hash left
the database.

### A10 - the forensic backstop (read-only)

What physical copies exist (daily backups, PITR, the recoverable window) and
which restore levers /v1 exposes. Deliberately does not run a restore: what a
reader needs is whether the evidence exists and how far back, and the honest
note that the same PAT which can delete the audit rows can also call restore.

### A11 - the Dashboard SQL Editor's identity (read-only, operator step)

Both `postgres` and `dashboard_user` hold full write on the audit table, and the
Management API path measures as `postgres`. Which one a Dashboard session uses
changes what an investigator greps for, and it cannot be driven from the PAT.
A11 reads `postgres_logs` for a statement that did not come from `mgmt-api` and
reports the identity; the module header carries the two-line SQL an operator
runs in the Dashboard to make one appear.

## Not in scope

- An actual restore-and-diff to recover deleted audit rows (A10 flags it).
- Log drain delivery of auth audit events: no /v1 lever exists, so it is
  Dashboard-only and cannot be driven from here (A07 reads the feature flag).
- Read-Only member behaviour end to end. A01 measures that
  `supabase_read_only_user` holds SELECT and not DELETE, which is the database
  half; the Dashboard half needs a second human account.
