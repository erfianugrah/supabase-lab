# AGENTS.md - supabase-lab

Disposable e2e validation environments for Supabase platform behaviour.
Methodology: validate empirically on throwaway infra before asserting
platform behaviour or writing it into docs
(see ~/.pi/agent/skills/validating-empirically/SKILL.md and
~/.pi/agent/skills/sa-pov/SKILL.md).

## Layout

- One experiment = one directory under `experiments/<name>/` = one OpenTofu
  state (dir-per-blast-radius, per ~/.pi/agent/skills/terraform/SKILL.md).
- Shared secrets: root `secrets.enc.tfvars` (SOPS+age, committed) ->
  `make secrets-decrypt` -> `secrets.tfvars` (gitignored). Experiment
  Makefiles wire it in with `-var-file`.
- Per-experiment non-secret config: `experiment.tfvars` (committed).
- No provisioning scripts: everything is OpenTofu resources. The only shell
  payload is Makefile/suite orchestration (phase gating, ARN lookups, SSM,
  S3 staging); the tests themselves are the typed harness, not shell.
- ONE registry covers every experiment: `harness/scripts/gen-registry.ts` scans
  `experiments/*/tests` with no argument, and selection happens at run time
  (`--only`, `--where`, capability gating). Do not go back to passing one
  experiment's dir at build time: the generated registry (gitignored) is what
  the compiled binary can reach, so a per-experiment build made `dist/pvlab`
  carry whichever experiment was built last and silently could not run the
  others. Registering all of them costs nothing - a test whose project ref is
  absent self-skips with a reason. Pass `--experiment <name>` so the report
  titles itself correctly.
- Tests live in `harness/` (shared contract + runner + report renderer) and
  `experiments/<name>/tests/*.ts` (the test modules). Adding a test is ONE
  file exporting a `TestModule`: `where` picks the vantage (runner vs local
  orchestrator), `requires` gates on capabilities so it self-skips with a
  reason, `destructive` defers it behind `--destructive`, and anything in
  `measurements` becomes a report column with no renderer change.
- Multi-project experiments carry their other refs in `ctx.peers`, keyed by an
  experiment-defined role, populated from `PVLAB_PEER_<ROLE>`. Reading
  `process.env.SOME_OTHER_REF` inside a test works and was how the first
  two-project experiment did it, but it puts the run's shape outside the
  context object whose whole job is to describe it, and the second and third
  experiments would each have invented their own variable name. Same for
  `ctx.orgSlugs` (`PVLAB_ORG_SLUGS`). Both gate capabilities (`peer`, `org`),
  so a missing ref is a skip with a reason rather than a probe against an
  empty string. An env var set to empty counts as absent - a Makefile
  interpolating a missing tofu output exports exactly that.
- Probe targets live in `ctx.endpoints`, keyed by an experiment-defined role and
  populated from `PVLAB_ENDPOINT_<ROLE>` - same reasoning as `peers`/`orgSlugs`,
  and the third time that lesson came up, so it is general rather than three
  named fields. `PVLAB_ENDPOINT_POOLER` also gates the `pooler` capability.
  `PVLAB_ENDPOINT_IPS` is deliberately excluded (it predates this and is parsed
  on its own).
- `harness/src/sampler.ts` samples several connection paths independently while
  an operation runs, and returns one scalar window per path. It exists because
  measuring a platform operation means separating "what operation" from "what
  paths" from "how we time it" - t14-restart.ts interleaves all three, which is
  why it measures one path at 5s resolution. Recovery requires `settleMs` of
  SUSTAINED success: a pooler queues before it refuses, so one lucky sample
  mid-outage is not recovery. A run where nothing fails deliberately burns the
  full `maxWaitMs` - a null result has to be earned by waiting, not assumed.
- `pvlab --diff prev.json,cur.json` compares two run artifacts at the
  (test id, measurement key) level and writes `diff.md`. Offline by
  construction - dispatched before `buildCtx`, so it needs no PAT and touches no
  network. Do NOT diff the rendered reports instead: they carry timestamps, a
  lab commit and per-test durations, so every re-run diffs dirty and the one
  entitlement that moved is buried. Only `measurements` is compared; TestResult's
  own fields are run metadata.
- One Management API client for everyone: `harness/src/mgmt.ts`. It does not
  use `res.json()`, because api.supabase.com answers aggressive polling with a
  Cloudflare HTML interstitial rather than a JSON 429; `classifyBody` reports
  that as `throttled` so a retryable condition stops being recorded as a test
  bug. Three experiments had their own copy of this before it moved here.
- A measured `fail` is data, not an error to retry away. The suite records
  outcomes; it never drives the external system to green.
- Test ids sort within the destructive tier, so id order IS execution order.
  Where a negative control must precede the thing it makes interpretable
  (vault-root-key V02 before V03), that ordering lives in the ids, not in the
  Makefile - do not reorder them for tidiness.
- `bun build --compile` bundles only statically-reachable code, so the test
  registry is GENERATED at build time (`harness/scripts/gen-registry.ts`).
  Never hand-edit `src/tests.generated.ts`; `bun run build` rewrites it.

## Conventions

- `tofu`, never `terraform`. Plan-to-file then apply the file.
- Provider majors pinned in `providers.tf`; `.terraform.lock.hcl` committed.
- No secrets in `.tf`/`experiment.tfvars`; sensitive vars marked `sensitive`.
- Nothing account- or engagement-specific in this repo; it is built to be public.
  Evidence gets generalised: no org names, no account IDs, no project
  refs, no internal ticket IDs, no named individuals.
- Committed ciphertext is permanent: this repo is public, so anything in
  `secrets.enc.tfvars` stays downloadable at that commit forever. If a
  secret is exposed, **revoke the secret** - rotating the age key does not
  help, because the old key still decrypts the old commits. Keep live
  credentials out of the committed file when the run is over; the checked-in
  copy should decrypt to placeholders, not to a token someone has to
  discover is dead.
- AWS creds: either in `secrets.tfvars` (`aws_access_key_id` /
  `aws_secret_access_key`, encrypted at rest with everything else) or left
  empty to use the ambient chain (profile / SSO / env). Provider-block
  credentials are the highest-precedence entry in the AWS chain - verified:
  bogus keys in the provider block beat valid env vars - so filling them in
  makes a run immune to a stale `AWS_ACCESS_KEY_ID` in the shell, which
  otherwise fails every call with `InvalidClientTokenId`. The experiment
  Makefile exports the same two values for the `aws` CLI calls it shells out
  to, so tofu and the CLI share one source of truth; empty exports are
  ignored by the CLI and neutralise an inherited stale pair.
