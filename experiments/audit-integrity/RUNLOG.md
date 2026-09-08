# RUNLOG - audit-integrity

Ephemeral by default: provision -> probe -> destroy. Two projects per full
cycle, one on a Pro-plan org and one on a Team-plan org, because the audit
surfaces are plan-gated and an entitlement number is not a measurement.
`make probe ORG=team` points the whole battery at the Team-plan project.

## Run 1 - 2026-09-08 - Pro-plan project, first pass (A01-A11)

One Micro in `ap-southeast-1`, Postgres 17.6, fresh. 15 pass, 18 info, 2 skip,
4 fail. All four failures were harness defects and not platform findings (see
"Bugs this run found in the harness" below), but two of them - A05b and A08a -
recorded valid counts under a wrong pass criterion and a wrong generated
sentence. The 0-row and 0-entry readings the write-up cites come from those two
rows, not from their scores. A05b's published artifact text still reads "So the
Postgres copy is ON by default on a fresh project", which is the opposite of
what its own 0 tells you; the sentence was hardcoded, and Run 2 settled the
question.

- **The audit table is writable by exactly four roles, and none of them is an
  API role.** Owner `supabase_auth_admin`; ACL
  `{supabase_auth_admin=arwdDxtm, dashboard_user=arwdDxtm, postgres=ar*wdDxtm}`.
  4 of 10 probed roles can delete (`postgres`, `dashboard_user`,
  `supabase_admin`, `supabase_auth_admin`), 5 can read - the fifth being
  `supabase_read_only_user`, which holds select and NOT delete. `service_role`,
  `anon` and `authenticated` hold nothing at all, not even select. A note from
  a session before 2026-09-08 claiming `service_role` can tamper with this
  table is wrong for Postgres 17 projects: A01b and A02a measure `service_role`
  as holding nothing at all, not even select.
- **Shape**: `instance_id uuid, id uuid, payload json, created_at timestamptz,
  ip_address varchar`, primary key only. 0 foreign keys, 0 user triggers. So no
  cascade from a user delete, and no sequence gap to detect a removal by.
- **Forging and rewriting both work.** As `postgres`: an inserted `login` for a
  chosen actor from a chosen IP, `created_at` three days in the past, accepted
  and read back; and an in-place `UPDATE` of an existing row's `ip_address` and
  `payload->>'action'`, accepted. An audit row is a plain heap row - no
  immutability, no version column, no `updated_at` to notice an edit by.
- **Erasing it leaves no statement in the logs, and the positive control proves
  the search worked.** Platform defaults: `log_statement=ddl`,
  `log_min_duration_statement=-1`, `log_connections=off`, pgaudit not installed
  (17.1 available). A DDL statement carrying a nonce surfaced in
  `postgres_logs` after 189 s; a bare `DELETE` and a bare `TRUNCATE`, each with
  their own nonce, were absent across that same 189 s window. Without the
  control row this result would be indistinguishable from ingestion lag.
- **The platform tags the path, not the person.** The logged control line is
  `role=postgres`, `application_name=mgmt-api`, plus an appended provenance
  comment: `-- source: POST /v1/projects/:ref/database/query`,
  `-- user: pat:<id>`, `-- date: <iso>`. Per-person attribution is not in
  Postgres.
- **`log_statement` is not settable through the Management API.** `PUT
  config/database/postgres {log_statement:"mod"}` -> `400 Unrecognized key:
  "log_statement"`. `log_connections` IS settable (`PUT` -> 200). The GET
  returns only the overrides that have been set, so a project nobody has
  configured answers `{}` rather than the effective config.
- **pgaudit catches it, in both modes, with no restart.** `create extension
  pgaudit` + `alter role postgres set pgaudit.log to 'write'`: the `DELETE` and
  the `TRUNCATE` both appeared as AUDIT lines 33 s later, in sessions opened
  after the ALTER ROLE. Object mode - an auditor role granted on the audit
  table and set as `pgaudit.role`, with `pgaudit.log` back to `none` - caught
  the delete at 34 s as
  `AUDIT: OBJECT,1,1,WRITE,DELETE,TABLE,auth.audit_log_entries,...`. Object
  mode is the form worth running continuously: it says nothing about the other
  99% of traffic.
