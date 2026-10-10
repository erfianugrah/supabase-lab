# supabase-lab

OpenTofu reference environments for Supabase platform features, validated end-to-end on disposable infrastructure. Each experiment is one OpenTofu state under `experiments/<name>/` - build, run the test suite, `make destroy` the same day. Where platform behaviour diverges from the docs (undocumented endpoints, auth-model gaps, multi-pass applies), the code comments and `RUNLOG.md` capture what was actually measured.

Current experiments (the committed ones; see `AGENTS.md` for per-experiment key
facts):

- `cross-project-auth` - can one project's identity be trusted by another, so a
  tenant's token survives being moved between projects.
- `tenant-consolidation` - many per-customer projects merged INTO one shared
  multi-tenant project, and the collisions that produces.
- `tenant-promotion` - the same road backwards: one tenant moved OUT of a shared
  project into its own, whether a client follows without re-authenticating, and
  what it takes to retire the identity left behind.
- `session-carry` - existing sessions across a move between two projects:
  whether one signing key can serve both (the same material can, under a
  different kid, but a kid is unique across projects, so the target still
  refuses source tokens), what the held access and refresh tokens do at the
  target, and the auth table (`auth.mfa_amr_claims`) that a copy of users,
  identities, sessions, refresh_tokens and mfa_factors misses for aal2
  sessions.
- `key-rotation` - what happens to a trusting project when the issuer rotates
  its signing key. Ported mechanism; the findings it reproduces are already
  measured, the port itself has not been run live.
- `http-tier-lockdown` - restricting the HTTP tier.
- `privatelink-aws` - PrivateLink (VPC Lattice) to a Supabase project in
  ap-southeast-1 (demo region; region is one var - `aws_region` in
  experiment.tfvars - and both sides take it, since PrivateLink is
  same-region only): endpoint + SG (5432 AND 6543), Route53 PHZ for
  verify-full, in-VPC runner, CLI migration paths, network-restriction
  closure, restart behaviour.
- `identity-transfer` - an OAuth identity comes back with a new subject for
  an existing person (the Apple Developer team-transfer shape): linked by
  verified email, a new user, or the same user after a rewrite of the
  identity row. Driven through the Keycloak provider slot from a
  lab-controlled issuer worker, against a managed project (IT01-IT03) or a
  throwaway GoTrue in Docker (ITL1-ITL3, `make local-up`) for the questions
  that are about the Auth server's code rather than the platform's config
  surface: which stored copies of the subject and email a sign-in rewrites,
  where a `transfer_sub`-shaped claim lands, and which account-resolution
  decision arms the Before User Created hook.
- `edge-resilience` - what a client can do about platform incidents that
  are not theirs to fix: 25 measured modules (W01-W26) across JWT skew,
  edge cache/failover (Cloudflare worker), warm-standby replication and
  cutover, storage, realtime, edge functions, and pg_cron. Full battery
  battery unattended. See its FAILURE-MATRIX.md + RUNLOG.md.
- `platform-downtime` - what a platform operation (restart, resize,
  upgrade, pause) costs a client, per connection path, in measured
  seconds.
- `checkpointer-reset` - local-only rig (no OpenTofu): `supabase/postgres`
  vs vanilla `postgres` at the same 17.x line, clean vs unclean restart,
  and whether `pg_stat_checkpointer.stats_reset` survives. Its RUNLOG.md
  has the SIGKILL-during-checkpoint table across 17.4, 17.11 and 18.6
  (version-dependent).
- `redundant-writes` - local-only rig (no OpenTofu): what an upsert or UPDATE
  of unchanged rows writes (row versions, WAL, full-page images, dead tuples,
  VACUUM) on PG 15, PG 17 and the supabase CLI's Postgres image, how much each
  guard removes (`IS DISTINCT FROM` on DO UPDATE, pre-filtered batch, guarded
  MERGE, `suppress_redundant_updates_trigger()`), and `count(*)` vs
  `reltuples` vs `n_live_tup` across a stats reset, a crash and a load.
- `platform-facts` - not a behaviour test; harvests per-project facts
  (pg_settings, extensions, versions) for reference.