- Secrets reach the runner only at invocation time, inside the SSM
  `send-command` payload (`suite.sh` reads them from `secrets.tfvars`).
  Nothing secret is baked into user_data or the AMI, and the runner holds
  no AWS credentials (gocurl in via presigned GET, artifacts out via
  presigned PUT). Caveat this lab accepts and a customer environment must
  not: SSM retains command parameters in history (~30 days, readable via
  `aws ssm list-commands` and CloudTrail), so the DB password and PAT are
  recoverable by anyone with SSM read on the account. Fine for a
  same-day-destroyed throwaway project; for real environments put the
  secret in Parameter Store SecureString / Secrets Manager and read it
  with the instance role so it never transits the payload.
- `evidence/` is gitignored - reports carry hostnames, ENI IPs, and
  project refs.
- Unencrypted `*tfvars*` are blocked by a SOPS pre-commit hook;
  `.allow-unencrypted-paths` allowlists the two that are legitimately
  plaintext (`secrets.example.tfvars`, `experiments/*/experiment.tfvars`).
- Never commit tofu plan files (`tfplan*`): they are zip archives that
  embed tfstate including all variable values (i.e. every secret).
  `.gitignore` covers them; verify with `git status` before committing.

## experiments/privatelink-aws - key facts (validated at runtime; see RUNLOG.md)

Platform/API:

- PrivateLink association API is NOT in the published /v1 Management API
  spec, and the undocumented `/platform` routes reject PATs
  categorically (401 "JWT could not be decoded", even owner-role sbp_
  tokens) - confirmed for the association POST, the associations GET,
  and entitlements. Association is created via the dashboard (3 clicks,
  CREATING -> READY in ~2min); restapi_object stays gated behind
  `var.send_association` (default false). Studio source
  (apps/studio/data/aws-accounts/) documents the intended shape:
  `POST /platform/projects/{ref}/privatelink/associations/aws-account`,
  statuses CREATING | READY | ASSOCIATION_ACCEPTED |
  ASSOCIATION_REQUEST_EXPIRED | CREATION_FAILED | DELETING.
- The PrivateLink UI is gated on a per-org feature flag PLUS a
  server-side entitlement; a fresh Team org shows neither until both
  are granted (beta). eu-central-2 is excluded from PrivateLink.
- supabase TF provider (supabase/supabase ~> 1.10) has NO privatelink
  resource; `supabase_settings.network` (restrictions JSON) verified:
  shape applies clean and survives public-access closure to a /32
  (T12/T12b = full public DB lockout story).

AWS side:

- `aws_vpc_endpoint` with `vpc_endpoint_type = "Resource"` +
  `resource_configuration_arn` is the consumer side; there is NO data
  source for a shared Lattice resource configuration (ARN via
  `aws ram list-resources`, `make arns`), and RAM acceptance must
  happen before the resource is visible - chicken-and-egg, so
  `aws_ram_resource_share_accepter` was removed.
- Resource-type endpoints do NOT expose `dns_entry` (confirmed) - the
  PHZ apex A record carries the endpoint ENI IPs (TTL 60); the ENI data
  source forces a two-pass phase2 (for_each over unknown keys).
- Endpoint SG needs BOTH 5432 and 6543 inbound; the public setup
  guide's examples are 5432-only (known doc gap).

Measured (micro, ap-southeast-1; evidence/20260731-175026/REPORT.md):

- Connect p50: private-5432 37ms, private-6543 31ms. pgbench: direct
  3810 tps, private pooler 3350 tps vs public Supavisor 2258 tps.
- verify-full works via the PHZ name (endpoint cert CN+SAN =
  db.<ref>.supabase.co); against the raw endpoint IP it fails by design.
- `link --skip-pooler` is the load-bearing CLI fact (T09): default link
  targets the public shared pooler.
- Supavisor transaction mode supports prepared statements now (T11) -
  the old assumption is stale.
- PostgREST root `/rest/v1/` requires service_role on the current
  platform; anon probes need a real table (SQL-created tables get anon
  SELECT via default privileges, no RLS).
- Pooler client ceiling on Micro: NOT a reproducible number. PgBouncer
  queues before it refuses; isolated quiet-system probes gave first
  refusal at client 213 (run 6) and 287 (run 7), against a published 200.
  Quote the shape and the mechanism (`max_client_conn`), not an integer.
- Restart down window over the endpoint: 49/72/131s by psql probe,
  59/93s through a Lambda on 6543 (failure mode: `timeout expired`, not
  a refusal).
- Direct endpoint is IPv6-only; from an IPv4-only VPC there is no
  public-direct path (IPv4 add-on exists but is moot under PrivateLink).

## experiments/http-tier-lockdown - key facts (validated 2026-08-02)

One project, no AWS. PrivateLink settles the DB socket; this settles what
can be done about the managed HTTP tier on `<ref>.supabase.co`.

- Data API "disable" has NO published /v1 lever. `PATCH
  /v1/projects/{ref}/postgrest` accepts `db_schema: ""` (200), but the
  result is a WEDGED PostgREST, not a disabled one: anon reads return
  `503 PGRST002 "Could not query the database for the schema cache.
  Retrying."` within 6-8s, steady for at least 120s, `/graphql/v1` 503 with
  it, and `/rest/v1/` root keeps answering 401 (gateway unaffected).
  Restore takes 1-2s. Do NOT sell this as the Dashboard toggle's
  equivalent - the toggle stays Dashboard-only, like the PrivateLink
  association.
- Realtime `private_only` IS a documented lever (`PATCH
  /v1/projects/{ref}/config/realtime`, 204) and takes effect in ~9s, but it
  is an AUTHORIZATION control, not a network one: the anon WebSocket
  handshake still succeeds, and the refusal arrives in the join reply
  (`"PrivateOnly: This project only allows private channels"`). It narrows
  what a connected client may do; it does not remove the endpoint.
- Auth and Storage have no equivalent toggle.

## Provisioning: ACTIVE_HEALTHY is not readiness (validated 2026-08-03)

Affects every experiment here, since they all create projects.

- The project's aggregate `status` flipping to `ACTIVE_HEALTHY` does not mean the
  services are usable. Poll `GET /v1/projects/{ref}/health?services=auth&services=rest&services=db`
  per service instead, as the Supabase-for-Platforms guide says.
