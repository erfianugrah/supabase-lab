# RUNLOG - cli-surface

## 2026-10-10 - CL01-CL04 (declarative schemas, pg-delta) and CL20-CL22 (experimental stack without Docker)

Supabase CLI versions as recorded: `host_cli_version` 2.120.0 in the CL01,
CL02 and CL03 results (the `supabase` on the macOS host's PATH, a Homebrew
install; the harness calls `supabase --version` and stores the output);
`cli_version` 2.120.0 in CL20a for the container (the Linux release tarball,
sha256 checked against the release's checksums file). CL04 recorded no CLI
version: its artifact was written before the modules stored one, and CL04 was
not re-run (it needs a cloud project). It ran on the same host install as
CL01-CL03 on the same day, which is an inference, not a record. Every figure below
except three marked as outside the harness (the 4 min 25 s and 5.5 s `db diff`
timings in CL01, and the 7 of 7 manual schema dumps in CL22) was pasted from
`out/2026-10-10/*.facts.md`; the artifacts are
`run-2026-10-10T09-26-30-496Z` (CL01-CL03), `run-2026-10-10T00-32-16-898Z`
(CL20, CL21, CL22 first run), `run-2026-10-10T00-36-06-597Z` (CL04) and
`run-2026-10-10T00-41-23-157Z` (CL22 rerun). Where CL22 appears below the
figure comes from the rerun unless it says otherwise. CL01-CL03 ran twice on 2026-10-10; the first run's
artifact held no CLI version, so it is not published and the rerun is the one
cited. Counts, statuses and fingerprints were the same in both; only the
timings differed (CL01d second-run `db diff` 4820 ms migra and 1713 ms
pg-delta in the first run). n is 1 per figure
unless a row says "two runs". The lab commit stamp in the artifacts is the
repo HEAD under the run, not a commit of this experiment (nothing was
committed when the runs were made).

Vantage. CL01-CL04: macOS arm64 host with Docker Desktop; the host's
resolver returns no A record for a project's direct database host
(`direct_host_A_records` ENOTFOUND, AAAA 1, CL04c), which matters for one row
below. CL20-CL22: a Debian bookworm container (linux/arm64, kernel
Linux_7.0.14-linuxkit, 10 CPUs, 7834 MB, non-root uid 1000) with no docker or
podman binary and no socket (CL20a), on the same host.

Sources for the claims under test, all public: the Select 2026 write-up
(https://supabase.com/blog/select-2026-build-anything: native local stack
"in alpha today, off by default", "several checkouts or git worktrees of the
same repo run at the same time"; `pg-delta` default for new `supabase init`
projects (the blog only); `supabase config pull`; `supabase pull`), the changelog entry
https://supabase.com/changelog/44938-public-alpha-declarative-schema-management-with-pg-delta,
and the CLI's own `--help` text. What the docs say is kept apart from what the
run measured in each section.

### Fixture and method

CL01-CL03 apply `fixtures/schema.sql` to a local Postgres 17 started with
`supabase db start` (legacy backend, Docker): schema `app` plus `public`, 2
enabled-RLS tables in `app` and 1 in `public`, `FORCE ROW LEVEL SECURITY` on
`app.docs`, 6 policies (one restrictive, one for `anon`, one `to public`), a
column grant, sequence grants, `ALTER DEFAULT PRIVILEGES` (3 statements),
two functions (one `SECURITY DEFINER` with a pinned `search_path` and a
revoked-from-PUBLIC execute grant), one trigger, a generated column, a partial
and a GIN index, an extension, 2 comments and a `security_invoker` view.

"Fidelity" is a catalog fingerprint (`lib/fingerprint.ts`): 238 sorted text
lines (relations with owner, RLS flags and options; columns; constraints;
indexes; policies; triggers; function definitions and ACLs; enum labels;
sequences; relation, column, schema and function ACLs; default privileges;
extensions) read from the catalogs of the fixture database and of a database
rebuilt from a tool's output. A clean fingerprint says nothing about what the
fingerprint does not cover (data, storage objects, publications, event
triggers, roles).

### CL01 - `db diff`: migra against pg-delta

Docs claim: pg-delta is the new diff engine. The blog says it is the default
for new `supabase init` projects; the older changelog entry (44938) described
it as opt-in alpha via `config.toml` and said it was not yet the default, so
the two sources disagree. CL01b agrees with the blog. Measured:

| item | migra (`--use-migra`) | pg-delta (`--use-pg-delta`) | module |
|---|---|---|---|
| statement-start lines in the diff | 57 | 57 | CL01a |
| `FORCE ROW LEVEL SECURITY` statements (fixture has 1) | 0 | 1 | CL01a |
| `COMMENT ON` statements (fixture has 2) | 0 | 3 (the third is the extension's own comment) | CL01a |
| `ALTER DEFAULT PRIVILEGES` (fixture has 3) | 0 | 3 | CL01a |
| `security_invoker` on the view | 0 | 1 | CL01a |
| column-level grant | 0 | 1 | CL01a |
| function ACL statements | 0 | 2 | CL01a |
| sequence ACL statements | 0 | 4 | CL01a |
| statements that drop something | 1 (`drop extension if exists "pg_net"`) | 0 | CL01a |
| REVOKE statements | 0 | 8 | CL01a |
| catalog fingerprint after applying the diff to a reset database | 223 of 238 lines identical, 15 only in the fixture database, 5 only after the round trip | 238 of 238 identical | CL01c |
| `db diff` wall time, second of two runs on the same project | 3406 ms (first run 11358 ms) | 1683 ms (first run 6136 ms) | CL01d |

Lost by the migra round trip, by kind (CL01c-migra `missing_by_kind`): acl col
1, acl rel 2, acl schema 3, comment col 1, comment rel 1, defacl 3, func 1, rel
2, seq 1. Invented by it (`extra_by_kind`): defacl 1, func 1, rel 2, seq 1.
Read against the lines themselves (raw files `cl01-fp-only-*-migra.txt` in the
gitignored evidence directory, not published): the round-tripped function had
`EXECUTE` for PUBLIC and no explicit grant to `authenticated`, where the fixture
had revoked PUBLIC and granted `authenticated`; the `ALTER DEFAULT PRIVILEGES
... REVOKE ... FROM anon` on functions was absent so the default privilege for
`anon` came back; `FORCE ROW LEVEL SECURITY`, the 2 comments, the 3 `USAGE`
grants on schema `app`, the `authenticated` grant on `ticket_seq`, the select
grant on `live_docs` for `anon` and the 3 default privileges in `app` were
gone; the view lost `security_invoker`, and the sequence start (1000) became 1.

No flag on a fresh `supabase init` project: the JSON `engine` field says
`pg-delta`, the output equals the explicit `--use-pg-delta` output, and the
generated `config.toml` has `[experimental.pgdelta] enabled = true` (CL01b).
That agrees with the Select 2026 sentence; the module did not test an existing
project whose config lacks the section.

pg-delta noise, not a failure: the diff re-grants each owner's own privileges
(`REVOKE ALL ... FROM "postgres"` then a `GRANT` that includes `MAINTAIN`).
`MAINTAIN` is in the emitted text on a Postgres 17 database; whether a
Postgres 15 target accepts it was not run.

Two observations outside the harness, with no artifact and not reproduced:
the very first `db diff --use-pg-delta` on this host took 4 min 25 s by shell
`time`, before the Docker images and the CLI's shadow-baseline cache existed.
A later run with an empty `SUPABASE_HOME` and the images present took 5.5 s
by the same method. The cause of
the 4 min 25 s (image pulls are the likely reading) was not separated.

### CL02 - declarative round trip with pg-delta

Docs claim: the declarative tree is the source of truth and `sync` turns the
difference into a migration. Measured on the fixture database:

- `db schema declarative generate --local`: exit 0 in 321 ms, 17 files
  (10407 bytes), load order of 16 entries in `.pgdelta-export.json`
  (`formatVersion` 1, profile `supabase`, `redactSecrets` true). Layout:
  `_cluster/extensions/` 3 files, `app/` and `public/` per-object directories,
  a `default_privileges.sql` per schema, and a `public/adp_wipes.sql` that
  clears assumed destination defaults. The three extension files include
  `pgcrypto` and `uuid-ossp`; the fixture creates only `pg_trgm`, so the other
  two are consistent with coming from the platform baseline (not checked
  directly) (CL02a).
- `sync --no-apply` against an empty `supabase/migrations`: exit 0 in 3276 ms,
  one migration of 6215 bytes and 59 statement-start lines, against 57 from
  `db diff --use-pg-delta`. The 2 extra statements are
  `REVOKE ALL ON SEQUENCE "app"."docs_id_seq" FROM "authenticated"` and
  `REVOKE ALL ON TABLE "app"."live_docs" FROM "authenticated"`; 0 statements
  appear only in the diff (CL02b).
- `db reset` applies that migration (13704 ms); fingerprint 238 of 238 lines
  identical (CL02c).
- Idempotence: a second `sync` wrote 0 migrations and said no schema changes,
  `db diff` after the reset was 0 bytes, and a second export into a scratch
  directory had 0 changed and 0 missing files out of 17 (CL02d).

### CL03 - edits, order, coverage, engine mixing

- Edits (CL03a): a new column, a dropped policy, a changed policy predicate, a
  changed function body, a new table in a new file `aa_tags.sql` whose policy
  calls a function declared in another file, and a deleted table file, all in
  one `sync --no-apply`. Migration statements by kind: add column 1, drop
  policy 2, create policy 2, create function 1, create table 1, drop table 1,
  alter policy 0. A changed policy is a drop plus a create, not an alter. The
  CLI printed `Found destructive changes in schema diff` listing the
  `DROP TABLE "public"."profiles"`. `sync --apply` then left 2 rows in
  `migration list --local` (the baseline and the edit), the new column and the
  new table present, the dropped policy and table absent, and a second `sync`
  found no changes (CL03a-apply).
- Order (CL03b): a hand-written tree with no export and no load-order file,
  files named `01_policies.sql` (policy), `02_functions.sql`, `03_tables.sql`.
  The migration put the table and the function before the policy
  (`table_before_policy` 1, `function_before_policy` 1), so ordering followed
  dependencies, not file names, in this one case. The declared `grant select
  ... to authenticated` was merged into the platform's default grant list for
  the table (no separate statement). pg-delta printed the policy expression as
  `USING (public.cl03_visible(OWNER))` for a column named `owner`: valid SQL,
  keyword-cased by the formatter.
- Coverage (CL03c): 22 kinds created in one database. Marker names present in
  the emitted SQL: migra 8, pg-delta 17, declarative export 17. Per kind,
  migra / pg-delta / export (M, D, T; `-` = absent): composite MDT, enum MDT,
  matview MDT, partitioned MDT, inherits MDT, unlogged MDT, storage_params MDT,
  collation MDT; domain -DT, range -DT, rule -DT, aggregate -DT, publication
  -DT, event_trigger -DT, role -DT, schema_comment -DT, foreign_table -DT;
  statistics ---, operator ---, cast ---, tsconfig ---, role_setting ---. This
  is a regex on the marker name in the SQL text, not a check that the object
  is reproduced correctly. `--strict-coverage` made both `db diff
  --use-pg-delta` and `declarative generate` exit 1 with "pg-delta does not
  manage these PostgreSQL object kinds: cast, operator, statistics object,
  text search configuration"; `ALTER ROLE ... SET` (role_setting) was not in
  that list and not in the SQL either.
- Engine mixing (CL03d): with an exported tree present in `supabase/schemas`,
  `db diff --use-migra` exited 1 (`ERROR: extension "pgcrypto" already exists
  (SQLSTATE 42710)`, after listing the declarative files it was building the
  local database from); `--use-pg-delta` exited 0. With the tree directory
  removed, migra ran (CL01).

### CL04 - linked project: `config pull`, `pull`, linked `db diff`

One Free-org project in ap-southeast-1, created and deleted by the module
(CL04-cleanup pass: DELETE answered 200/404; no project listing was saved
afterwards). The "dashboard" changes in CL04b were made through the Management API
and the Storage API, which the dashboard calls; the dashboard UI itself was
not driven.

- `config pull` on a new project against a freshly initialised config
  (CL04a): 13 differences, 12 to write, 1 to skip; scope "api, auth, database,
  pooler, realtime, storage"; the dry run left `config.toml` unchanged;
  after the write 1 difference remained (`auth.password_requirements`,
  local-only, not pulled). The output also lists 2 credential values not
  compared (`auth.external.apple.secret`, `auth.sms.twilio.auth_token`) and 9
  declared properties "not part of the current comparison".
- After a GitHub provider enabled with a client id and secret, anonymous
  sign-ins on, PostgREST `max_rows` 777, storage global file size limit
  12345678 bytes, and one storage bucket with a 1 MiB limit and a MIME
  allow-list (CL04b): the diff listed 6 entries, 3 to write, 3 to skip.
  Written: `max_rows = 777`, `file_size_limit = "11.77MiB"`,
  `enable_anonymous_sign_ins = true`. Skipped: `auth.external.github.enabled`
  and `client_id` ("remote-only, skip: requires values pull cannot write"),
  with the warning that `auth.external.github` needs
  `auth.external.github.secret` configured manually; no
  `[auth.external.github]` section reached `config.toml`. The bucket was not
  listed and `[storage.buckets.cl-bucket]` is absent from the written file.
- Linked `db diff` after the fixture was applied remotely (CL04c), second of
  two runs: `--use-pg-delta` exit 0, 57 statement starts, 2576 ms;
  `--use-migra` exit 1 in 2144 ms with `getaddrinfo ENOTFOUND` for the direct
  database host. Two readings: the migra path connects to the direct host (which
  this host cannot resolve) while the pg-delta path reaches the database
  another way, or the migra error is unrelated to the vantage. The run did not
  separate them; a vantage with IPv6 would.
- `supabase pull --yes` (CL04d): exit 1 in 4704 ms. Summary rows: config
  unchanged; migration_history failed (`relation
  "supabase_migrations.schema_migrations" does not exist`, the project had
  never had a migration applied); db changed (one migration, 6089 bytes);
  functions unchanged. Applying the pulled migration to a local database and
  comparing with the remote catalogs through the same fingerprint query: 238 of
  238 lines identical.

### CL20 - experimental stack without Docker, one stack

Docs claim: alpha, off by default; runs without a Docker daemon. Measured in
the container:

- Off by default (CL20a, CL22a): with no variable and no config key,
  `supabase start` exited 1 (`failed to inspect container health: docker:
  command not found (podman also not found)`); also exit 1 with
  `SUPABASE_EXPERIMENTAL_STACK=0`.
- `supabase init` with `SUPABASE_EXPERIMENTAL_STACK=1` writes `stack = true`
  under `[experimental]` and 0 `port =` lines (CL20b).
- Cold start in an empty `SUPABASE_HOME` (native artifacts downloaded):
  exit 0 in 14145 ms; runtime `native`; 10 services; at return only
  `database` running, the other 9 sleeping (activation "lazy"); 14 endpoints on
  10 distinct ports, none of the legacy defaults (CL20b). REST, auth, realtime,
  storage and functions share one gateway port.
- First request to each lazy service (CL20c): rest 312 ms, auth 615 ms,
  storage 1105 ms, realtime 1941 ms, functions 307 ms, studio 4937 ms (HTTP
  307), mail 4 ms; all 10 services running afterwards. Memory summed over the
  container: PSS 252 MB asleep, 2145 MB after waking everything; summed RSS
  392 and 3145 MB (shared pages counted per process, so RSS overstates).
  Processes 18 then 69. The native artifact cache was 1666 MB (postgres 388,
  studio 456, pgmeta 203, analytics 186, storage 155, edge-runtime 118,
  realtime 85, auth 33, mailpit 26, postgrest 20).
- `stop` 12293 ms; `start` with artifacts cached 643 ms; 14 of 14 endpoint
  ports unchanged across the restart (CL20d).
- Application flow through the gateway (CL20e): RLS table created with psql,
  sign-up 200, password sign-in 200 with a JWT, insert 201, select 200
  `[{"body":"hello"}]`, anonymous select 200 `[]`, edge function 200 "hello
  from the stack", Mailpit API answering. Pass here is the module's band (all
  of those), not a platform guarantee.

### CL21 - worktrees side by side

- Repo initialised under the stack (no port lines), main plus two linked
  worktrees (CL21a): 3 stacks, start exits 0/0/0, wall time 12245 / 2016 / 1922
  ms (the first includes the artifact download), 10 distinct ports per stack,
  0 ports shared between stacks, 3 distinct stack ids, runtime native for all.
  The three stacks had distinct ids; the stacks differed by project directory
  and branch, so identity is consistent with directory plus branch, which was
  not isolated as the key.
- Isolation (CL21b): a table created in one stack was absent from the other; both
  gateways answered 200. Summed PSS 544 MB with the three stacks asleep and
  3978 MB with two awake (RSS 1011 / 6382 MB); processes 44 and 143; stack
  state on disk 180 MB.
- Stopping one stack (CL21c): exit 0 in 11851 ms, its database port stopped
  listening, the other stack's gateway answered 200 and kept its table.
- `git switch -c b2` inside a worktree, then `start` (CL21d): `status` before
  the start said "No managed stack exists for the selected project"; the
  start (2285 ms) created a second stack for the same directory on
  `refs/heads/b2` with an empty `public` schema; the `refs/heads/b` stack
  stayed listed and reachable. Data does not follow a branch switch.
- Config with the legacy fixed ports (a project initialised with the legacy
  backend: 6 `port =` lines, no `stack` key), run with the variable set to 1
  (CL21e): first worktree exit 0; second worktree exit 1 in 339 ms, error
  `Cannot bind ... sql at 127.0.0.1:54322: ... stack "default" on
  refs/heads/main in /home/dev/lg claims this port`; the second stack is
  registered as `unavailable`. Shifting its ports (database 55322) started it.

### CL22 - switches, command surface, services, drift

- Switches (CL22a), start exit with no Docker in the box: variable 1 and no
  key 0; key `true` and no variable 0; key `true` and variable 0 exit 1 (the
  variable wins); key `false` and variable 1 exit 0; key `false` and no
  variable exit 1; variable 2 exit 1 (`SUPABASE_EXPERIMENTAL_STACK must be 0
  or 1 when set`); variable empty exit 1; global `--experimental` exit 1. The
  top-level help lists `stack` only when the variable is 1.
- Command surface against a running stack, no Docker (CL22b): 22 commands, 18
  exit 0, 4 non-zero. Exit 0: `status`, `db diff` (default and
  `--use-pg-delta`), `declarative generate` and `sync`, `migration list`, `db
  reset`, `migration new` and `up`, `db dump` (empty database and data-only),
  `db lint`, `gen types`, `db query`, `db advisors`, `inspect db`, `test db`
  (a pgTAP file, `.. ok`). Non-zero: `db diff --use-migra` and `--use-pg-schema`
  (`The stack backend only supports the pg-delta engine. Do not pass
  --use-migra; set SUPABASE_EXPERIMENTAL_STACK=0.`), `functions serve` (exit
  124, the 25 s timeout; it printed "Serving functions on
  http://127.0.0.1:8081/..." while the stack's functions gateway was on another
  port), and `db dump` of the schema once the database held a pgTAP extension,
  one table and one policy: `pg_dump: error: could not write to file: Resource
  temporarily unavailable`. In that state schema dumps failed in 4 of 5
  repeats with stdout redirected and 4 of 5 with stdout captured, and the
  first two attempts (`db_dump` failed, `db_dump_again` passed) in this run
  disagreed; the empty-database dump (`db_dump_empty`) and the data-only dump
  passed. A manual check outside the harness (no artifact) in a separate box
  with an empty database passed 7 of 7 schema dumps. The trigger was not
  isolated (the extension, the table or the policy).
- Services against the legacy list (CL22c): `start --help` lists 13
  `--exclude` names for the legacy backend (gotrue, realtime, storage-api,
  imgproxy, kong, mailpit, postgrest, postgres-meta, studio, edge-runtime,
  logflare, vector, supavisor) and 9 capability names for the stack (rest,
  auth, realtime, storage, functions, studio, mail, analytics, pooler). Image
  rendering: 404 (`Route GET:/render/image/... not found`) with the config as
  `init` wrote it (the section is commented out); 200 with a 283-byte PNG
  after enabling `[storage.image_transformation]` and a `stop`/`start`, and an
  `imgproxy` service then listed. Realtime WebSocket upgrade answered `HTTP/1.1
  101 Switching Protocols`. Analytics health 200. Pooler: `[db.pooler] enabled
  = true` added to a running stack did nothing (start exit 0, `stack restart`
  "using its saved configuration", no pooler service); after `stack destroy`
  and a fresh start the service list included `pooler` (sleeping, with an SQL
  endpoint), and a psql connection as `postgres.app` was refused with
  `FATAL: (ENOTFOUND) tenant/user postgres.app not found` (rerun). The first
  run's pooler psql printed a different first line,
  `received invalid response to SSL negotiation: H`, on the same kind of
  connection (port differed, 32302 against 23240); the two runs disagree on
  what the pooler answers and the module did not separate the cause. The tenant
  name the pooler expects was not determined, so no query went through the
  pooler.
- Config drift (CL22d): after `enable_signup = false` with the stack
  running, `stack status` showed `config_drift` "changed" for
  `services.auth.config.disableSignup`. Sign-up HTTP status: 200 before the
  edit, 200 after `start`, 200 after `stack restart` ("restarted using its
  saved configuration"), 422 `signup_disabled` after `stop` then `start` with
  the marker table still present, 422 after `stack destroy` and `start` with
  the marker table gone.

### Not measured

- Linux amd64 (the container was arm64; the CLI lists native artifacts for
  linux-amd64 and linux-arm64 and darwin-arm64), the glibc floor, a hosted CI
  runner, the macOS native runtime on the host, Podman.
- Idle stops (the help text mentions automatic idle stops; none was awaited),
  `--preparation on-demand`, long-running stability, behaviour with more than
  3 stacks.
- Postgres 15 targets for pg-delta output; `ALTER ROLE ... SET` and the other
  unmanaged kinds beyond the four the diagnostic named; correctness of the 17
  kinds pg-delta named, beyond the marker regex.
- The dashboard UI path for CL04b; `config push`; a project with an existing
  migration history table; a paid-plan or non-default-region project; the
  pooler SQL path in CL22c.
- Whether the migra linked-diff failure in CL04c is a property of the vantage.
- What triggers the intermittent schema `db dump` failure in CL22b.

### What to do about it

| practice | rests on |
|---|---|
| On a project whose policies use `FORCE ROW LEVEL SECURITY`, column grants, default privileges or `security_invoker` views, generate migrations with pg-delta; the migra engine dropped all four in the round trip. Read the diff for function `EXECUTE` grants either way. | CL01a, CL01c |
| Treat `REVOKE ALL ... FROM "postgres"` plus `GRANT ... MAINTAIN` lines in pg-delta output as owner re-grant noise on a Postgres 17 database; check them before running against a Postgres 15 target. | CL01a (the text); the PG15 effect is unmeasured |
| Do not run `db diff --use-migra` in a project that has an exported `supabase/schemas` tree; remove the tree or use pg-delta. | CL03d |
| Pass `--strict-coverage` in CI so casts, operators, statistics objects and text search configurations fail the job instead of silently dropping out; as the tool's own diagnostic says, keep their DDL in `_custom/` so re-exports preserve it, and deliver it to targets via a migration. `ALTER ROLE ... SET` was not named by either the SQL or the diagnostic. | CL03c |
| Read the destructive-changes warning from `sync` before applying; a deleted table file becomes `DROP TABLE`. | CL03a |
| After `config pull`, re-enter provider secrets by hand; an enabled OAuth provider is skipped, and buckets are not part of the pull. | CL04b |
| Run the first `supabase pull` of a never-migrated project knowing it exits 1 on the history step while still writing the schema migration. | CL04d |
| For worktrees on the stack, initialise the repo under `SUPABASE_EXPERIMENTAL_STACK=1` so the config has no fixed ports; a config with the legacy port lines makes the second worktree fail to bind. | CL21a, CL21e |
| Expect a separate empty database per branch inside one worktree; keep seed data in migrations or a seed file. | CL21d |
| Apply a config change to a running stack with `stop` then `start`; `start` and `stack restart` keep the saved configuration. `stack destroy` also applies it and deletes the data. | CL22d |
| Enable `[storage.image_transformation]` explicitly before testing image rendering on the stack, and enable `[db.pooler]` before the first `start` (or destroy and recreate). | CL22c |
| Budget about 2.1 GB of memory (summed PSS) for one stack with every service awake and about 0.25 GB asleep, as measured once (n=1) in a linux/arm64 container with 10 CPUs; `studio` is the slowest service to wake (first request 4937 ms) and has the largest artifact on disk, 456 MB; per-service memory was not measured. | CL20c |