- `residency-facts` - the data-residency doc's claims as measured modules:
  the region catalogue endpoint, smart-group rejection in `region`,
  Cloudflare edge PoP, edge-function execution pinning, the storage CDN
  cache matrix (including a cached-private-object policy-bypass finding),
  realtime.messages partitioning, and the log-drain API surface.
- `pooler-semantics` - Supavisor session-vs-transaction mode behaviour,
  error codes, and capacity signatures. No OpenTofu state of its own: S01/S02
  run against `medium-serverless`'s project through that Makefile
  (`EXPERIMENT=pooler-semantics`). First run 2026-09-30: all nine features
  pass on every mode with ONE client per mode, which is the probe's shape, not
  a licence - see medium-serverless MS10 for the same pooler under 20 clients.
- `pdf-corpus-graph` - PDF corpus ingestion + entity graph experiment.
- `stripe-sync-schema` - does the Stripe Sync Engine's projected Postgres
  schema stay in sync with the Stripe API surface.
- `vault-root-key` - two projects; the migration-guide item about vault
  secrets and the project root key.
- `image-transformations` - Storage image transformation billing and runtime
  surface: which URL surfaces transform, docs-vs-runtime limits, edge cache
  and overwrite invalidation, signed-URL tampering, RLS on the render path,
  the rate ceiling, and the (dashboard-gated) billing counter.
- `instance-sizing` - compute-size gating across org classes: Nano rejected
  three ways on paid orgs, accepted on free orgs; smart region selection;
  the legacy paused-project one-way door; the free-org pause lifecycle.
- `sfp-platforms` - what a `platform`-plan (SfP) org actually unlocks vs Pro,
  measured: nano is the create default (correcting instance-sizing I01's
  "Nano absent" reading, which measured the upgrade catalogue), pausing is
  enforced, migrations are not gated, restore points 400, the OAuth BYO
  bridge 404. Self-provisioning modules, no OpenTofu state.
- `byo-oauth` - the Management API OAuth2 surface: authorize behaviour,
  the full token lifecycle (24 h tokens, refresh rotation, org-scoped
  grants, instant revocation), the contract-gated claim flow, and the
  project's own OAuth IdP with `client_id` in RLS.
- `rate-limits` - the Management API throttle surface: headers, 120/min,
  JSON 429 with retry-after, and the budget being cumulative across a
  user's PATs.
- `auth-refresh-race` - the supabase_flutter stale-refresh-token sign-out:
  reproduced the pre-fix defect (gotrue 2.21.0 destroys a valid session on
  `refresh_token_already_used`), confirmed the fix boundary (gotrue 2.22.0 /
  supabase_flutter 2.15.0), mapped the remaining deliberate sign-out paths on
  >= 2.15.0, and measured the GoTrue reuse semantics (parent tolerance,
  grandparent cutoff, config-propagation gap).
- `usage-metering` - per-project cost attribution: the estimator against a
  live org, exact per-key gateway metering, the control-plane store,
  idempotent rollups, and invoice-PDF reconciliation.
- `bu-attribution` - the platform facts behind per-business-unit cost
  attribution inside one `platform`-plan org, built by the customer on its
  own control plane: create returns the ref synchronously, the org-scoped
  listing is the sweep source (paginated), names are mutable, deleted refs
  leave the listings, branches are unlisted and link to their parent only
  through the parent's `/branches`. Self-provisioning, no OpenTofu state.
  Plan: docs/plans/2026-10-02-bu-attribution.md.
- `compute-disk` - everything about compute sizing and disk across plans:
  per-size pg limits (D01), disk semantics + modification quota (D02/D03),
  the autoscale config surface (D04/D07), the free-org autoscale/read-only
  lifecycle (D05/D06/D06b), the dashboard-only IOPS gate (D08),
  upgrade/downgrade timing + sampled downtime (D09), the paid-plan fill -
  autoscale, read-only, disk-full and recovery on Pro (D10) - and the grow
  steps from a 2 GB volume (D11). Root reference:
  COMPUTE-DISK.md.
- `rls-policy-cost` - the cost of an RLS policy: whether `(select auth.uid())`
  hoists (InitPlan, access-control-neutral), what an index does to that win,
  and how a joined table inside an EXISTS policy behaves. Synthetic fixtures
  only, run through the session pooler.