- That is still not sufficient. On 2 of 2 fresh projects, all three services
  returned `ACTIVE_HEALTHY` on the FIRST health poll and the first
  `POST /auth/v1/admin/users` call nonetheless failed with
  `500 "Database error checking email"`, succeeding about ten seconds later.
  Retry the first write with backoff; do not treat its failure as a finding.
- New projects carry BOTH key pairs: legacy `anon` / `service_role` JWTs and the
  newer `sb_publishable_` / `sb_secret_` keys. Select by `name` OR `type` when
  reading `/api-keys?reveal=true`, or a script that assumes one shape sends a
  non-JWT as a bearer and gets `PGRST301 "Expected 3 parts in JWT; got 1"`, which
  reads like an auth finding and is not.

## experiments/cross-project-auth - key facts (validated 2026-08-03)

Two projects, no AWS. Can one project's identity be trusted by another, so a
tenant keeps its token across a move? See RUNLOG.md.

- Third-party-auth config shapes: `oidc_issuer_url` and `jwks_url` BOTH
  resolve, on the create response (tens to low hundreds of ms), to identical
  key material. `custom_jwks` is accepted with 201 and never resolves
  (`resolved_at` null past 92s) - reproduced on a fresh project pair, so the
  earlier hand-rolled-SFP finding was not environmental. Pick either working
  shape on grounds of which URL you prefer to hard-code, not capability.
- The response `type` is `custom` for all three shapes: it does not tell you
  which shape created an integration. Read the three fields.
- Cross-project portability holds, and is attributable: the SAME token is
  refused with `401 PGRST301` before trust exists, accepted about a second
  after the integration is created, reads a copied slice with no re-login, and
  is refused again under a second after the integration is deleted. Holding the
  token constant and varying the target's config is the stronger form of the
  foreign-key control the earlier lab ran - it also rules out the two tokens
  differing in some untracked way. An anon-bearer control, by contrast, proves
  nothing: anon is signed by a key the target trusts and is stopped by RLS.
- Trust revocation is prompt in the same way trust creation is. Neither is
  synchronous with the API call; both land well inside two seconds.
- Load-bearing for any "the tenant is now independent" claim: refresh still
  goes to the ISSUING project's `/token` endpoint. The spoke can verify, not
  mint. Measured outside this repo since - a refresh presented to the trusting
  project answers `400 refresh_token_not_found` - but there is still no test
  module for it here, so treat it as reported, not reproducible. Worth a X0n.

## experiments/tenant-consolidation - key facts (validated 2026-08-04)

Three projects, no AWS. The direction the corpus does not cover: many
per-customer projects merged INTO one shared multi-tenant project. See RUNLOG.md.

- Merging is not promotion run backwards. Splitting a project cannot produce a
  collision; merging two independently provisioned ones produces one for every
  namespace they both allocated from - addresses, surrogate keys, sequences.
- The auth-schema copy works many-to-one (34 non-generated columns), preserves
  the uuid AND the password, and needs no `auth.identities` rows - but it is
  not necessary. `POST /auth/v1/admin/users` accepts `password_hash` (the `$2a$`
  string straight from the source), honours a supplied `id`, and sets
  `app_metadata` at creation. The documented surface does the whole job.
- `users_email_partial_key` is `UNIQUE (email) WHERE (is_sso_user = false)` - a
  btree over the RAW column. The admin endpoint normalises case and refuses a
  variant with 422 `email_exists`; a SQL copy does not, so it lands two rows for
  one human. Which of the two a login then reaches is NOT stable: over five
  attempts per casing, both accounts were reachable from both input strings and
  the mapping changed mid-sequence. That is a cross-tenant exposure, not a
  cosmetic duplicate.
- One duplicate costs the whole customer: a single INSERT is atomic, so the
  second source contributed 0 of its 2 users.
- `primary key (tenant_id, id)` merges both sources with ids intact. The first
  write AFTER the merge still collides - the merged table's sequence starts at
  1 - and that surfaces on the first real write, not during the migration.
- Two RLS results worth carrying into any review: a FOR ALL policy with only
  `using` DOES govern writes (Postgres reuses the expression as the check, so
  the usual "omit with check and writes are open" is wrong for that shape), and
  PostgREST's default `return=representation` reports a permitted write as
  403 42501 because RETURNING is filtered by the SELECT policy. Test writes
  with `return=minimal` and count rows server-side, or the hole reads as closed.
- The management query endpoint connects as `postgres`, so it sees every row
  while a tenant sees none. Verifying data landed says nothing about isolation.

## experiments/key-rotation - key facts (ported 2026-08-04, findings from 2026-08-03/04)

Hub and spoke: the hub's GoTrue is the spoke's third-party auth issuer, and the
hub rotates its signing key. Ported from bash that produced the findings below;
the port has NOT been run live yet, so treat it as a mechanism awaiting its first
run rather than a source of measurements.

- The window belongs to the CONSUMER's cache, not the issuer's publication. The
  hub published the new kid in its own JWKS in about 7 minutes; the spoke's
  cached kid set held exactly one entry across 282 probes and 37 minutes and
  never re-resolved. Re-creating the integration does not help - it re-caches
  the same stale set.
- A token signed by the old key keeps working through `previously_used` AND
  through `revoked` - still 200 sixteen minutes after revocation, with the key's
  status re-read immediately before each probe.
- Standby-key creation is rate limited on a fresh project: `Please wait until
  <ISO8601>`, measured at 144 s, 127 s and 131 s. Wait the deadline out; do not
  retry past it.
- Every probe records four fields - PostgREST error code, the spoke's cached kid
  set, the hub's published JWKS, and the token key's status at that moment. A
  sensor fails if any goes missing, because capturing only HTTP status is what
  left the original anomaly (G34) unexplained. Do not let `pgrst_code` fall back
  to the HTTP status; that conflation is the thing the four fields prevent.
- R03 mints its token while the key is still active, THEN rotates and revokes.
  An earlier draft re-promoted the key it was about to revoke, which adds two
  rotations the measured protocol never had - and they perturb the consumer
  cache under test, so a non-reproduction would have been the harness's fault.
- Windows and intervals are configurable. The live ones are 20 and 15 minutes.

## experiments/tenant-promotion - key facts (validated 2026-08-04)

Two projects, no AWS. The direction consolidation runs backwards: one tenant
moved OUT of a shared project into its own, and whether a client follows it.
Ported from throwaway bash that produced the same findings; see RUNLOG.md.