- **The in-database copy is OFF by default** (see Run 2, which settles it).
- **The auth audit stream is a separate copy and it is fast.** 3 users + 3
  password logins produced 6 rows in the `auth_audit_logs` source, first
  visible 2 s after the writes, while `auth.audit_log_entries` held 0. Before
  the events the source had produced no rows at all, so it appears when auth
  audit events do.
- **A forged row exists in one store and not the other.** The fabricated entry
  was in the table and absent from `auth_audit_logs` after 127 s: the stream is
  fed by the Auth server, not by the table. A row in one store with no
  counterpart in the other is the tamper signature, in both directions.
- **`GET /auth/v1/admin/audit` is a window onto the Postgres table, not a
  second copy.** HTTP 200 with **0 entries** while the stream carried the same
  six events. `DELETE` and `POST` on that path -> 405, so a service-key holder
  has no API route to the trail's contents.
- **The platform audit log has no API at all.** 115 paths in the `/v1` spec, 0
  mention audit: no read path, no export path, no delete path. That is why no
  tenant credential can rewrite it, and also why nobody can pull it into a
  SIEM.
- **The forensic backstop starts empty.** `GET database/backups` on a fresh
  project: `pitr_enabled=false`, `walg_enabled=true`, 1 logical backup, no
  physical window yet. 6 restore paths exist and all are reachable with the
  same PAT that can delete the audit rows - so the backstop is not protected
  from the actor it protects against, unless the restore lands in a different
  project (`backup.restore_to_new_project`).

### Bugs this run found in the harness (fixed, re-run in Run 2/3)

- A09 failed on invalid SQL: `OUT` parameters belong inside the parameter list,
  not after the closing paren.
- A07 reported every entitlement as "present" because it looked for a
  top-level `value`; the number lives in `config.value`, the boolean in
  `hasAccess`, a tier list in `config.set`.
- A05b hardcoded "the Postgres copy is ON by default" into a sentence that was
  reporting 0 rows. Derived from the config read now.
- A06b patched `audit_log_disable_postgres` to the value it already held, which
  cannot distinguish a working write from a no-op.
- A05e and A08b scored `pass` on a degenerate `0 before, 0 after`. They skip
  with a reason now when the in-database copy is off.
- The Makefile's default module list omitted A00, so the first run has no
  control row.

## Run 2 - 2026-09-08 - Pro-plan project, corrected pass (A00, A06, A07, A09, A11)

- **The in-database audit copy is off by default, and the API cannot switch it
  on.** `GET config/auth` returns 243 keys, one of which is
  `audit_log_disable_postgres=true` - present in the response, absent from the
  published spec. Then the direction that would change something: asked for
  `false` (the opposite of the `true` it held) -> **HTTP 200, re-read still
  `true`**. Accepted and ignored. The switch is Dashboard-only (Authentication
  -> Configuration -> Audit Logs). One admin-created user and one
  password login later, `auth.audit_log_entries` was still 0 -> 0 (A06c,
  `create_attempts 1`); Run 1's three users and three logins had already read
  the same way (A05b).
  This CONFIRMS the claim in the corpus guide
  `guides/supabase-auth-mfa-trusted-device-and-impersonation-audit`
  (measured 2026-07-24, `ap-southeast-2`) on a fresh project in a different
  region seven weeks later. A project holding rows has had the toggle flipped.
- **The Dashboard SQL Editor is the same database role as the Management API.**
  A11 found the operator statement in `postgres_logs`:
  `role=postgres, application_name=supabase/dashboard-query-editor`, alongside
  `postgres/mgmt-api x14` in the same hour. Same role, different application
  name - confirmed independently in the Dashboard, which reported
  `current_user=postgres, session_user=postgres,
  application_name=supabase/dashboard-query-editor`.