- `rls-wire-claims` - keeping per-user RLS while dropping PostgREST/GoTrue by
  setting `request.jwt.claims` over the wire; validates the lexicanum
  `rls-without-supabase-auth` reference.
- `iap-lockdown` - how far a managed project's HTTP surfaces lock down, and
  putting an Identity-Aware Proxy over the Data API. The per-surface x lever
  inventory (L01-L09: realtime private_only, key revocation, storage + signed
  URLs, EF verify_jwt, grant/RLS write-policy holes, the pre-request filter
  that does NOT fire on hosted), then third-party auth AS the IAP with RLS
  keyed on the issuer claim - a self-minted ES256 issuer (JWKS from an Edge
  Function) for browserless testing, plus the Cloudflare Access / Worker proxy
  path. Cloudflare pieces are OpenTofu (gated on `enable_cloudflare`).
- `edge-function-limits` - the ceilings that get reported as one "Edge
  Functions limit", measured one at a time (2026-09-02): functions per
  project as an entitlement (free 100 / pro 1000 / team 2000), function size
  by bundling path (API 8 MB refused with `413 request entity too large`,
  local CLI bundling lands 8 MB and refuses 24 MB with the same 413), the
  four secrets limits at their exact boundaries, silent loss under parallel
  deploys (24x 201 with 10 landed; 8 CLI processes x 3 functions exit 0 with
  9/24 functions landed; no 429 on any deploy response or in any process
  output), 409 as the same-slug race signature, the runtime
  restrictions (HTML->text/plain on GET only, port 25 hangs while 587 was
  reachable, static files via API deploy 201 with the asset missing), and
  546 WORKER_RESOURCE_LIMIT for both CPU and memory. Second wave the same
  day: both log limits bite exactly (10,000 chars + a truncation marker; first
  100 of 150 events), an active stream is cut at 395 s (docs 400 s), the
  recursive cap did not bite at ~110k nested calls/min (27 x 429
  RATE_LIMIT_EXCEEDED across ~59.6k chains, ~119k nested calls), and ten
  delete-during-deploy rounds plus
  five 4-wide same-slug rounds showed no corruption. Pure triage classifier
  under `lib/`, unit tested on the verbatim strings. Write-up:
  https://erfi.dev/reference/supabase-edge-function-limits/
- `self-hosted-auth` - a GoTrue you run yourself against a managed project's
  Postgres (session pooler, `postgres` role, `search_path=auth`): it shares
  the auth schema, its HS256 tokens (legacy `jwt_secret`) are accepted by
  managed Auth and PostgREST, refresh tokens redeem across both sides, and
  with the platform's ES256 public key supplied as a verify-only JWK the trust
  is mutual. Measured 2026-09-02: `supabase_auth_admin` is reserved; the
  managed PostgREST rejects an HS256 token that carries any kid (`401
  PGRST301`) while the managed GoTrue accepts the same token; revoking the
  legacy HS256 signing key kills the self-hosted tokens in 3-6 s and the
  legacy anon/service_role API keys with them; with its own ES256 key, the
  public half published from an Edge Function and registered as third-party
  auth, the self-hosted GoTrue's tokens survive that revoke. Write-up:
  https://erfi.dev/reference/supabase-auth-end-to-end/
- `security-lockdown` - the broader security surface beyond the IAP: the
  Management API security advisor (catches every seeded exposure), network
  restrictions gating only the DB/pooler socket (REST keeps answering), the
  auth-hardening levers, and the honest Data API answer - the managed PostgREST
  off and your own PostgREST (v16.2) serving the same Postgres through the
  session pooler, fronted by a `db-pre-request` IP filter and an nginx
  `limit_req` rate limiter. Also the PostgREST connection-role separation,
  Vault, pg_net egress, pgaudit/PITR, and the socket lock. Review gap-plugging
  (S13-S15, 2026-08-31): column-level grants close the column a row UPDATE
  policy leaves open (write to a withheld column -> 401/42501); the Auth
  switch-on levers a customer can turn on (before-user-created hook, CAPTCHA,
  configurable rate limits) are present and settable; and Storage/Realtime
  answer with the Data API off, so a db-pre-request (a PostgREST control) never
  reaches them.