- A client that reads its placement from a registry at runtime follows the move
  with ZERO password logins - the refresh token it already held mints a session
  at the destination once the auth rows are there, and the `sub` matches on both
  sides. The two controls are what make that mean anything: the other tenant is
  unaffected, and the source still serves afterwards. Promotion is a copy, not a
  cutover, so both projects answer for the tenant until the source identity is
  retired.
- Retiring it is one `DELETE /auth/v1/admin/users/{id}`, and it closes BOTH
  issuing paths at the source (password grant `invalid_credentials`, the old
  refresh token `refresh_token_not_found`) while the destination carries on. The
  tenant's ROWS stay behind. Identity retires, data does not.
- MFA survives the copy. A TOTP factor enrolled and verified at the source
  arrives `status: verified`, and the SAME secret produces a code that verifies
  at the destination for an `aal2` session. Without this the zero-re-login
  result would silently exclude every MFA-enrolled account.
- `auth.refresh_tokens.user_id` is `character varying` while `auth.users.id` is
  `uuid`, so a subquery predicate errors instead of matching. Combined with the
  fact that inserting zero rows SUCCEEDS, that presented as a copy reporting a
  pass having moved nothing - `copyTable` now returns the dump result so a
  failed read cannot look like an empty source.
- Do not carry the source's `auth.refresh_tokens.id`. It is a bigserial, and a
  destination with any prior auth activity already holds the low ids, so the
  insert dies on `refresh_tokens_pkey`. Let the destination assign it; the token
  string is what the client presents. If you DO carry ids, the sequence resync
  is mandatory rather than belt-and-braces, and the collision it prevents
  surfaces on the tenant's NEXT refresh, not during the promotion.
- Ref-hiding does not need a proxy in the data path. The vanity-subdomain
  endpoints activate a tenant-facing hostname that contains no project ref
  (`check-availability` answers 201, not 200, and wants a bare LABEL - a dotted
  hostname is rejected before availability is evaluated).
- Emails are randomised per run: `adminCreate` 422s on a duplicate address, so a
  module with a constant address passes exactly once against a given pair.

## experiments/platform-downtime - key facts (validated 2026-08-04)

- What a platform OPERATION costs a client, per connection path. All windows
  below sampled at 500 ms, all n=1, one Micro project in ap-southeast-1.
- **REST and Realtime never failed under ANY of the four operations** measured
  (restart, restriction flip, resize up, resize down) - zero failed samples at
  500 ms. One operation could be luck; four is a pattern.
- **The paths do not move together.** On restart: Auth 75 s (`HTTP 521`),
  Storage 78 s (`HTTP 500`), pooler 158 s, REST and Realtime untouched. An app
  whose read path is PostgREST may not notice a restart; one signing users in
  during the same window fails for over a minute. This refines T14, which
  measured one path at 5 s resolution and reported a single number.
- **A resize costs about twice a restart** - Auth 131 s resizing up against
  75 s restarting, pooler 207 s against 158 s. Budget a maintenance window off
  the restart number and you will under-budget.
- Resize asymmetry is half real: on the HTTP tier growing costs about a third
  more than shrinking (Auth 131 s up, 99 s down); on the pooler the two are
  within 5 % (207 s / 196 s).
- Compute size is an ADDON mutation, `PATCH /v1/projects/{ref}/billing/addons`
  with `{addon_variant, addon_type: "compute_instance"}` - there is no resize
  endpoint. Variants `ci_micro`..`ci_48xlarge`; that enum is the API surface,
  not the entitlement. Returning to micro REMOVES the addon (the GET then
  reports null), because micro is the absence of one.
- **The pooler reports a DIFFERENT error for each operation**, so the mode says
  which operation is underway: restart `{:error, :timeout}`, restriction
  `EADDRNOTALLOWED ... allow_list`, resize up `{:error, :econnrefused}`, resize
  down `terminating connection due to administrator command`. Only the last is
  a Postgres message - Supavisor is alive through all four, and what varies is
  how the backend is unavailable.
- The pooler is down roughly TWICE as long as the HTTP tier, and its error
  (`Failed to connect to database: {:error, :timeout}`) says Supavisor is alive
  and waiting on Postgres behind it, not that the pooler died.
- **A network restriction does not touch the HTTP tier.** Locking the database
  to a CIDR that excludes you leaves REST, Auth, Storage and Realtime serving -
  they reach Postgres from inside. It DOES reach the pooler: Supavisor enforces
  the allow-list against the client address, so 6543 is covered, not only direct
  5432. It bites ~1 s after the API returns 201 and the refusal names the
  rejected address.
- A destructive module that restores state must restore INSIDE the sampled
  operation. The first D02 restored in a `finally`, so recovery happened after
  sampling stopped and every run reported "never recovered" - it could prove a
  restriction bites and measure nothing else.
- Report time-to-bite separately from outage duration. They are different facts,
  and the first survives a run that ends before recovery.
- **Bun does not implement ws's `unexpected-response` event.** A 4xx upgrade
  arrives as `error: failed: Expected 101 status code` with no status, so a
  WebSocket probe cannot tell "answered 401" from "dead" under this runtime
  (verified against a live project: curl gets 401, ws gets the string). Do not
  add that handler back expecting it to fire.

## experiments/platform-facts - key facts

- Not a behaviour test: a dated snapshot of the platform constants that docs
  quote as bare numbers (compute prices, connection counts, plan entitlements,
  key shapes, default Postgres major). Built to be re-run and DIFFED - and
  since `pvlab --diff` exists, diffing it is one command rather than an eyeball.
- The region catalogue IS machine-readable (F04c, correcting the original F04a
  negative, which probed name-guessed paths and concluded absence):
  `GET /v1/projects/available-regions?organization_slug=<slug>` returns
  `{ recommendations, all: { smartGroup[], specific[] } }` - 17 specific + 3
  smart groups on a Team org. A bare call without the org slug answers 400,
  and `/regions`, `/platform/regions`, `/projects/regions` all still 404. The
  `recommendations` block is the platform's capacity pick - smart-group
  behaviour made visible. Lesson recorded in the F04 RUNLOG: F04a fell into
  the name-guessing trap two days before F05's enumerate-the-whole-spec method
  was written down.
- Organization membership is READ-ONLY on the stable API (F05). Enumerated from
  the published OpenAPI document rather than probed: across 169 operations there
  is exactly one membership operation, `GET /v1/organizations/{slug}/members`,
  and the only two org-scoped writes are org creation and project-claim. The
  `jit/invite` endpoints that a keyword search turns up are DATABASE access, a
  different subsystem - do not read them as membership provisioning.