- **A tenant can attach a trigger to the Auth server's own table.** A09a
  installed a schema, a chained table, a SECURITY DEFINER capture function, a
  verifier and an `AFTER INSERT` trigger on `auth.audit_log_entries` - the ACL
  grants `postgres` the TRIGGER privilege. A09b-d could not be measured: with
  the in-database copy off, GoTrue writes no row, so the trigger never fires.
  Gated with that reason rather than scored.
- **Control**: all three services `ACTIVE_HEALTHY` on the first poll, Postgres
  17.6, project 42 min old at first probe, all four key generations present.

## Run 3 - 2026-09-08 - Team-plan project, pre-toggle pass (A00-A04, A06, A07, A10, A12)

A second Micro in `ap-southeast-1` on a Team-plan org. Every database-side
CATEGORICAL result above reproduced - same ACL, same shape, same defaults, same
`audit_log_disable_postgres=true` default, same 400 on `log_statement` - and the
timings agreed to within one poll interval: a 191 s control search window
against 189 s, and 32 s / 33 s pgaudit figures against 33 s / 34 s. So none of
it is plan-dependent. What IS plan-dependent:

- **Retention and export are entitlements, and the gap between plans is the
  whole compliance answer.** From
  `GET /organizations/{slug}/entitlements` (64 entitlements per org):

  | key | free | pro | team |
  | --- | --- | --- | --- |
  | `security.audit_logs_days` | no access, 0 | no access, 0 | **62 days** |
  | `log.retention_days` | 1 | 7 | **28** |
  | `backup.retention_days` | no access, 0 | 7 | 14 |
  | `audit_log_drains` | false | false | **true** |
  | `log_drains` | false | **true** | **true** |
  | `pitr.available_variants` | none | 7\|14\|28 | 7\|14\|28 |
  | `security.private_link` | false | false | true |
  | `security.soc2_report` | false | false | true |

  A Pro project has **no platform audit log at all**. Its entire auth audit
  trail is a 7-day platform-side stream, and the only preservation lever it has
  is a project log drain.
- **A minted CLI login role cannot touch the auth schema - even the
  read-write one.** `POST /v1/projects/{ref}/cli/login-role {read_only:true}`
  -> 201, `ttl 300`, role `cli_login_supabase_read_only_user`; connected
  through the session pooler as `<role>.<ref>`, then `select` and `delete` on
  `auth.audit_log_entries` both refused with **`permission denied for schema
  auth`**. With `{read_only:false}` -> 201, `ttl 300`, role
  `cli_login_postgres`, and the same two refusals. So a JIT credential is
  strictly weaker than the project's `postgres` password against the audit
  trail, in both variants. `DELETE /cli/login-role` -> 200, and a later
  connection attempt gets `FATAL: password authentication failed`.
  This is the practical control: hand out a 300 s CLI login role, not the
  database password.
- **`postgres` cannot become `dashboard_user` or `supabase_read_only_user`.**
  Both `set local role` attempts fail with `permission denied to set role`, so
  the exercised matrix covers 4 of 6 roles and the other two rest on the A01b
  grant read. The Dashboard connects AS those roles rather than switching to
  them from a `postgres` session.
- **Member roles in use**: `GET /organizations/{slug}/members` returns a
  `role_name` and an `mfa_enabled` flag per member, so the RBAC surface is
  readable per organization. None of the three organizations read carried a
  Read-Only member, so the Dashboard half of that role stays doc-cited: the
  access-control page states its SQL runs as `supabase_read_only_user`, which
  A01b measures as select-only on the audit table. Per-organization membership
  is not recorded here - these are demo organizations, and the shape of the
  endpoint is the finding, not their rosters.

## Run 3b - 2026-09-08 05:48 UTC - Team-plan project, A02 re-run

A02 alone, re-run after the matrix was widened from 4 roles to 6 by adding
`dashboard_user` and `supabase_read_only_user`. 30 cells, 3 info rows. 4 roles
exercised; `dashboard_user` and `supabase_read_only_user` recorded as
unassumable from a `postgres` session (`permission denied to set role`), so
their privileges rest on the A01b grant read. This artifact
(`run-2026-09-08T05-48-26-687Z`) is the one the published privilege matrix
cites, and it went unlogged here until the review pass caught it.