- `github-branching` - two projects connected to one GitHub repository, each
  with its own working directory (`apps/a`, `apps/b`). Measured 2026-09-23:
  with "Supabase changes only" off each project created a preview for all five
  pull request shapes; with it on, only for those changing its own
  `<workdir>/supabase/` (GB01 tested migrations only; GB04 the other kinds). Every connected project posts check-runs named
  `Supabase Preview` to every pull request commit (`skipped` from every
  project, and only `skipped` from one that does not branch), so the docs'
  wait-by-check-name workflow for app A read project B's run on both an A-only
  and a two-app pull request. Per project, the Management API branch list
  ended on `MIGRATIONS_FAILED` for a broken migration and `FUNCTIONS_DEPLOYED`
  for a valid one, but read `FUNCTIONS_DEPLOYED` on both at the first 15 s
  sample, before `CREATING_PROJECT`. With changes-only on, each of the four
  file kinds tried under `<workdir>/supabase/` (seed, config comment, new
  function, a non-CLI file) triggered; a migration pushed to a pull request
  that opened without Supabase changes needed a close and reopen to preview;
  a pushed `seed.sql` change did not re-seed; and merging an A-only pull
  request still started a production action run on B. Measured 2026-09-29
  (GB07, project A): an Edge Function secret set on the parent, not referenced
  in `config.toml`, reached none of the three previews that returned a
  reading; a dotenvx-encrypted `.env.preview`, with its private key set on the
  parent, reached the preview's function; a `.env.preview` built the same way
  but encrypted to a key the parent does not hold failed the run at `clone`
  while the branch `status` read `MIGRATIONS_FAILED`; and an `env()` reference
  with no value anywhere deployed with every step `EXITED` and the secret
  absent.

- `wrappers-delete-scope` - what one dashboard Wrappers Delete or Edit removes,
  replaying the SQL Studio's own pg-meta generates (pinned commit). Measured
  2026-09-23 on five BigQuery connections: created in the dashboard, each owns
  its foreign data wrapper and a Delete removes one; set up in SQL on one shared
  wrapper, a Delete on any row removes all five servers, their foreign tables
  and views built on them (Vault secrets left behind), and an Edit leaves only
  the edited connection. `drop foreign table` + `drop server` without cascade
  removes exactly one, and RESTRICT refuses each over-reach.
- `medium-serverless` - one Medium project in ap-southeast-2 on a Team org,
  probed from an IPv4-only vantage as a serverless client would see it: the
  IPv4 add-on switch (a DNS gap longer than ten minutes from this resolver),
  a network restriction per Postgres path (Supavisor refuses by name, the
  direct and dedicated-pooler paths drop to a client timeout), role-level
  `statement_timeout` and `idle_in_transaction_session_timeout` through both
  poolers (a dead client's backend is closed by the pooler itself; a hung one
  needs the role timeout), which client strings reach which log source
  (object paths and failing SQL literals do, a Realtime topic did not), Prisma
  6.19 on each pooled path (Supavisor transaction mode needs `pgbouncer=true`
  or breaks; the dedicated PgBouncer does not, and the flag costs about five
  times the latency on either), the dedicated pooler's CPU cost under equal
  load, the client ramp to the published 600 on both poolers, a same-region
  read replica, and a Medium to Large resize per path. Measured 2026-09-30;
  see its RUNLOG.
- `tls-surface` - one micro project, every TLS surface it exposes, from an
  IPv4-only vantage: protocol versions, a one-handshake-per-suite cipher
  enumeration, certificates, SNI/ALPN/HTTP/3/HSTS and port 80 on each HTTPS
  name (project API, Storage, legacy functions host, Management API, custom
  domain); a CBC-only client on every service route; protocols, suites, chain
  and the libpq sslmode matrix on Supavisor, direct 5432 and the dedicated
  PgBouncer; SSL enforcement on and off (each switch restarts Postgres); and
  outbound TLS from pg_net and an Edge Function. Built to be re-run and
  compared with `make diff`. Measured 2026-10-02; see its RUNLOG.