- **The upgrade window is not measurable on a throwaway project** (F06). A newly
  created project comes up already at the latest app version - `eligible: false`,
  current == latest, no targets - and `postgres_engine` / `release_channel` on
  `POST /v1/projects` are both DEPRECATED and typed null, so an older one cannot
  be requested. Measuring a real client-visible upgrade window means upgrading
  something real. That is the structural reason the "upgrades take hours" claim
  stays unquantified.
- What IS free: `duration_estimate_hours` in the eligibility payload. Observed
  `1` for a patch-level app upgrade (17.6.1.141 -> 17.6.1.155) on three aged
  projects, each with one target and zero validation errors. It is a PUBLISHED
  ESTIMATE, not a measured outage - platform-downtime showed operation duration
  and client-visible window differ per path, sometimes 2x - and all three
  returning exactly 1 reads as a coarse figure. `eligible` can also come back
  `null` with no version fields; do not treat it as always-boolean.
- F05 reads the whole spec on purpose. A previous investigation concluded an API
  "cannot do X" after probing only paths containing X's noun and was wrong,
  because the lever sat on a differently-named path. A negative is only worth
  stating across the complete operation set.
- Most results are `info` on purpose. There is no correct value for a price,
  so asserting one manufactures a failure every time the platform legitimately
  changes. Only the three shape claims assert.
- F03's live-token control is not optional. 404 on every scope candidate also
  describes a dead token or an outage; without the control returning 200 in the
  same run, the negative result is a `skip`, not a `pass`.
- Org slugs are a precondition (`make probe ORGS=a,b`), not a resource: the
  provider has no organization resource and plan changes are a billing action.

## experiments/vault-root-key - key facts