## Run 4 - 2026-09-08 - Team-plan project, post-toggle pass (A05, A08, A09, A11)

The Dashboard switch (Authentication -> Configuration -> Audit Logs, labelled
"Write audit logs to the database" in the UI - the positive form, where the docs
describe the negative "Disable writing auth audit logs to project database")
was turned on by hand; the config API confirmed `audit_log_disable_postgres`
reading `false` about 255 s after a polling loop was armed, observed at the
terminal and not by any module - no artifact carries that figure. 13 pass,
4 info.

- **The divergence, measured.** 3 users + 3 logins wrote 6 rows to
  `auth.audit_log_entries` (`login` x3, `user_signedup` x3, first row visible
  immediately) and 6 to `auth_audit_logs` (first visible 33 s after the
  writes - the Pro run with the copy OFF saw 2 s, so treat both as poll-derived
  rather than as a platform figure). A `DELETE` matching the run's tag took the
  table from **6 to 0** and left the stream at **6**. The project's stream
  carried 9 sources including `auth_audit_logs`, which had produced nothing in
  the earlier windows because no auth audit events had occurred.
- **The forged row stayed out of the stream** across a 126 s search, matching
  the 127 s result from Run 1.
- **`GET /auth/v1/admin/audit` follows the table.** With the copy on it
  returned 5 entries, 2 carrying the run tag, visible immediately; after the
  `DELETE` removed those 2 table rows the endpoint's tagged entries went
  **2 -> 0**. So it is a window onto `auth.audit_log_entries`, and erasing the
  table blinds the admin API in the same statement.
- **A trigger on the Auth server's own table fires for the Auth server's own
  insert.** The `SECURITY DEFINER` capture function mirrored the tagged entry
  immediately; the mirror held 4 rows, chain verifying end to end.
- **A11 with the operator step done**: the Dashboard statement was found in
  `postgres_logs` as `role=postgres,
  application_name=supabase/dashboard-query-editor`, with the hour grouping as
  `postgres/mgmt-api x13`, `postgres/supabase/dashboard x6`,
  `postgres/supabase/dashboard-query-editor x1`.

### The A09c defect this run exposed

A09c reported "no break" after deleting what it called an interior row. The
mirror held 2 rows, so `order by seq limit 1 offset 1` WAS the tail, and a
chain cannot notice a missing tail - each row links to the one before it, so
lopping off the newest rows leaves a chain that recomputes end to end. The
module was measuring truncation while claiming to measure an interior cut, and
A09d's "the verifier goes quiet again" then rested on a 1-row chain whose
rehash produced an unchanged head hash. Both rows were unsafe to publish.

## Run 5 - 2026-09-08 - Team-plan project, A09 corrected

A09 now creates two users (each create-plus-login writes two audit rows, so the
mirror has 4) and reports the tail and interior cases as separate rows.

- **A09b**: mirror 4 rows, seq 1..4, verifier clean, captured immediately.
- **A09e** (new): deleted the tail, `seq 4` of 4 -> verifier reports **no
  break** over the 3 remaining rows. A hash chain does not detect truncation.
- **A09c**: deleted an interior row, `seq 2` of the 3 remaining -> verifier
  reports **first break at `seq 3`** over 2 rows. An interior deletion is
  detected and the first broken link is named.
- **A09d**: rehash of every remaining row -> verifier clean again over 2 rows,
  head hash moved `5d462b0c1893` -> `2eb685578caa`. The role that can break the
  chain can also rebuild it, so the chain is evidence only if the head hash
  left the database first.

## Run 6 - 2026-09-08 06:35 UTC - Team-plan project, A03/A04/A12 corrected

The review pass found three claims the harness had not actually measured. All
three were fixed and re-run, and one of them came back the OPPOSITE way.