- `static-hosting` - can a project stand in for Cloudflare Pages or Netlify?
  A real Astro build (Tailwind, a self-hosted font, a React island; `site/`)
  deployed to a public Storage bucket and to an Edge Function and loaded in
  headless Chromium next to a local static-server control, plus a
  per-file-type content-type matrix and the Storage site mechanics (index
  documents, 404s, cache, overwrite visibility). Then the one documented
  exception - a custom domain, which renders HTML from a function but only
  under `/functions/v1/<slug>/` - and, as a contrast, a Cloudflare Worker in
  front. Measured 2026-10-06; see its RUNLOG.
- `governed-starter-kit` - a starter kit for internal apps built on Supabase
  by teams that are not database specialists, with the guardrails owned by a
  platform team: department tenancy from `app_metadata`, RLS and column
  grants on every table, an in-app agent that runs as the signed-in user,
  a decision webhook, a coding agent building and deploying an app on a
  scoped MCP server, self-service project provisioning, and a reversible
  troubleshooting segment. Two Team-org projects, rebuilt with `make up`.
  Measured 2026-10-05 to 2026-10-07; see its README and RUNLOG. K06 deploys
  the Select 2026 MCP server block (Supabase Middleware 1.0) and checks OAuth
  discovery, per-user RLS and `client_id` RLS end to end; K07 measures the
  hosted MCP server's confirmations (destructive SQL, paid branches,
  `skip_elicitations`) by client capability, including Claude Code with an
  Elicitation hook. Both provision their own project (`make mcp-probe`);
  measured 2026-10-10.
- `data-api-defaults` - what a project created through `POST /v1/projects`
  does with the Data API defaults that changed in 2026: default table
  privileges in `public` (and the 42501 grant hint after the opt-in revoke),
  pg_graphql absent by default and refused introspection, the `GET /rest/v1/`
  OpenAPI spec per key type and its Management API replacement, `CREATE
  EXTENSION ... VERSION` ignored with a warning, and the realtime-schema
  lockdown as `postgres`. One Pro project per run (DD01-DD04, DD99). Measured
  2026-10-10; see its RUNLOG.
- `realtime-surface` - Realtime behaviour from changelog and blog claims:
  Postgres Changes AND filters, operators, `select` and DELETE; loss during a
  disconnect and a heartbeat canary; Broadcast Replay limits; binary Broadcast
  across three send paths and two client versions. Self-provisioning (Pro
  org), RT01-RT04, n = 1 per row. Measured 2026-10-10; see its RUNLOG.
- `auth-providers` - custom OIDC provider quota, PKCE, `email_optional` and
  audience; passkeys with a CDP virtual authenticator; a per-method sign-in
  canary; SAML SSO without a third-party IdP (AU01-AU04). Self-provisioning,
  Pro org. Measured 2026-10-10; see its RUNLOG.
- `observability-surface` - what the observability surface does when probed
  from outside: supabase-js trace propagation by release and packaging, the
  Health Check Advisors' firing rule (a failing-request count per two
  clock-aligned five-minute buckets, not the stated 10% share) with detection,
  cache and clearing times, a 36-minute log-ingestion canary, `supabase
  notebooks` pull and push, and a log-drain sink that is ready but blocked on
  an organization-level API gate. Self-provisioning, no OpenTofu state.
  Measured 2026-10-10; see its RUNLOG.
- `edge-runtime-auth` - `@supabase/server` auth modes (`none`, `user`,
  `secret`, `publishable`, `['user','secret']`) against 14 credential
  presentations on an Edge Function and on the Workers runtime (workerd in a
  container, and the same Worker deployed to Cloudflare Workers), plus an Edge
  Function canary: redeploy version drift, whether `supabase-js`
  `functions.invoke` retries a 503, and p50/p95 over a 600 s window against an
  RPC twin. Self-provisioning, no OpenTofu state. Measured 2026-10-10; see its
  RUNLOG.
- `lifecycle-ops` - the status page as a per-region change gate, create
  through a region-fallback wrapper with an abandoned and re-sent POST, and an
  n = 5 restart envelope over REST, Auth, Storage, pooler and direct
  (LO01, LO03-LO05). Self-provisioning, no OpenTofu state. Measured 2026-10-10; see
  its RUNLOG.