- Test ORDER is load-bearing and comes from the planner, not the Makefile:
  ids sort within the destructive tier, so V02 ("cannot decrypt without the
  key") always precedes V03 ("apply the key"). Reverse them and there is no way
  to tell "the key mattered" from "the ciphertext was portable all along".
- V03 probes several verb/path shapes rather than calling one. The doc it
  serves says "apply that value to the target project's pgsodium config" with
  no endpoint and no method, so the open question is whether ANY surface
  exists - and one guessed 404 would answer it confidently and wrongly.
- V03 checks EFFECT, not status code. A 2xx that changes nothing is a real
  failure mode here; `custom_jwks` in cross-project-auth returns 201, echoes
  the material back, and never resolves.
- The root key value never enters a measurement, a detail string, or evidence.
  Only length, character class, and a hash. `evidence/` is gitignored, but a
  live encryption root key does not belong in a file one `git add -f` from a
  public repo.
- V04 needs the source project GONE, so it is a separate pass
  (`make probe-deleted-source`). Deletion goes through `tofu -target`, not a
  DELETE call, so state stays truthful; the dead ref is captured BEFORE the
  destroy and passed as `PVLAB_DEAD_REF`, because afterwards the tofu output is
  empty and probing an empty ref returns a meaningless 404.

## experiments/edge-resilience - key facts (validated 2026-08-16)

- What a CLIENT can do about platform incidents. Full matrix in
  experiments/edge-resilience/FAILURE-MATRIX.md; consolidated reference in
  RELIABILITY.md at the repo root. 23 modules (W01-W13, W15-W24;
  W14 was a manual drill), all green, full battery 22/22 unattended in
  ~27 min via `.pi/probe-edge-resilience.sh W01,...,W24` (or
  `make battery` inside the experiment; lifecycle is `make up` /
  `make down`, not the AWS-style suite targets). W21 runs in the Pro org
  (ErfiCorp) and provisions/deletes its own project - it needs no drill
  pair and no `make up`.
- **PostgREST skew tolerance is exactly ~30s** as documented (W01): iat +30s
  accepted, +31s rejected with 401 PGRST303. Expired also PGRST303; unknown
  key PGRST301. The drill path for arbitrary-claim minting is a lab ES256
  issuer via TPA jwks_url (first-party secrets are not mintable).
- **JWKS trust lags config APIs**: ~30s cold after TPA registration (PGRST301
  until warm), instant (~300ms) for a previously-seen JWKS. jwt_exp changes
  take effect ~6.5s after acceptance. jwt_secret PATCH is a 200 NO-OP.
- **Managed->managed warm standby works** (W05): direct-host subscription
  cross-region, initial sync ~3.1-6.5s, lag 34ms-1057ms. Pooler cannot be the
  source (ENOIDENTIFIER tenant error). Sessions survive cutover via TPA-OIDC
  registration of the primary issuer on the standby - no secret copying.
- **CREATE SUBSCRIPTION must be a single-statement query** - the Management
  query endpoint wraps multi-statement strings in one transaction and
  Postgres rejects CREATE SUBSCRIPTION inside one. Dropping a subscription
  leaves its slot on the primary pinning WAL.
- **Cache proxies must strip Set-Cookie**: the gateway's CF front sets
  __cf_bm on every response and caches.default.put refuses it silently -
  a naive edge cache never caches. Cache-first serving makes an origin
  outage invisible for warm URLs (W04); cold URLs fail.
- **supabase-js 2.112.3 retries 5xx, not claim rejections** (W02): 1 attempt
  on PGRST303, 4 attempts/7s through 503s.
- **Cold DR floor** (W06): dump 12.4s / restore 6.4s for 10k rows via pooler.
- **Break-glass**: GET /projects/{ref}/postgrest returns jwt_secret (W07) -
  minting without GoTrue works; crown jewels, prefer TPA portability.
- **Concurrent refreshes both succeed** (W08) - naive multi-tab reuse does
  not break sessions.
- **Platform-managed schemas do not replicate** (W09/W14, supersedes the
  W09 worker-ceiling note): auth.* and storage.* stream zero changes
  managed->managed at ANY tested size (micro/small); public and custom
  schemas replicate fine (~4s). max_worker_processes is 6 on both sizes.
  Auth portability: TPA + SQL backfill + forced re-login.
- **DDL on the primary stalls ALL table replication** (W15) - even rows
  not using the new column; applying the same DDL on the standby resumes
  in ~6.1s with backfill, no subscription recreation. Migrate standby
  first.
- **Cutover trilogy** (W16/W17): sequences do not replicate (first insert
  duplicate-key; setval resync fixes); per-project auth config (SMTP,
  SITE_URL, jwt_exp, rate limits) does not follow a cutover - re-apply
  via mgmt API.
- **Edge function limits** (W13/W18): 150s idle wall clock (504
  IDLE_TIMEOUT); cold start is ~1.4s only on the first invoke after
  deploy+idle - steady-state cold/warm gap is ~100-200ms (p50 284 vs
  98ms).
- **Storage render path** (W19): 400 InvalidRequest on an invalid source,
  SVG passes through unchanged, and the plain URL always serves the
  original - never a 5xx.
- **Statement/lock timeouts** (W20): verbatim 57014 at 3467ms wall, 55P03
  at 4533ms wall via the Management query endpoint (session B) + psql
  via pooler (session A).
- **1M-row initial sync** (W22): 22.7s (12.5s in battery), streaming lag
  ~245-276ms after sync.
- **pg_cron resumes across a project restart** (W23), no catch-up
  doubling.
- **Tenant routing isolation + eject cost** (W25): a poisoned routing
  row degrades only its tenant (502 while others 200); ejecting a row
  from an env-var table costs a redeploy (~10.6s) - a KV/D1 table
  ejects without one. Probes must retry toward expected status (deploy
  propagation lags a fixed settle).
- **Storage dual-write** (W26): parallel write 200/200 with 107ms skew,
  bytes equal; partial failure is not atomic (200/400 leaves the object
  on one side); sync-after closes the gap in 97ms.
- **The spend cap is not a request-path circuit breaker** (W21,
  Pro-org drill): 105 renders against a 100-transform quota all
  returned 200 - no synchronous disallow at quota+5. Consequences ride
  the billing path (notification, grace period, Fair Use restrictions),
  not the API response at quota+1. Also: fresh-project storage lags
  ACTIVE_HEALTHY (TenantNotFound, then 429 SlowDown for the first
  minutes - retry, don't fail).
- **Edge failover worker** (W04/W24 semantics): origin failure = 5xx OR
  403 (CF Workers wraps TCP failures to unroutable origins as a 403
  RESPONSE) OR any non-ok under OUTAGE. Failover mode (FAILOVER_* vars)
  skips cache-first - HITs carry no x-drill-origin and would mask
  failover. The worker strips `_`-prefixed query params from the origin
  URL (PostgREST 400s on unknown params) but keeps them in the cache
  key. Flap damping = HOLD_MS holdover persisted in the Cache API
  (survives redeploys); HOLD_MS=60000 because 15000 was marginal against
  the ~11s redeploy+settle path. Cleanup deploys must clear FAILOVER_*
  vars explicitly (empty string) or the worker can stay in failover
  mode and break the cache-first drills.

## experiments/image-transformations - key facts (validated 2026-08-18)

One project, no AWS. Storage image transformation billing + runtime surface.
See RUNLOG.md. Complements edge-resilience W19/W21.

- Only the four `/render/image/*` surfaces transform; `/object/public` and
  `/object/sign` SILENTLY IGNORE appended transform params (200 + full
  original). supabase-js `createSignedUrl(path, exp, {transform})` embeds
  the transform in the token and returns a `/render/image/sign/` URL.
- Docs' 1-2500px bound is wrong at runtime: 2501 accepted, silent clamp at
  3000 and at source dims, never an error. 25MB/50MP source limits ARE
  enforced (400 at render time; the objects upload fine first).
- Signed render URLs fail closed: edited query params are ignored (the
  token's transform is what renders); expiry enforced.
- `/render/image/authenticated` enforces storage RLS - denied without a
  select policy, allowed with one (negative control included).
- No `Vary: Accept` on render responses despite content negotiation -
  first-warm fixes the format at that URL until TTL.
- Overwrite invalidation is unreliable: 4 of 5 valid trials served the
  stale variant past the poll window (up to 60s) after a confirmed x-upsert
  overwrite. Version object paths; do not rely on Smart CDN purge-on-update.
- Rate ceiling exists: ~2% 429s at 500 parallel fresh renders, ~9% at
  1000. The earlier ad-hoc 200-parallel probe was simply under it.
- Storage POST without `x-upsert: true` 400s on an existing path - check
  the mutation landed before reading the effect (an early I06 "stale
  cache" fail was exactly this harness bug).
- Billing counter remains dashboard-only (I10 needs PVLAB_PLATFORM_JWT).

## experiments/instance-sizing - key facts (validated 2026-08-17/18)

Compute-size gating across org classes; no tofu (self-provisioning, W21
pattern). I01: on a normal paid org Nano is rejected at create
(`400 Minimum instance size on paid plans is Micro`), at the addon PATCH
(`400 addon_variant: Invalid input`), and absent from `available_addons` -
the floor is Micro. I02: `region_selection {smartGroup, apac}` accepted on
a paid org (picked ap-northeast-2, 135 s). I03: a legacy free-era project
keeps its paused state after the org upgrade but CANNOT be re-paused
(`400 Project is not free-tier`) - pause follows the org's current plan,
not lineage; the subject was consumed and the module now retires (skips)
cleanly. I04: free org - nano create 201, no compute addon catalogue at
all, pause/restore lifecycle live (wake 162-204 s, data API answers
`HTTP 540 Project paused` while parked).

## experiments/byo-oauth - key facts (validated 2026-08-17/18)

The Management API OAuth2 surface (BYO-backend / Path B). O01: bogus
client_id -> `422 Unrecognized client_id` (client validation before
session validation); the lifecycle is gated on `PVLAB_OAUTH_*` from the
manual drill (app registration is dashboard-only; a localhost listener
captures the consent code) - measured: 24 h access tokens, refresh
ROTATES the refresh token, grants are org-scoped to the approved org,
revocation is instant (204, then 404 on the next refresh). A green O01e
burns the grant. O02: project-claim 404s for a normal org's credential
class; jwt-bearer validates params before gating. O03: the project's OWN
OAuth 2.1 IdP is fully headless-automatable (authorize -> GET
authorizations/{id} binds the user -> POST consent approve -> token with
client_secret_basic; PKCE required even for confidential clients) and its
tokens carry `client_id`, usable in RLS (two-client isolation measured).

## experiments/rate-limits - key facts (validated 2026-08-17/18)

L01: `x-ratelimit-limit/remaining/reset` on every response; limit 120,
1:1 decrement on a scoped read; a burst trips JSON
`429 ThrottlerException` with `retry-after: 60` and recovers after the
window. L01b: the budget is CUMULATIVE across a user's PATs (each token's
remaining drops on the other's calls) - PAT sharding does not multiply
it. L01b needs `PVLAB_PAT2` in the env.

## experiments/usage-metering - key facts (validated 2026-08-17/18)

The per-project cost-attribution stack. M01: ground truth exact
(pg_database_size - TOAST compresses, use random payloads; storage
listing byte-exact), `usage.api-counts` exact (13/13) at ~61 s lag,
metrics endpoint 300+ families via PAT. M02/M04: credential-proxy gateway
(gatekeeper) scoped keys - 200/278 families for the allowed key, 403
deny-by-default + resource scoping, and EXACT per-key event counting
(7 calls -> 7 events). Gateway live-API corrections: `POST /admin/keys`
requires `upstream_token_id`; proxy events live at
`/admin/supabase/analytics/events` (not `/admin/audit/events`); event
`key_id` is the non-secret `first4...last4` preview. M03: read-only
estimator against the live org (3 projects, $29.43/mo compute). M05:
control-plane store incl. itself (self-inclusion); in-DB per-tenant
attribution exact via `pg_column_size`; PostgREST exposes only
`db-schemas` (default public). M06: idempotent rollup properties
(replay-safe flush, late-event recompute, duplicate-key rejection). M07:
invoice PDF parses to per-ref rows and reconciles against the live org
(91 lines, 32 refs; standing projects billed 592/600 h); gated on
`PVLAB_INVOICE_PDF`; a ref can appear in multiple invoice sections.

## Harness - id collisions and the experiment filter (2026-08-18)

Module ids collide across experiments (image-transformations and
instance-sizing both use I01-I04). gen-registry stamps each module with
its experiment dir and planRun honours `--experiment` as a REAL filter -
before 2026-08-18 it was a label only, and `--only I04` ran both twins.
Always pass `--experiment <dir>` in probes.

## experiments/compute-disk - key facts (validated 2026-08-19)

Self-provisioning (no tofu), Pro/Team/Free orgs, modules D01-D09.
Reference: COMPUTE-DISK.md at the repo root; see the experiment's
RUNLOG.md for the per-module details and the probe script's
result-id -> module-id mapping.

- Autoscale config unreadable AND unmodifiable on the public v1 API - on
  both Pro AND Team orgs, GET /config/disk/autoscale returns an empty
  shape, mutation verbs all 404 (D04/D07).
- Disk quota enforced as `429 Database disk can only be modified once per
  four hours. Last modified at <UTC>` - contradicts the doc's "4 within
  24h" text; enforcement nondeterministic across runs (D03).
- Free org db starts with 2GB disk, not the documented 1GB; it did not
  autoscale during a fill to 726MB (D05).
- Free org read-only caught at ~726MB db size, not the documented 500MB
  (D06). SELECT still answers 201 on the management query endpoint. TRUNCATE
  rejected (D06b) - recovery needs DELETE + vacuum or the override GUC.
- Disk IOPS/throughput bump accepted AND applied on Micro via POST
  /config/disk - the dashboard's "LARGE required" text is a UI gate only,
  no API enforcement (D08).
- micro->small resize settled 107s; pg_limits per size (D01): micro 60/10/10,
  small 90/10/10 (connections/wal_senders/rep_slots).
- D09 measured upgrade AND downgrade windows with 250ms sampling: u
  micro->small 105s (REST max contiguous outage 1.0s), u small->large 61s
  (17.0s), d large->small 61s (0s), d small->micro 73s (0s); Auth never
  had a contiguous outage. Adjacent resize PATCHes rate-limited: 429
  `still processing addon changes, try again in 1-2 minutes`.

## experiments/rls-policy-cost - key facts (validated 2026-08-19)

One project, no AWS. Planner/RLS-cost matrix over synthetic fixtures; see
experiments/rls-policy-cost/RUNLOG.md and sql/rls-cost.sql.

- `(select auth.uid())` IS access-control-neutral (InitPlan hoist, identical
  row digests); the assumption that it changes policy semantics is wrong, and
  deferring it with an index in place was measured defensible
  (bare 2 calls vs wrapped 1; the per-row evaluation disappeared at the index).
- A table joined INSIDE a policy's EXISTS evaluates its own RLS recursively,
  and the joined policy's wrapped form appears as an InitPlan inside the
  subplan. At demo scale Postgres decorrelates EXISTS to a hashed subplan
  (loops=1); the bare form's auth.helper cost is per subplan-scanned row, the
  wrapped form's is O(1). Plan form is a choice, not a guarantee.
- Grant target beats predicate: `TO public` on a SELECT policy exposes it to
  anon; `TO authenticated` does not. Predicate shape is secondary.
- Client-side filters compose by conjunction against RLS - drift hides rows,
  never reveals them.
- SET ROLE tests need the Supavisor SESSION pooler (port 5432), not the
  transaction pooler (6543); claims GUCs are session-scoped. The Makefile's
  pgurl target picks 5432 for this reason.
- Sequence-based function-call counting in policies: `GRANT SELECT` on the
  sequence is needed if you read `last_value` as a RELATION (`select last_value
  from seq`); the psql hint message names it explicitly.
- First-run trap: decrypted secrets.tfvars carried an UNCOMMENTED placeholder
  `supabase_access_token` on line 1, which made plan/apply fail with
  "Mismatch between input and plan variable value". The root convention
  (comment the placeholder out locally) fixes it; pdf-corpus-graph's Makefile
  comment documents the same trap.

## experiments/rls-wire-claims - key facts (validated 2026-08-20)

One project per module, self-provisioning (no tofu), Pro org; C03 also deploys
a throwaway probe Worker + two Hyperdrive configs via wrangler (account from
`wrangler whoami` or CLOUDFLARE_ACCOUNT_ID). Validates the lexicanum
`reference/rls-without-supabase-auth` pattern. Probe:
`.pi/probe-rls-wire-claims.sh C01[,C02,C03]`.

- The pattern works: as a custom non-owner role, `set_config(
  'request.jwt.claims', ..., true)` over the wire drives per-user RLS on the
  session pooler (5432), the transaction pooler (6543), and through
  Hyperdrive's tx and multi-statement forms.
- **Managed Supabase silently no-ops `GRANT USAGE ON SCHEMA auth`** for a
  custom role (has_schema_privilege stays false; `auth.uid()` errors
  `permission denied for schema auth`). `GRANT EXECUTE ON FUNCTION auth.uid()`
  alone is not enough. Working shape: a SECURITY DEFINER wrapper owned by
  postgres (`public.claims_uid() -> auth.uid()`), granted EXECUTE to the
  custom role, policy reads `owner = public.claims_uid()`.
- GoTrue-issued JWT claims work over the wire with no PostgREST (C02);
  tampered-sub control confirms the GUC is unprivileged - the database
  enforces whatever the GUC says, so the connection credential is the
  security boundary.
- Session pooler (5432) RESETs GUCs on return (bare SET did not leak, 5
  tries). **Transaction pooler (6543) DOES leak a bare SET across
  invocations** - opposite of 5432; claims belong in a transaction, never a
  bare SET.
- Hyperdrive did NOT replay a claims-GUC query across users in this probe
  (identical SQL + param, claims A warmed n=1, claims B got 0) - the doc's
  cache-blindness worst case was not reproduced; the split-binding rule
  stays as the documented control regardless.
- Operational: Hyperdrive create races fresh-project Supavisor warmup
  (ENOTFOUND tenant/user) - warm the pooler locally first and retry the
  create. Probe worker needs `nodejs_compat` for postgres.js. The Management
  query endpoint wraps multi-statement SQL in one transaction, so fixture
  DDL that creates a function and a policy referencing it must run in
  separate calls (function first).

## Pending / gated work

- O01c/d/e need `PVLAB_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN` in
  `.pi/oauth-drill.env` (gitignored); a green O01e burns the grant -
  re-consent to re-run.
- L01b needs `PVLAB_PAT2` in the same file.
- M07 needs `PVLAB_INVOICE_PDF=<path>` (any Supabase invoice PDF).
- M02/M04 need `GATEKEEPER_URL` + `GATEKEEPER_ADMIN_KEY` (sourced from
  ~/gatekeeper/.env by the probes).
- The consent drill: dashboard org settings -> OAuth Apps -> add app,
  callback `http://localhost:54321/callback`, then run a listener on
  54321 and open the authorize URL. Steps in
  experiments/byo-oauth/RUNLOG.md.
- `.pi/sweep-all.sh` runs every acceptance probe in a burst-safe order.

## experiments/auth-refresh-race - key facts (validated 2026-08-19)

- The defect, reproduced: gotrue-dart 2.21.0 (supabase_flutter 2.14.0 pins it)
  destroys the CURRENT, still-valid session when GoTrue rejects a stale
  refresh token with refresh_token_already_used - _removeSession() +
  signedOut event. Fixed in gotrue 2.22.0 / supabase_flutter 2.15.0
  (PR 1351): the rejection is absorbed and the existing session returned.
- GoTrue reuse semantics (v2.195.0 source + live probes): direct-parent
  reuse of a revoked token is tolerated without any time limit; older
  generation reuse rejects only past refresh_token_reuse_interval;
  concurrent same-token refreshes dedupe to one network call even pre-fix.
- Hosted platform quirk: PATCH of security_refresh_token_reuse_interval is
  accepted and reads back, but the running auth service kept the ~10s
  default (measured 2s tolerated / 15s rejected). Config does not propagate.
- Still-signed-out playbook (on >= 2.15.0): expired-session + stale token =
  deliberate sign-out (repro scenario T1, jwt_expiry=30s locally);
  cross-isolate refresh (dedup is per AuthClient instance, no
  BroadcastChannel off-web); app-side signOut-on-401; tracker residual
  #1372 retryable-fetch recovery and #1687 WASM session deser; recoverSession
  via custom LocalStorage resurrecting old tokens.
- Differential harness: dart/ holds the repro; make repro / repro-local
  (REUSE_WINDOW_SEC default 12) prints VERDICT=defect-reproduced vs fixed;
  both hosted and local environments verified. Dart SDK at ~/sdk/dart-sdk.

## experiments/residency-facts - key facts (validated 2026-08-20, Zurich project)

- The region catalogue IS machine-readable:
  `GET /v1/projects/available-regions?organization_slug=<slug>` ->
  `{ recommendations, all: { smartGroup[3], specific[17] } }`; bare call 400.
  `recommendations` is the platform's per-org capacity pick. A smart-group
  code in the `region` field of POST /v1/projects is a 400
  ("Need to use one of available regions"); `region_selection` is the only
  place a group is accepted (I02's other half).
- REST and Storage front Cloudflare from any vantage (PoP = caller-nearest,
  SIN from Singapore against a eu-central-2 project). Edge Functions execute
  user-nearest by default (x-sb-edge-region: ap-southeast-1 from Singapore);
  `x-region` pins to the project region.
- Storage CDN, measured (the fundamentals doc-reading did NOT survive):
  signed URLs cache per token (repeat HITs, fresh token MISSes - but two
  sign calls in the same second with the same expiresIn return the SAME url,
  vary expiresIn). Private buckets do NOT give per-user misses: a second
  user's first read HITs. And a cached private object is served to a user
  the policy has since been tightened to deny (200/HIT; a never-authorized
  user correctly gets 400/DYNAMIC) - on a hit, the CDN does not re-evaluate
  the policy. The object carried `Cache-Control: no-cache` and was cached
  anyway. Reproduced 3 consecutive runs.
- realtime.messages is daily-partitioned but LAZILY: a fresh project has the
  table with zero partitions, SQL realtime.send() warns "no partition of
  relation messages found for row" and drops the message; one websocket
  subscribe makes the Realtime service create 5 daily partitions (+/-2 days)
  under supabase_realtime_messages_publication. 3-day retention not
  observable on a fresh project.
- Log drains have NO published-API surface: zero drain-config operations
  across the whole published OpenAPI document (F05's enumeration method).
  Dashboard-only on the stable contract.
- Makefile note: the PAT is NOT in secrets.tfvars (placeholder by design);
  it comes from SUPABASE_ACCESS_TOKEN in the operator's env.

## Commands

Root: `make secrets-decrypt`, `make secrets-encrypt`, `make experiments`.
Per experiment: see its Makefile (`init phase1 wait-ready arns phase2
suite suite-clean ssm restrict unrestrict destroy`). `make suite` is the
automated path (SSM-deployed phases, S3 artifact pull, REPORT.md);
`make suite-clean` removes the suite S3 bucket, which is orchestration
state tofu does not track.

## Related

- ~/.pi/agent/skills/terraform/SKILL.md - tofu conventions used here
- ~/.pi/agent/skills/supabase/SKILL.md - CLI/pooling behaviour
