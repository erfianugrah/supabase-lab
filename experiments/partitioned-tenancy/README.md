# partitioned-tenancy

How declarative partitioning behaves on a managed project when the table is
multi-tenant, append-only and grows with time (an audit-log shape:
`tenant_id`, `created_at`, `payload`), and is read through the Data API
under a tenant RLS policy. Six questions: does a policy on the partitioned
parent also cover its partitions when the schema is exposed; does the
documented pg_partman setup run and what do its children inherit; does
partition pruning survive the tenant policy; what does detaching an old
partition cost clients reading and writing the table; which step stops a
detached partition being served to any token; and can a detached partition
be kept in Storage and read back.

Self-provisioning: PT01-PT06 share one Pro-org Micro project (ap-southeast-1)
created on first use; PT99 deletes it. No OpenTofu state. Sibling context:
`rls-policy-cost` (wrapped vs bare policy cost, the session-pooler method for
`set role`), `data-api-defaults` (legacy default privileges on new tables),
`tenant-consolidation` and `tenant-promotion` (moving tenants between
projects).

## Modules

| id | claim measured |
|---|---|
| PT01 | tenant policy on a range-partitioned parent: reads through the parent per tenant; each partition read directly at `/rest/v1/<partition>` by anon and a tenant; partitions in the OpenAPI document; security advisors; tenant writes via parent and via a partition; two mitigations (RLS on a partition, revoke on a partition); a new partition after the default-privilege revoke |
| PT02 | pg_partman per the Supabase docs: availability and version, `pg_partman_bgw`, `create_parent` on an RLS parent, what children carry (RLS, policies, anon grant), `run_maintenance_proc` via the query endpoint and via a session, the template table and `inherit_privileges`, a pg_cron schedule, retention with and without `retention_keep_table` |
| PT03 | pruning under a tenant policy, 2,000,000 rows: range by month with a time filter; hash by tenant with the wrapped and bare policy forms (run-time vs executor-startup pruning); postgres-role baselines |
| PT04 | `DETACH PARTITION ... CONCURRENTLY` of 1,000,000-row partitions under a Data API reader and writer (n = 2); concurrent and plain DETACH while another transaction is open; the detached tables standalone |
| PT05 | closing the Data API exposure of a detached partition: plain DETACH (control), REVOKE before DETACH, SET SCHEMA to a non-exposed schema after DETACH, RLS on the partition before DETACH, pg_partman retention with `retention_schema`; anon and other-tenant reads and the security advisors after each |
| PT06 | a detached 1,000,000-row partition exported as gzip CSV to a private Storage bucket (n = 2), the table dropped, then read back: the Wrappers S3 FDW with the three credential forms this run could create (project ref plus anon or service_role key), and the fallback of download plus `COPY FROM` into a non-exposed schema with a checksum against the original |
| PT99 | teardown |

## Run

```bash
export SUPABASE_ACCESS_TOKEN=...            # Management API token
export PVLAB_ORG_PRO=<pro-org-slug> PVLAB_ORG_SLUGS=<pro-org-slug>
export PVLAB_PT_PREFIX=pvlab-pt-            # project-name prefix, default shown
make run                                    # PT01-PT06 then PT99, artifacts in evidence/<ts>/
make run ONLY=PT01,PT99                     # one module plus teardown
make clean                                  # list leftover prefixed projects; DELETE=1 deletes
make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
```

A full run took about 6 minutes on Micro on 2026-10-22. In run 2 the
postgres session refused every PT04 DDL as read-only after the PT03 and PT04
loads, while Data API writes succeeded (RUNLOG); run PT04 on its own project
(`make run ONLY=PT04,PT99`) after PT03. Results: RUNLOG.md and
the key-facts section of the repo AGENTS.md.