- **The control's arrival was never recorded.** `findMarkers` returned ONE
  `lagS` taken at loop exit, and the loop runs to its timeout whenever any
  marker is missing - which the delete and truncate nonces always are. So the
  189 s / 191 s figures published as the control's ingestion lag were the
  window's length. With per-marker first-seen times: the control arrived at
  **32 s**, and the delete and truncate were absent across the full **192 s**
  window at a 30 s poll interval. The claim is stronger this way, and the
  earlier framing was the corpus's own `pass-band-as-measurement` shape.
- **pgaudit object mode does not catch `TRUNCATE`.** Session mode caught the
  delete and the truncate, both first seen at **32 s**. Object mode caught the
  delete at **33 s** and produced NO line for the truncate across a **193 s**
  window - with `truncate` granted to the auditor role alongside select,
  insert, update and delete. The write-up had claimed both modes caught both
  statements; object mode had only ever fired a delete. Nothing here explains
  the mechanism; the measurement is the absence, and the consequence is that
  object mode alone leaves the fastest erasure path unlogged.
- **The `log_connections` write does take.** PUT -> 200, the GET echoes
  `log_connections=true`, and a session opened afterwards reports
  `pg_settings.log_connections = on`. No `connection authorized` line turned up
  within 97 s, so the setting is confirmed and its output is not. The earlier
  write-up called it "settable" on the strength of a 200 whose value still read
  `off` - the same shape it calls a no-op for `audit_log_disable_postgres`.
- **Revocation of a minted login role is now measured.** A12d used to probe
  with a deliberately wrong password, so its `FATAL: password authentication
  failed` proved nothing. It now connects with the minted password (OK), calls
  `DELETE /cli/login-role` (200), and reconnects with the SAME correct password:
  `FATAL: (EAUTHQUERY) user not found in the database`. Revocation confirmed.
- **Incidental**: one `read_only` connect probe failed with `password
  authentication failed` seconds after minting while the two probes after it
  authenticated, so a freshly minted credential is not immediately usable.
  Also `GET config/database/postgres` returned 1 key (`log_connections`) on
  this pass against 0 on a fresh project, which is what tests the earlier
  "returns only the overrides that have been set" inference.

## The platform audit log, read by hand

No `/v1` path exposes it (A07b: 0 of 115), so this is a Dashboard read on the
Team-plan organization and it is recorded here rather than in an artifact.

- It records control-plane calls with the actor (a named user plus their
  organization role), the method, a description, the HTTP status, the target
  project and ref, and a timestamp. Reads are included - `GET Get project api
  keys`, `GET Gets project's settings`.
- It does NOT record SQL execution. In one 20-minute window it held the
  battery's `PUT` (Postgres config), `PATCH` (auth config), `POST`/`DELETE`
  (login roles) and the Makefile's `GET` api-keys calls, while the dozens of
  `POST /v1/projects/{ref}/database/query` calls from the same runs - including
  the deletes and truncates against `auth.audit_log_entries` - produced no
  entry. The window's total was 30 entries, fewer than the query calls alone.
- **Failed control, worth recording**: the first attempt at this comparison
  fired `GET /v1/projects/{ref}/functions` as a positive control alongside a
  `database/query` delete, one second apart. NEITHER appeared, so listing
  functions is not an audited action and that pair proved nothing. The
  conclusion above rests on the battery's own mutations as the control instead:
  same PAT, same project, same minutes, recorded, while the SQL was not.

## Still to measure

- An actual restore-and-diff to recover deleted audit rows (A10 flags it; costs
  a project restore).
- Whether a Dashboard SQL Editor run appears in the organization audit log.
  The window read by hand covered Management API traffic; the two SQL Editor
  statements run for A11 were not separately searched for in that page, and the
  finding above ("no SQL execution is recorded") rests on the API-side query
  calls. Worth a dedicated read.
- A Read-Only member exercised end to end. No such member exists in any of the
  three organizations (A12a), so the Dashboard half of that role stays
  documented: the access-control page says its SQL runs as
  `supabase_read_only_user`, which A01b measures as select-only here.