- `restore-paths` - restore paths on Pro and Free: which exist through the
  Management API, PITR restore per-path outage, which database password and
  whether Storage survive, and Free pause and unpause timing (RP01-RP03).
  Self-provisioning. Measured 2026-10-10; see its RUNLOG.
- `pooler-checkout` - Supavisor transaction-pool exhaustion
  (`ECHECKOUTTIMEOUT`), fallback to session, direct and dedicated poolers,
  node-postgres, postgres.js and Prisma behaviour under a TCP reset, and an
  `aws-0` host lint. Self-provisioning, Micro. Measured 2026-10-10; see its
  RUNLOG.
- `jit-db-access` - temporary token-based database access: grant a role with
  an expiry through the Management API, log in with the PAT as the Postgres
  password through the shared pooler and the direct path, and measure expiry
  (epoch seconds enforced; the docs' millisecond example does not expire),
  revocation (new logins stop, open sessions survive), `allowed_networks` on
  the pooler path, and what postgres_logs and supavisor_logs record.
  Self-provisioning, no OpenTofu state. Measured 2026-10-10; see its RUNLOG.
- `client-retries` - what the supabase-js PostgREST retry policy does on the
  wire (statuses, methods, `Retry-After`, opt-out names per version, timeouts)
  and two client policies that the built-in retries lack: a deadline plus one
  hedged GET, and refresh-then-retry on a 401. Self-provisioning (CR01, CR02);
  CR03 and CR04 need no project. Measured 2026-10-10; see its RUNLOG.
- `hostname-path` - a custom hostname on a Pro project: OAuth callback, `iss`
  and SDK URL hosts (HP02-HP05), resolution through six paths and a local
  NXDOMAIN-on-`supabase.co` rig with an app on the custom hostname
  (HP06-HP07), and phase-split latency (HP08). Self-provisioning; needs
  Cloudflare DNS and Docker. Measured 2026-10-10; see its RUNLOG.
- `storage-surface` - the Storage direct-SQL delete guard and orphaned
  objects, list v1 against cursor v2 at depth, and S3-endpoint handling of
  special-character keys with the AWS SDK v3. Self-provisioning; SS01, SS02.
  Measured 2026-10-10; see its RUNLOG.
- `pipelines` - Supabase Pipelines (public alpha): what a PAT can reach
  (nothing of the managed service), and replication behaviour of the
  open-source engine against a Pro project with a local DuckLake destination:
  initial copy, lag against batch wait, RLS, DDL propagation, duplicates after
  a forced restart, and retained WAL and slot invalidation while stopped
  (PL01-PL08, PL99). Run: `make -C experiments/pipelines run`. Measured
  2026-10-10; see its RUNLOG.
- `orioledb` - hosted OrioleDB against heap: redundant-writes counters, bloat
  after repeated UPDATEs, a pgbench pair, per-table access methods, what
  refuses or crashes on an OrioleDB table, PITR, logical replication and
  Realtime. Live, about five small projects in a Pro org. Measured 2026-10-10;
  see its RUNLOG.
- `branching-nogit` - branching without git: a change written to a git-less
  branch through the SQL route reaches `GET /diff` but not the parent on `POST
  /merge`; the same objects through the migrations route do (BN01-BN03).
  Self-provisioning, Pro org. Measured 2026-10-10; see its RUNLOG.
- `replica-routing` - where the API load balancer sends a GET with a
  cross-region read replica, read-your-writes after a write, and
  `max_standby_streaming_delay` cancellation of a long replica query (RR01).
  Self-provisioning, Pro org. Measured 2026-10-10; see its RUNLOG.
- `scoped-pats` - what a scoped personal access token can create, read and
  write through the Management API: creation surface, a per-permission matrix
  from the OpenAPI `x-fga-permissions`, the SQL read-only boundary, CLI
  `whoami`, and the per-route rate-limit header. Token-dependent modules
  self-skip until `PVLAB_SCOPED_PAT_*` are supplied. Measured 2026-10-10; see
  its RUNLOG.
- `free-email-templates` - whether new free-plan projects can edit auth email
  templates through the Management API, on default SMTP and on dummy custom
  SMTP, with a Pro-org control (FE01, FE02). Self-provisioning. Measured
  2026-10-10; see its RUNLOG.
- `mgmt-api-faults` - a fault-injecting proxy in front of api.supabase.com:
  retries on 5xx and 429, partial apply and orphaned state, and duplicate
  POSTs, for the supabase CLI, the OpenTofu provider and the harness client
  (MF01-MF05). Measured 2026-10-10; see its RUNLOG.
- `pg-minor-17-11` - the 17.6 to 17.11 and 15.14 to 15.19 minor on four
  extension behaviours the changelog flags (pgcrypto legacy ciphers,
  non-built-in operator estimators, btree_gist NaN, ltree), measured on the
  public images in local Docker. Measured 2026-10-10; see its RUNLOG.
- `cli-surface` - Supabase CLI 2.120.0: pg-delta against migra by catalog
  fingerprint, a declarative sync round trip, `config pull`, `pull` and linked
  diff on a throwaway project, and the experimental native stack in a
  container with no Docker (one stack, three worktrees, drift).
  Self-provisioning. Measured 2026-10-10; see its RUNLOG.
- `self-hosted-defaults` - a local rig on a pinned supabase/supabase `docker/`
  checkout that asserts the 2026 defaults against a running stack: the Envoy
  gateway (no Kong, no 8443, with a Kong-override control), `sb_` keys through
  Envoy and the role PostgREST sees, Postgres 17 with `pg_graphql` off, Studio
  and postgres-meta as `postgres`, logs only via `docker-compose.logs.yml`,
  and `API_EXTERNAL_URL` with `/auth/v1` and SAML at `/auth/v1/sso/saml/*`
  (SD01-SD08). No project, no PAT, no cloud spend. Measured 2026-10-10; see
  its RUNLOG.
- `multigres` - Multigres OSS failover: kill the primary under a write load
  (postgres crash, cell loss, hung primary, lagging standby), count
  acknowledged-but-lost commits against a client-side commit log, plus the
  pooler feature matrix through the gateway. Local Docker, no cloud resources.
  Measured 2026-10-10; see its RUNLOG.
- `terraform-edge-functions` - the OpenTofu `supabase_edge_function` and
  `supabase_edge_function_secrets` resources with 24 functions at
  `-parallelism=24`: tofu reports 25 created, the API lists 3 to 5, the rest
  answer 200 but are not listed; updates land with exit 1; a width-24 destroy
  leaves the listed functions in place and empties state. `-parallelism=1`
  is clean. Measured 2026-10-10; see its RUNLOG.

## Ad-hoc platform probes (no experiment dir)

Small Management API probes that never graduated to an experiment. Full
write-ups publish to lexicanum (erfi.dev).

- **Branching: clearing a persistent branch's git link** (2026-08-21) -
  `PATCH /v1/branches/{id}` with `{"git_branch":""}` detaches a persistent
  branch from its git branch without delete/recreate (empty string clears;
  `null` is silently treated as field-absent). A/B: linked push -> `Supabase
  Preview` check run `in_progress` + branch redeploys; unlinked push -> check
  run `skipped`, branch untouched. Reversible by setting the name back; the
  CLI path is `supabase branches update <name> --git-branch ""`. Adjacent:
  `DELETE` on a persistent branch 400s - PATCH `persistent:false` first.
  Guide: https://erfi.dev/guides/supabase-branch-detach-git-link/

- **logs.all -> logs Management API migration dry-run** (2026-08-22;
  `logs.all` removed 2026-09-23) - probed on a standing project. Old
  `logs.all` still serves BigQuery dialect today (rejects ClickHouse
  `count()`); new `logs` is ClickHouse-only and GET-only (POST 404s). The
  official migration guide's example is WRONG: `WHERE source_name =
  'edge_logs'` fails with `Field "source_name" does not exist` - the real
  column is `source` (the OpenAPI description says `source`; the changelog
  example says `source_name`). Working minimal migration:
  `SELECT timestamp, event_message FROM logs WHERE source = 'edge_logs'
  ORDER BY timestamp DESC LIMIT 3`. Also measured: `log_attributes['key']`
  map access replaces BigQuery `unnest(metadata)` (which now errors);
  `SELECT *` fails (explicit columns required); `timestamp` changes from
  microsecond int to ISO string; dialect/parse failures return HTTP 200 in
  the `{result,error}` envelope (`Backend error! Retry your query.`);
  no deprecation/sunset header on `logs.all`; `x-ratelimit-limit: 10`.
  Sources seen: edge_logs, postgres_logs, pgbouncer_logs, storage_logs,
  realtime_logs. Lab callers until 2026-10-10 were edge-resilience W27, security-lockdown
  S18 and data-api-reenable DA02L; all three were ported to the unified `logs`
  endpoint that day and `logsAllQuery` is deleted (the s2z-wake surface list
  keeps its `logs.all` readings as pre-2026-09-23 history).
  Full write-up: https://erfi.dev/guides/supabase-management-api-logs-endpoint/

## Setup (once)

```sh
aws configure sso            # or export AWS creds - none configured on a fresh box
make secrets-decrypt         # writes secrets.tfvars from secrets.enc.tfvars
```

On a fresh machine, restore the age private key to `~/.config/sops/age/keys.txt`
(mode 600) before the decrypt - that default path is the only thing sops looks at
here, so no shell wrapper or `SOPS_AGE_*` export is needed and `make` works
non-interactively. Without the key the decrypt just fails; `.sops.yaml` carries
only the public recipient. To give someone else access, add their age public key
as a second recipient in `.sops.yaml` and re-run `make secrets-encrypt`.

`secrets.tfvars` holds: Supabase PAT, org id, AWS account id, DB password,
break-glass CIDR, and optionally the AWS access key pair. Edit +
`make secrets-encrypt` to update the committed copy.

AWS auth works two ways. Fill `aws_access_key_id` / `aws_secret_access_key`
in `secrets.tfvars` and the provider uses them directly - highest precedence
in the AWS chain, so a stale key pair exported in your shell cannot break the
run. Leave them empty and everything falls back to the ambient chain
(`aws configure sso`, a named profile, or env vars). Either way the Makefile
exports the same values for the `aws` CLI calls, so tofu and the CLI never
disagree.

`make suite` passes the DB password and PAT to the runner inside the SSM
`send-command` payload - nothing secret is baked into the instance, but SSM
keeps command parameters in history for ~30 days. That is an accepted
tradeoff for a throwaway project destroyed the same day; use Parameter Store
SecureString or Secrets Manager with an instance-role read if you lift this
pattern into an environment that outlives the test.

## Running an experiment (privatelink-aws)

```sh
cd experiments/privatelink-aws
tofu init
make phase1          # project + PrivateLink association
make wait-ready      # polls association status (needs a dashboard session JWT - PATs get 401; or just watch the dashboard)
make arns            # RAM share + resource config ARNs -> arns.tfvars
make phase2          # VPC, endpoint, PHZ, runner
make suite           # typed harness, both vantages: connectivity, TLS modes,
                     # latency/pgbench, Data API, CLI migration paths, ceiling,
                     # Lambda; merges into evidence/<ts>/REPORT.md
make destroy         # when done - NAT + endpoint are the hourly costs
make suite-clean     # remove the suite artifact bucket (not tofu-tracked)
```

`./suite.sh --destructive` adds the tests that mutate or interrupt the
environment (project restart, endpoint replacement). They are deferred to the
end so the read-only battery always produces results first.

Suite evidence lands locally in `experiments/privatelink-aws/evidence/<ts>/`
(gitignored): `REPORT.md` plus the raw JSON artifacts from both vantages. The
harness compiles to a single binary that is staged to the runner over an S3
presigned URL, so nothing test-related is baked into the AMI. For interactive
work, `make ssm` gives a shell on the runner where `pvlab --where runner` can
be re-run by hand.

See `experiments/privatelink-aws/RUNLOG.md` for what each run established
and the measured numbers.

## Cost note

NAT gateway + VPC endpoint + t3.micro is roughly $2.50/day. The lab is
designed to be applied and destroyed within a day. The Supabase project is
deleted with `make destroy` (it is a tofu resource).
