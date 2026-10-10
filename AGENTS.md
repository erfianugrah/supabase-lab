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
  `ctx.orgSlugs` (`PVLAB_ORG_SLUGS`) and, since 2026-09-02, `ctx.orgs` keyed by
  role from `PVLAB_ORG_<ROLE>` (`pro`, `team`, `free`) for modules that need a
  specific plan's org rather than "every org supplied". Both gate capabilities (`peer`, `org`),
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
  refs, no internal ticket IDs, no named individuals. Also no provenance:
  do not write that someone asked for an experiment or describe their
  setup, stack or findings; state the platform question. History has been rewritten with git filter-repo more than once
  (see the 2026-09-07 identifier sweep below), most recently on 2026-10-07,
  so commit ids cited from before 2026-10-07 do not resolve. In-repo and
  lexicanum citations were remapped; a local map of old to new ids is
  `.git/filter-repo-2026-10-07-commit-map` (not pushed). Four evidence
  stamps (28009bd, 60e7194, 7fe4809, 9125b00, all 2026-09-07/08) name
  commits that survived only on a pre-rewrite backup branch, deleted
  2026-10-07; they have no current equivalent.
- A module that runs gets its RUNLOG line the same day. T27 ran on 2026-08-07
  and the RUNLOG said "NOT YET RUN" until 2026-09-03, while two published
  pages cited it. Anything a page cites from gitignored `evidence/` needs a
  redacted RUNLOG line, or `make publish-evidence` into `out/<date>/`.
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
- PostgREST root `/rest/v1/` answers 200 to the legacy service_role key and
  `sb_secret_` keys only; anon and the publishable key get 401 (DD04,
  2026-10-10). Anon probes need a real table. SQL-created tables get anon
  SELECT via default privileges, no RLS: a project created through
  `POST /v1/projects` on 2026-10-10 still had the legacy default ACL
  (`arwdDxtm` for anon, authenticated and service_role, DD01a; the v1 create
  body has no field for the new default, so whether the 2026-05-30 default
  applies to API-created projects is unseparated from a gradual rollout).
  After the opt-in `alter default privileges ... revoke`, a new table answers
  42501 (401 for anon, 403 for service_role) until a GRANT (DD01c). See the
  data-api-defaults block.
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

## experiments/data-api-reenable - key facts (validated 2026-09-24)

One project, no AWS. What re-enabling the Data API costs a client, and what a
client can poll. See RUNLOG.md; artifacts in `out/2026-09-24/`.

- "Off" points PostgREST at a nonexistent schema: the platform restarts it with
  `db-schemas=pg_pgrst_no_exposed_schemas`, the schema-cache load fails, and
  PostgREST retries with backoff 1, 2, 4, 8, 16, then 32 s (capped).
  Clients get `503 PGRST002`.
- "On" restarts the PostgREST process: both enable PATCHes in the log extract
  (300 s and 900 s cycles) logged a fresh `Starting PostgREST 14.5...`, so the
  32 s retry timer does not gate recovery. A no-op PATCH restarts it too.
- Recovery does not grow with the outage: the slower data path answered 200 at
  2870 / 1320 / 952 ms after holds of 30 / 300 / 900 s (DA02), and at 1738 ms
  with 3002 tables (DA04).
  `notify pgrst, 'reload config'` after the enable did not help (DA05 run 2:
  plain 1347/1184/1004 ms, NOTIFY 1767/1342/2581 ms).
- Readiness: `GET /rest-admin/v1/ready` (service_role key) is reachable through
  the gateway - 200 healthy, bare `503` off - but turned 200 930 ms before the
  RPC path in the 30 s cycle; confirm with a data read. Management API
  `/health?services=rest` flips too, at 2 s polling from 666 ms ahead to
  1522 ms behind the slower data path.
- The Dashboard toggle calls `/platform/projects/{ref}/config/postgrest` (not
  PAT-reachable) and on enable writes `public` alone; replayed through the API
  (DA03) the extra schema and `/graphql/v1` answered `406 PGRST106` about 71 s
  later and stay that way. Its click-to-serve time is unmeasured (DA06 manual drill, not run).
- Harness gotchas: `PATCH /postgrest` 400s on `db_pool: null` (a fresh project
  reads null back - omit it); `postgrest_logs` is a `source` value on the unified
  `logs` table (`where source = 'postgrest_logs'`, measured 2026-10-10 on a
  fresh project, edge-resilience RUNLOG), and `logs.all` answers 410 since
  2026-09-23. DA02L was ported to `logsQuery` on 2026-10-10 and has not been
  re-run end to end since. The project created for this run (2026-09-24) did
  not have `pg_graphql`
  enabled, so `/graphql/v1` returned 200 with an errors envelope and is not a
  health signal.

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
  The lexicanum pages also carry a "5 of 5 fresh projects, `500
  unexpected_failure`, 2026-08-04" row from a bash run that was never ported
  here; it is the corpus's own record, not a lab artifact, and the two do not
  contradict each other.
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
  mint. A refresh presented to the trusting project answers
  `400 refresh_token_not_found` - measured here by X03 (green 2026-08-17, see
  the RUNLOG), so it is reproducible, not reported.

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

## experiments/key-rotation - key facts (ported 2026-08-04; FIRST LIVE RUN 2026-08-25)

Hub and spoke: the hub's GoTrue is the spoke's third-party auth issuer, and the
hub rotates its signing key. The port ran live 2026-08-25 (full 20-minute
window, artifacts in `out/2026-08-25/`) - two port bugs were fixed on the way
(signing keys are managed on the MANAGEMENT API at
`/v1/projects/{ref}/config/auth/signing-keys`, not the project GoTrue admin
surface, which is a hard 404; and `adminCreate` had a doubled
`/admin/admin/users` path), and the platform changed around the old findings:

- STILL TRUE - the window belongs to the CONSUMER's cache, not the issuer's
  publication. Live 2026-08-25: hub published the new kid in 241 s (~4 min,
  was ~7 in 2026-08-04 bash); the spoke's cached kid set never changed across
  116 probes / 20 min and new-key tokens were 401 throughout. STRONGER than
  the old re-creation finding: a FRESH integration created while the issuer's
  JWKS was demonstrably current still served the stale kid set.
- CHANGED - standby-key creation is NOT time-rate-limited any more (was
  `Please wait until <ISO8601>`, 127-144 s). The live constraint is
  one-standby-at-a-time: a second create answers `422 "already has a signing
  key in standby"`. Status vocabulary: standby | in_use | previously_used |
  revoked; `kid == id`; create body needs `{algorithm}`.
- NOT RE-CONFIRMED - "a revoked key keeps working" (the 2026-08-03/04
  finding). The 2026-08-25 run's module ordering meant the spoke never cached
  the revoked key, so its tokens 401'd for staleness reasons, not revocation
  handling. Needs a dedicated run: create the trust BEFORE rotating, revoke
  inside the cache window, no intervening promotion.
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
  A session that was ALREADY aal2 is a different question: it drops to aal1
  on its first destination refresh unless `auth.mfa_amr_claims` is copied too
  (session-carry S04, 2026-09-25).
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

## experiments/session-carry - key facts (validated 2026-09-25)

Two projects, no AWS. What it takes for EXISTING sessions to survive an app
moving between Supabase projects, testing "one signing key on both, copy
each user's auth rows". Findings and artifacts in RUNLOG.md; out/2026-09-25/.

- A kid cannot be on two projects while one of them holds it `in_use` (other
  key states not run). Importing a private JWK whose kid another
  project already holds answers `409 Signing key with kid "..." already
  exists`, across organizations too (S01b, S01x). Both orgs were one account.
- The same private material under a new kid does not help (02:56 run): target
  Auth refuses with `403 bad_jwt` naming the unrecognised kid (S01g), and
  target PostgREST refuses with `401 PGRST301` (S01f) even after the target
  JWKS published the new kid (S01e). Kid lookup is shown for Auth; for
  PostgREST it is inferred. With unrelated keys (02:55 run) the held access
  token also fails at the target until the client refreshes (S02a, S02b).
  Without third-party-auth trust (cross-project-auth X02, not probed here),
  only the refresh token crosses, via the row copy.
- Copy `auth.mfa_amr_claims` after `auth.sessions`. Without it the first
  target refresh of an aal2 session returns aal1 with no `amr` claim (S04a);
  with it, aal2 and `password+totp` (S04b).
- A refresh at the source after the copy leaves the client holding a token
  the target never saw (`refresh_token_not_found`, S03a). A client still on
  the pre-copy token refreshes at the target although the source revoked it,
  giving one session two live lineages (S03b, S03c).
- A project holds at most three `previously_used` signing keys (422 on the
  next import). Before importing, S01 revokes the oldest non-HS256 one on any
  project already at 3; never revoke the
  HS256 legacy secret, which signs the legacy anon/service_role keys.
- Target JWKS first listed the target's new kid 450882 ms (10 s poll step)
  after polling began, and polling began only after S01d, not at the S01c
  promotion (S01e, one run). The source issued tokens with the imported kid by
  the second 5 s poll, 5190 ms after polling began, which itself began after
  S01b, S01x and S01c (S01d). Neither figure is a promotion-to-effect latency.

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
- **The Auth probe is `GET /auth/v1/health` with an anon key** (`lib/setup.ts`
  `AUTH_PATH`, `lib/probes.ts`), not an authenticated operation. D01's 75 s and
  D03's 131 s are that endpoint; compute-disk D09 sampled the same endpoint on
  2026-08-19 and saw 0 s across four resizes, so the two runs disagree on one
  surface and no run has probed an authenticated Auth call across a resize.
  Write-ups must not call these figures an "authenticated Auth path".
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
- **D05 (2026-10-01): a database-password PATCH on a plain project does not
  restart Postgres.** `pg_postmaster_start_time()` and
  `pg_stat_checkpointer.stats_reset` were unchanged across a 7-minute window,
  and REST, Auth, Storage and Realtime stayed up (the pooler is not probed:
  its probe uses the password being changed). Integration-provisioned
  projects were not tested (a Vercel-Marketplace install needs a human
  `vercel integration accept-terms` first). For "does a managed restart
  reset the checkpointer", read the same pair around D01's `POST /restart`.

## experiments/checkpointer-reset - key facts (validated 2026-10-01, local only)

- `supabase/postgres:17.6.1.136` and `postgres:17.11-alpine` behave the same:
  an unhurried clean restart keeps `pg_stat_checkpointer.stats_reset` and the
  counters; SIGKILL resets both. Every rig restart ran on a near-idle cluster,
  so this says nothing about a slow shutdown.
- **A SIGKILL during a slow shutdown checkpoint depends on the version**
  (~2 GB dirty shared_buffers, SIGINT then SIGKILL 0.5 s later, two runs per
  case). Postmaster only, checkpointer survives and finishes: both logs read
  clean on every version, but PG 17.4 and 17.11 KEEP the stats and PG 18.6
  resets them. Every process killed (17.11): the next start logs `not
  properly shut down; automatic recovery in progress` and the stats reset.
  So on 17.x a stats reset at a restart should come with that startup line;
  a clean `was shut down at` instead points away from the stop path.
- Inside a container the postmaster cannot be killed alone under `--init`
  (tini exits with it and the namespace dies); keep the container on `sleep
  infinity` and run Postgres under `pg_ctl`. Send both signals inside one
  `docker exec` - two separate `docker.exe exec` calls add enough latency
  that the SIGKILL landed after the stop had finished.
- zsh does not word-split an unquoted `$VAR`: `kill -9 $PM $KIDS` killed only
  the postmaster in the first attempt. Run such scripts under bash.

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
- The entitlements payload is a FLAT LIST keyed by feature -
  `{ entitlements: [ { feature: { key, type }, hasAccess, config: { value |
  unlimited | enabled | unit | set } } ] }` (the canonical spelling; the
  platform-facts RUNLOG 2026-09-02 entry carries the same) - and the plan
  label lives on `GET /organizations/{slug}` (`plan`), not in the entitlements
  body. F01 originally dug dotted paths into a nested object and had been
  rendering every row "absent" for an unknown period until
  edge-function-limits noticed on 2026-09-02; it now looks up the eleven
  features it reports by feature key and FAILS on an empty list rather than
  recording eleven absences as facts. In F01 evidence dated 2026-09-02 or
  later, a row that reads "absent" means the feature is genuinely not in the
  list; in earlier evidence every row reads "absent" and means nothing. 64
  features were listed on each of a Free, Pro and Team org that day.
- F03's live-token control is not optional. 404 on every scope candidate also
  describes a dead token or an outage; without the control returning 200 in the
  same run, the negative result is a `skip`, not a `pass`. F03 measures only
  the absence of a scoping endpoint on `/v1`: scoped PATs exist as a
  dashboard feature (Personal Access Tokens guide, read 2026-10-07), so never
  cite F03 as "a PAT cannot be scoped".
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
  RELIABILITY.md at the repo root. 26 modules as of 2026-09-07 (W01-W13,
  W15-W27; W14 was a manual drill), all green; the last full battery was
  25 modules, 24/25 on 2026-08-17 (W17 race, fixed and re-probed), and
  the 22/22 unattended run in ~27 min was 2026-08-16 via
  `.pi/probe-edge-resilience.sh W01,...,W24` (or
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
- **PGRST303 through edge_logs** (W27, 2026-09-07): the gateway logs the
  PostgREST error body's `content-length` verbatim (79 = "JWT issued at
  future", 70 = "JWT expired"), the `proxy-status` header
  (`PostgREST; error=PGRST303`) and the parsed JWT payload (`issued_at`,
  `expires_at`, `role`, `subject`, `auth_user`) even on the 401, so the
  future-iat/expired split is issued_at minus the row timestamp in seconds,
  with the byte count as cross-check. On the unified
  `/analytics/endpoints/logs` (ClickHouse; `logs.all` is 410 since 2026-09-23)
  read `log_attributes['response.headers.proxy_status']`,
  `['response.headers.content_length']` and
  `['request.sb.jwt.authorization.payload.issued_at'|'expires_at']` (strings;
  an absent key reads ''). The split is measured in SQL (W27d, 2026-10-10):
  `toInt64OrNull(issued_at) - toUnixTimestamp(timestamp)` was 300 and -3900,
  `expires_at < toUnixTimestamp(timestamp)` was 0 and 1. `timestamp` is an ISO
  UTC string (it was microseconds). A 42501 row has no `transfer_encoding` or
  `content_length` key on the unified table (the 2026-09-07 read showed
  "chunked"); select it on `proxy_status`. anon -> 401 42501 (key-only or
  legacy anon JWT), authenticated -> 403 42501, matching S21. Rows landed
  17-46 s after the request in the published run (51 s in the private first
  run, 13 s on 2026-10-10, one run).
  run). DDL then probe within 1 s got 404 PGRST205
  (schema cache) - `notify pgrst, 'reload schema'` and poll first.
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

## experiments/sfp-platforms - key facts (validated 2026-08-24, extended 2026-08-25)

Platform-plan entitlement delta, measured on a `platform`-plan org
against the same modules run on a normal Pro org. Nano IS the default create
tier (224 MB shared_buffers, pausable), not a catalogue variant -- the earlier
I01 "Nano absent" reading measured the upgrade/resize surfaces, not the
create default, and is corrected here. The platform plan is an entitlements
tier decoupled from the "contact us" gates: 18-variant compute catalogue
(`ci_micro`..`ci_48xlarge_high_memory`) but a narrower 10-size self-service
update path. Pausing is ENFORCED (unlike every paid plan). Migrations: NOT
SfP-gated (200 on Pro too). Restore points 400, OAuth bridge 404,
project_cloning declared-but-404.

Extended 2026-08-25 (gate hunt + A/B, see RUNLOG):

- Read replicas: the 400 names its gate (`"minimum size of small"`, same on
  both org classes - the nano default sits below the floor), then a
  completed-physical-backup wait; chain closed on Pro (after `pitr_7`, setup
  204). PITR enable on the platform org is its own entitlement refusal.
- `secret_jwt_template` claims REACH the exchanged token on both org classes
  (`jwt_probe()` returning `auth.jwt()`; role + custom claim as templated).
  The api-keys create response redacts `api_key` without `?reveal=true`;
  PostgREST needs a schema-cache reload before a fresh RPC resolves.
- JIT invite (`POST /database/jit/invite`, S15) is 200 on the platform org
  and 500 on Pro. The grant route is not broken on Pro: see jit-db-access
  (`PUT /jit-access`, `PUT /database/jit` -> 200). Backup schedule 402 `entitlement_required` on BOTH org classes
  (the OpenAPI 402 text says Enterprise plan).
- Disk grow to 8 GB confirmed landed. Disk gp3 IOPS floor blocks a 2->4 GB
  grow. Read-only mode (status + 15 min temporary-disable). Branches: delete
  is the top-level `DELETE /v1/branches/{id}`, not by name.

Full table: `experiments/sfp-platforms/README.md`; per-run record: RUNLOG.md;
artifacts: `out/2026-08-25/` (redacted and made trackable on 2026-09-02;
before that they sat untracked under the global `**/out/` ignore while this
line called them committed).

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

## experiments/compute-disk - key facts (validated 2026-08-19; autoscale write surface re-probed 2026-09-23; paid-plan fill D10/D11 2026-10-01)

Self-provisioning (no tofu), Pro/Team/Free orgs, modules D01-D11 (D11 is a
curl replay recorded in the RUNLOG, no test file). D10 is not mapped in
`.pi/probe-compute-disk.sh`; run it directly with `PVLAB_ORG_PRO` set.
Reference: COMPUTE-DISK.md at the repo root; see the experiment's
RUNLOG.md for the per-module details and the probe script's
result-id -> module-id mapping.

- Autoscale config readable-but-empty AND unmodifiable on the public v1 API -
  on both Pro AND Team orgs, GET /config/disk/autoscale answers 200 with
  `growth_percent`/`min_increment_gb`/`max_size_gb` all null, mutation verbs
  all 404 (D04/D07). "Unreadable" was the earlier wording and it is wrong: the route exists
  and answers.
- Disk quota enforced as `429 Database disk can only be modified once per
  four hours. Last modified at <UTC>` - contradicts the doc's "4 within
  24h" text; enforcement nondeterministic across runs (D03).
- Free org db starts with 2GB disk, not the documented 1GB; it did not
  autoscale during a fill to 726MB (D05).
- Pro starts on 2 GB as well (D10, 2026-10-01). Autoscale fires at ~90% util:
  2 -> 8 GB first (the baseline, not +50%), then 8 -> 12 GB, and it is not
  bound by the manual four-hour cooldown. Read-only at ~95% measured, with
  automatic return after the grow. A fast burst once the manual quota is
  spent hit `53100` disk full and a 7 min `57P03` outage in one run of two
  (project status `ACTIVE_HEALTHY` throughout); the other got read-only at
  95.1%. The ">1.5x import" rule did not fire as
  written (1.90x accepted). `/config/disk/util` is a five-minute sample. Gate
  D10 on fresh util samples or Postgres's own data+WAL read, never on a
  connection error: run 1 called a dropped connection read-only.
- Grow steps from 2 GB (D11): 4/5 GB `400` on the gp3 IOPS floor (message
  gives max 500/GB or 80,000), 6 GB `201`.
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

- **The autoscale cap cannot be set through the API, and the disk write hides
  that.** No write verb exists on `/config/disk/autoscale` (`PATCH`/`PUT`/
  `POST`/`DELETE` all `404` with the same "Cannot VERB" shape an unknown path
  gives). Worse, `POST /config/disk` ACCEPTS autoscale keys - inside
  `attributes`, at the top level, or as a nested `autoscale` object - answers
  `201`, and discards them: the autoscale GET still reads all-null after a 60 s
  settle. A caller gets a success code and no effect. Re-probed 2026-09-23 on a
  platform-plan org and a second control plane, replicating D04/D07 on Pro and
  Team.

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
- compute-disk D10 on the platform-plan org: autoscale entitlement and
  first-grow step there are unmeasured (D10 ran on Pro only). Needs the
  platform org's slug and token plus its control-plane base URL; the 2 GB
  Nano volume makes the fill cheap (~40 min).

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

## experiments/iap-lockdown - key facts (validated 2026-08-28, Phase A + partial B)

- No managed HTTP-tier lever makes any surface network-private; each is a
  per-service tighten. The only surfaces reachable with NO key are a public
  storage object and a `verify_jwt=false` Edge Function.
- L02: `db_schema:""` wedges PostgREST to 503 PGRST002 in ~4s;
  Auth/Storage/Realtime/EF are UNAFFECTED - "Data API off" is PostgREST-only.
  Dropping `graphql_public` -> GraphQL 406 PGRST106 while REST stays 200.
  `max_rows` caps a read (exfil brake, not a gate).
- L03: `private_only` is enforced at CHANNEL JOIN, not the WS upgrade - the
  anon handshake still succeeds (101). L07: `verify_jwt` is a KEY-POSSESSION
  check (the anon project key passes) - an IAP-as-proxy must revoke keys.
- L05: disabling legacy keys 401s the anon JWT in ~45s, but new publishable-key
  generation is INDEPENDENT and the control plane re-mints at will - "revoked"
  is a posture the PAT reopens.
- L08 grant/RLS write holes: `REVOKE SELECT` is undone by the next
  `CREATE TABLE` (pg_default_acl rot); `ALTER DEFAULT PRIVILEGES FOR ROLE
  postgres` is the durable fix, but `supabase_admin`'s default ACL is NOT
  alterable by postgres (42501). A plain VIEW over an RLS table leaks all rows
  unless `security_invoker=true`. UPDATE policy gates ROWS not COLUMNS;
  PERMISSIVE policies OR together (a second permissive policy bleeds onto anon).
- L09: the documented `db_pre_request` mechanism did NOT fire on the hosted
  PostgREST path within 121s (role-GUC + NOTIFY reload did not activate the
  hook) - the self-hosted IP filter is not activatable via SQL on hosted.
  Whole-spec enum: 7 network/security ops, none a Data-API IP allowlist.
- L10/L10E: third-party auth AS the IAP - `jwks_url` and `oidc_issuer_url`
  resolve, inline `custom_jwks` never does; RLS keyed on the issuer `iss` claim
  admits a token minted by a self-hosted ES256 issuer (JWKS served from an Edge
  Function) and denies anon and GoTrue tokens.
- Cloudflare pieces are OpenTofu (provider v4, gated on `enable_cloudflare`);
  real CF ids live in gitignored `cloudflare.auto.tfvars`.

## experiments/security-lockdown - key facts (validated 2026-08-28; S13-S15 2026-08-31; S16-S21 2026-09-03)

- S01: the Management API security advisor catches every seeded exposure
  (rls_disabled_in_public, rls_enabled_no_policy, security_definer_view,
  security_definer_function, function_search_path_mutable) - run it first for
  any "are we locked down?" question.
- S02 + S10: network restrictions gate the DB/pooler socket ONLY. A restrictive
  CIDR leaves the REST HTTP tier answering unchanged (401 -> 401) while the
  pooler refuses the excluded IP (Supavisor `FATAL EADDRNOTALLOWED`). Proves
  restrictions do NOT cover REST/Auth/Storage, without borrowing privatelink-aws
  for the socket half.
- S03: auth hardening is settable via the API (password_min_length, HIBP
  leaked-password [OFF by default], MFA verify).
- S04/S05: the honest Data API answer. Managed Data API off (503 PGRST002); a
  self-hosted PostgREST (v16.2) on the SAME Postgres via the session pooler
  serves the data; its db-pre-request x-forwarded-for filter rejects a spoofed
  IP (403 PT403) - the exact mechanism L09 measured does NOT fire on hosted,
  working here because you own the config. nginx `limit_req` (rate 2r/s) turns a
  15-request burst into 2x200 + 13x429; only works fronting a CLOSED origin.
  Gotchas: the pre-request function must persist for the container's life; nginx
  `limit_req` returns 503 unless `limit_req_status 429` is set.
- S06: run PostgREST as an authenticator-style role (NOSUPERUSER, NOBYPASSRLS,
  member of anon/authenticated), NOT `postgres` (a superuser bypasses RLS and
  every grant, silently defeating an RLS lockdown).
- S07/S08/S09: `supabase_vault` stores ciphertext, not a plaintext column;
  `pg_net` (`net.http_get`) is an outbound-HTTP egress/SSRF surface most
  lockdown plans omit - restrict EXECUTE on the net schema or leave pg_net
  disabled; pgaudit is available; `GET /database/backups` on a fresh project
  shows `pitr_enabled=false`, `walg_enabled=true` (PITR is a paid add-on, off by
  default).
- S13: column-level grants close the column a row UPDATE policy leaves open. A
  permissive UPDATE policy + a table-level UPDATE grant lets anon overwrite a
  sensitive column (`204`); after `REVOKE UPDATE ON t` + `GRANT UPDATE (safe
  cols)` the same write returns `401` carrying SQLSTATE `42501` (PostgREST maps
  the column denial to 401 for anon, not 403), and the granted column still
  writes. RLS gates rows, the grant gates columns - a `WITH CHECK` never
  constrains which columns move.
- S14: the Auth levers a customer switches ON, the half S03/S11 (what leaks)
  omitted. All present on micro and off by default: `hook_before_user_created_*`
  (before-user-created hook), `security_captcha_*` (provider defaults hcaptcha),
  and the seven `rate_limit_*` fields. A rate limit PATCHes down and back
  (settable). Hook/CAPTCHA enforcement not driven (needs a live endpoint + real
  provider secret).
- S15: Storage and Realtime never traverse PostgREST, so a db-pre-request cannot
  gate them. With the Data API wedged off (`503 PGRST002` on a table path),
  `/storage/v1` still answers (`200`) and `/realtime/v1` still answers - both are
  their own services against the same Postgres. The storage schema is owned by
  `supabase_admin` (not the project owner), so the Move 1 public-schema REVOKE
  does not govern it; Storage authz is RLS on `storage.objects`. Probe note:
  "REST off" reads as `503` on a TABLE path only; `/rest/v1/` root answers `401`
  at the gateway with no schema route.

- S16: on the MANAGED PostgREST `request.headers` reaches SQL with
  `cf-connecting-ip`, `cf-ew-via`, `cf-ipcountry`, `x-forwarded-for`,
  `x-forwarded-proto`; the hosted edge APPENDS its address after a
  client-supplied x-forwarded-for (client value first), so a check must read
  `cf-connecting-ip`, never the first XFF element. `pgrst.db_pre_request` on
  the authenticator role persists but fires neither after `NOTIFY pgrst,
  'reload config'` (61s) nor after `POST /projects/{ref}/restart` (182s after
  REST returned; the restart took REST down for 303s and the first health poll
  after it already said ACTIVE_HEALTHY - not readiness). L09 stands, now with the restart path
  measured too.
- S18: the audit trail a customer credential reaches is the logs endpoint.
  `edge_logs` carries every REST/Storage request with a client-address
  header field (`cf_connecting_ip` or `x_real_ip`; the probe checks either) in 15-18s; `auth_logs`
  carries a failed login as a request line (path, status, `error_code`,
  `remote_addr`, no email) and a successful one as an `auth_event` with
  `actor_username`. `GET /auth/v1/admin/audit` returned 0 entries throughout.
  No Log Drains path exists in the /v1 spec (Dashboard-only). Blocking: 10
  failed psql auths through the pooler banned this machine at the DB socket;
  `POST network-bans/retrieve` (201) lists it, `DELETE network-bans` (200)
  lifts it, and it is the only ban lever - nothing bans an IP at the HTTP tier.
- S17: FORCE ROW LEVEL SECURITY binds an owner only if the owner cannot bypass
  RLS. On the platform `postgres` (the query endpoint's role and default table
  owner), `service_role` and `supabase_admin` are BYPASSRLS; a postgres-owned
  table with RLS on and no policy reads every row before AND after FORCE, a
  table owned by a NOBYPASSRLS lab role reads 0 after. `ALTER ROLE service_role
  NOBYPASSRLS` -> `42501: "service_role" is a reserved role, only superusers can
  modify it`. The backend gets RLS by ROLE CHOICE: a NOBYPASSRLS role granted to
  `authenticator`, reached through the Data API with an HS256 JWT (`role` claim)
  minted under the secret `GET /projects/{ref}/postgrest` returns - 0 rows with
  no policy, the policy's rows with one.
- S19 (enforcement, not settability): HIBP fires at SIGNUP (`422
  weak_password`; S11: not on `PUT /auth/v1/user`). `rate_limit_anonymous_users
  = 3` -> exactly 3 x 200 then 429 `over_request_rate_limit`, no burst above the
  value. CAPTCHA gates signup AND password login (`400 captcha_failed`) and can
  be proven with Turnstile's documented test secrets (always-fail
  `2x0000000000000000000000000000000AA`, always-pass `1x...AA`, dummy token
  `XXXX.DUMMY.TOKEN.XXXX`) - no provider account needed. A before-user-created
  hook as a Postgres function (`pg-functions://postgres/<schema>/<fn>`) rejects
  with its own message (`400`, `error_code` is `unknown`); GoTrue answers a
  generic 400 for a few seconds after the PATCH while it reloads, so a probe
  must wait for the hook's text, not any 400. `mailer_autoconfirm=true` lets a
  signup probe run without spending the 2/hour shared-SMTP budget.
- S20: on your own PostgREST the db-pre-request filter judges whatever
  x-forwarded-for reaches it. Direct to the container the client's header is
  what SQL sees (client-controlled); through an nginx edge that sets
  `X-Forwarded-For $remote_addr` SQL sees the edge's peer address and the
  client value is gone. The filter is an allowlist only when PostgREST is
  reachable from nowhere but the edge - a deployment property.
- S21 (no-RLS, service_role-from-the-backend shape): `REVOKE ... FROM anon,
  authenticated` on tables/sequences/functions/schema closes tables (`401`/`403`
  with `42501`) but leaves every RPC callable - functions carry EXECUTE for
  PUBLIC (`proacl {=X/postgres,...}`) and schema public keeps USAGE for PUBLIC.
  `REVOKE EXECUTE ... FROM public` closes them. A per-schema `ALTER DEFAULT
  PRIVILEGES ... IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM public` does
  NOT stop a new function reopening (per-schema entries add to the global
  default); only the GLOBAL form (no IN SCHEMA) does. Exposed schema PATCHed to
  `api` only: service_role loses `public` too (`404 PGRST205`) - project-wide;
  the first exposed schema is the default profile.
- Logs endpoint: `/analytics/endpoints/logs` (the shared `logsQuery` helper),
  ClickHouse dialect, `where source = '<name>'`, nested fields as
  `log_attributes['request.path']`. `logs.all` is 410 since 2026-09-23 (still
  listed in the published OpenAPI document on 2026-10-10). The 2026-09-03
  `Backend error! Retry your query.` on the stream endpoint and S18's
  "logs.all first" order are history; S18 was ported on 2026-10-10 and passed
  5 of 5 on its second run (the first run's S18b did not find its row in
  264 s, cause not established, edge-resilience RUNLOG 2026-10-10).
- The `pvlab` binary cannot be rebuilt while a probe runs, and a probe killed
  by a caller timeout skips its `finally` (S18 left a user and would have left
  a ban). Run long modules with `make probe-bg` or a background shell, never
  under a 10-minute foreground timeout.

## experiments/edge-function-limits - key facts (validated 2026-09-02, micro, Pro org)

One project, no AWS. Separates the ceilings that get reported as one "Edge
Functions limit". Docs figures pinned in `lib/docs.ts` with the read date; the
RUNLOG has the module table and per-row evidence.

- **Functions per project is an entitlement** (`function.max_count`): free
  100 / pro 1000 / team 2000 on the lab orgs, matching the docs. A cap of
  exactly 1000 identifies Pro. `function.size_limit_mb` is 20 on EVERY plan -
  size is not a plan lever.
- **Function size is set by where bundling happens**, and the genuine
  rejection is `413 request entity too large` on BOTH paths: API/`--use-api`
  refuse 8 MB, CLI local (Docker) bundling lands 8 MB in ~32 s and refuses
  24 MB with the same 413 body on the "create function" call. A 413 alone does
  not say which ceiling; reproduce serially before ruling the flaky parallel
  413 in or out.
- **Secrets: four limits, all bite at the documented boundary** (400 with a
  zod-style message; the 101st says `You can only store 100 secrets per project
  at maximum.`). The value ceiling counts CHARACTERS (24,576 three-byte chars
  = 73,728 bytes accepted). `GET /secrets` lists seven platform `SUPABASE_*`
  entries once any function exists; they do not count toward the 100.
- **Silent loss reproduces on a fresh project with no 429 on any deploy
  response**: 24 API deploys 8-wide -> 24x 201, 10 present; 8 concurrent CLI
  processes x 3 functions each -> 8x exit 0, 9/24 functions present, no 429
  text in any process output. Whether the follow-up GET/DELETE calls were
  throttled is not recorded (the helpers retry through 429 silently). Not a
  read-lag artifact (cleanup listing minutes later agreed). Same-slug
  concurrent deploys answer **409** (3 of 6), versions stay monotonic - 409 is
  the same-slug signature, distinct from 429.
- **Restrictions**: HTML->text/plain is GET-only (POST keeps text/html). Port
  25 hangs (timeout), **587 was reachable** on two runs (TCP connect), 465
  open. Worker undefined; node:vm import `NotCapable`. Static files via the
  API deploy: **201 and the asset is missing at runtime** (deploy says success,
  function 500s); via CLI local bundling with `static_files` they work - paths
  are relative to `supabase/` (`./functions/<name>/...`), and a wrong glob
  ships a 654 B bundle silently. `npm:sharp` bundles (201) and 500s at run time.
- **Runtime ceilings**: a 3 s CPU loop and a 400 MB allocation both answer
  `546 WORKER_RESOURCE_LIMIT` with identical bodies (500 ms and 64 MB pass;
  the docs place the limits at 2 s and 256 MB, not measured to the edge) -
  indistinguishable from the response. Idle: edge-resilience W13. **Active
  wall clock (EF09)**: a stream ticking every 5 s was cut after 395 s (paid
  project; docs 400 s), seen by the client as a truncated body, not an HTTP
  error.
- **Log limits bite exactly (EF08)**: a 12,019-char line stored as 10,000
  chars + ` ....[truncated]`; 150 events in one invocation -> the first 100
  kept. Neither fails the invocation. Read back via the logs endpoint with
  `source = 'function_logs'` - and that endpoint answered `Backend error!
  Retry your query.` to all four queries tried with neither
  `iso_timestamp_start` nor `iso_timestamp_end` (2026-09-02), the erfi.dev
  logs-endpoint guide's own SQL example among them.
- **The recursive cap did not bite (EF10)**: ~110,600 nested calls/min for a
  minute at concurrency 100 (docs ~5000/min); 27 refusals (13 outer, 14
  inner) across 59,562 chains / ~119,000 nested calls answered
  `429 RATE_LIMIT_EXCEEDED "Too many requests. Re-try the request in 1
  seconds."`, nothing else refused.
- **Races repeated (EF11)**: delete-during-deploy x10 -> 8 healthy, 2 absent,
  every redeploy 201/200, 0 corrupted (the 2 absent slugs each had a delete in
  flight, so 201-then-absent is not counted as the third signature); same-slug
  4-wide x5 -> 201:9 | 409:11, version read once per round and monotonic (one
  bump per round even where two of four answered 201), healthy. Still "no
  signature at this scale"; absence is not proven.
- Harness rules here: a deploy is never "done" on status/exit code -
  `lib/ef.ts` `landed()` reads GET afterwards and size acceptances are proven by
  invoking. Big sources are random base64 (a repeated character measures the
  compressor). `lib/triage.ts` is the triage order (error string, parallelism,
  landing) as a pure function, unit tested on the verbatim strings above.
  Entitlements are a FLAT list keyed by feature (canonical shape in the
  platform-facts section above); platform-facts F01 was rewritten to it the
  same day.
- CLI 2.116.0 has a hidden `--use-docker` flag in addition to `--use-api`
  (they select opposite bundling paths; pass one), deploys without a
  `config.toml` given `--project-ref` + `--workdir`, and bundles locally by
  default when Docker is present.
- Run the destructive battery detached; a killed run leaves functions deployed.

## experiments/self-hosted-auth - key facts (validated 2026-09-02, micro, Pro org, GoTrue v2.196.0)

One project plus one local container: a GoTrue you run yourself
(`supabase/gotrue:v2.196.0`, matching the managed version) pointed at the
managed project's Postgres through the session pooler. Can it stand in for
managed Auth? Yes, with two dependencies the platform controls: the legacy
HS256 signing key must stay `previously_used` (revoking it kills every
self-hosted token), and the oct JWK must carry no kid or the managed PostgREST
refuses the tokens. RUNLOG has the per-row record and the three-project
history.

- **Role**: `supabase_auth_admin` is reserved on the platform (`42501 ... is a
  reserved role, only superusers can modify it` / `role memberships are
  reserved`), so the self-hosted GoTrue connects as `postgres`: USAGE on auth,
  INSERT on users/refresh_tokens/sessions, no CREATE on the schema, no INSERT
  on `auth.schema_migrations`. The connection URL MUST carry
  `?search_path=auth` - `postgres` defaults to `"$user", public, extensions`,
  the migrator then creates an empty `public.schema_migrations`, decides
  nothing is applied, and dies on `00_init_auth_schema` with `permission
  denied for schema auth`. With the search_path it reports `migrations applied
  successfully count=0` (77 platform rows cover all 70 image files).
- **Trust is real and mutual**: a self-hosted admin-created user shows in the
  managed admin list; a self-hosted HS256 token (signed with the project's
  legacy `jwt_secret`, iss mirrored) is accepted by managed `/auth/v1/user`
  (200) and PostgREST (200, authenticated-only row) because the HS256 key is
  `previously_used`. Refresh tokens redeem across sides both ways (one
  `auth.refresh_tokens`). The managed ES256 token is refused by the
  self-hosted side (`403 bad_jwt`) until `GOTRUE_JWT_KEYS` carries the
  platform's ES256 public JWK as verify-only - then 200 (`make gotrue-up
  JWKS=1`).
- **The kid rule**: in JWKS mode the self-hosted GoTrue stamps its signing
  key's kid into the header, and the managed PostgREST answers `401 PGRST301`
  to a self-hosted HS256 token carrying ANY kid - arbitrary or the platform's
  own HS256 key id - while the managed GoTrue verifies the same token. The oct
  JWK must carry no kid. Two managed verifiers, two rules.
- **What the platform can take away**: `PATCH signing-keys/{id} {status:
  revoked}` on the HS256 signing key -> the self-hosted token is refused by
  managed `/user` (`403 bad_jwt`) and PostgREST (`401 PGRST301`) within 3 to
  6 s across three projects (4 s on project 3, the uncontaminated run), AND
  the legacy `anon` (PostgREST 401) and `service_role` (admin 403) API keys
  die with it while `sb_publishable_` / `sb_secret_` keep working. The
  self-hosted signer lives exactly as long as that signing key stays
  `previously_used`. SH05's cleanup falls back to SQL for that reason.
- **Own key removes the dependency (SH06)**: `make gotrue-up OWNKEY=1` signs
  with a generated ES256 key; the public half is published from an Edge
  Function on the project and registered as third-party auth (`jwks_url`); a
  token signed with that key was accepted by PostgREST 4 s after registration
  and STILL read 200 from PostgREST after the legacy HS256 key was revoked
  (with the legacy anon apikey and with `sb_publishable_`). Managed
  `/auth/v1/user` refuses third-party tokens (`403 bad_jwt`). The anon JWT
  under the revoked key still passed as apikey in SH06 (probed 10 s after the
  revoke) but not as bearer in SH05 (within 4 s): either the gateway matches
  the apikey by value and PostgREST verifies only the bearer, or a gateway
  cache had not expired yet (L05 measured ~45 s for the legacy-key disable);
  not separated.
- Not settled: whether Storage/Realtime verify a third-party token (bucket
  list answers anon too), pooler behaviour under load, an image ahead of the
  platform (no public tag newer than v2.196.0 on 2026-09-02), making the
  managed Auth endpoint unreachable (no lever).
- Ops: four throwaway projects in one day; SH05 and SH06 each revoke the
  HS256 key (irreversible) - run each alone on a fresh project and destroy
  after. `make gotrue-up` / `gotrue-up JWKS=1` / `gotrue-up OWNKEY=1` /
  `gotrue-down` / `probe IDS=...` (`BUILD=0 RUNNER="bun .../run.ts"` to run
  from source while another battery holds the binary) / `destroy`.

## experiments/identity-transfer - key facts (IT01 2026-09-07 managed micro; ITL1-ITL3 2026-09-11 local rig)

- Question: a person returns from an OAuth provider with a NEW subject (the
  Apple Developer team-transfer shape - Apple's `sub` and private relay email
  are team-scoped). Apple is not mintable, so IT01 drives the project's
  Keycloak slot: `external_keycloak_url` is a per-project issuer URL (Azure,
  GitLab and WorkOS have URL settings too); the Auth server appends
  `/protocol/openid-connect/{auth,token,userinfo}`, checks no issuer, and reads
  sub/email/email_verified from userinfo. `worker/issuer.ts` is a stateless
  Cloudflare Worker: the test appends `persona=<base64url JSON>` to the
  authorize URL the Auth server redirected to; the persona rides back as the
  code, the access token, and the userinfo body. The sign-in is the browser
  flow with `redirect: "manual"` on all three hops; the user id is the token's
  `sub`. `site_url` is set to a localhost callback for the run and restored.
- Measured: identity = (provider, subject) with `provider_id` equal to
  `identity_data.sub`; a new subject with the same VERIFIED email links as a
  second identity on the same user; a different email is a new user (the
  relay-address case); `update auth.identities set provider_id = new,
  identity_data = identity_data || {"sub": new}` makes the new subject, even
  with a new email, land on the old user with one identity row and the old
  subject a stranger - `identity_data.email` takes the new address while
  `auth.users.email` and the token's email claim keep the old one; an
  unverified email is refused with `provider_email_needs_verification` but the
  server still writes an identity row AND a user row with `auth.users.email`
  NULL - sweep cleanup by identity subject, not by user email (the first run
  left that row). Config settle: false on the first `/auth/v1/settings` read,
  true on the second, 3-5 s from the PATCH at a 3 s poll interval. See
  experiments/identity-transfer/RUNLOG.md.
- Apple-specific and source-read only: the Apple parser copies `transfer_sub`
  and `is_private_email` into the provider claims' custom-claims map; Apple's
  `/auth/usermigrationinfo` exchange (sending team mints `transfer_sub` per
  user with `target=<recipient team id>`, receiving team exchanges it for the
  new `sub` and relay email, within 60 days of accepting the transfer) is the
  other half. Apple's public docs carry the pre-transfer steps IT01 cannot see,
  none of them verified here: the migration call needs an access token from
  `POST /auth/token` with `grant_type=client_credentials&scope=user.migration`
  and carries `client_id` and `client_secret` as well as `sub`/`target`;
  grouped Sign in with Apple apps must be ungrouped before the transfer; the
  Services ID transfers with the primary App ID; past 60 days both teams'
  endpoints go dead and the app has to be transferred back and forward again
  (TN3159, "Migrating Sign in with Apple users for an app transfer"). The
  "Authenticating users with Sign in with Apple" page also states that the
  identity token carries the user's email address "on all subsequent API
  responses" while name is returned only on the first - relevant because the
  email fallback in `DetermineAccountLinking` is what relinks a real-address
  Apple user after a transfer. Treat that as Apple's documented claim rather
  than a measured one: no run here has watched a real Apple token sequence.
- ITL1-ITL3 (2026-09-11, green, local rig, NOT the managed platform): a
  throwaway `supabase/auth:v2.197.0` in Docker (`local/compose.yml`, `make
  local-up` / `local-probe` / `local-down`), same issuer worker served over
  HTTP by Bun and sharing the auth container's network namespace, because the
  hook validator accepts `http` only for localhost, 127.0.0.1, ::1 and
  host.docker.internal. Chosen vantage: linking.go, api/hooks.go and
  provider/{keycloak,oidc}.go are byte-identical between v2.197.0 and master
  as of that date, and these three questions are about that code. Measured:
  the identity lookup reads the `provider_id` COLUMN, not `identity_data.sub`
  (ITL1b rewrote only the column, left the JSON copy stale, and the new
  subject still landed on the old user - IT01d rewrote both and could not
  separate them); one sign-in after the remap rewrites `raw_user_meta_data`
  sub/provider_id/email AND `identity_data` sub/email to the new values, while
  `auth.users.email` and the token's email claim keep the old address (ITL1c),
  so hand-patching the metadata is wasted work and skipping `auth.users.email`
  leaves the project mailing a dead relay; a `transfer_sub`-shaped claim is
  stored on both rows, is read by nothing (ITL2b hands it the old identity's
  exact subject and still gets a new user), and does not survive one sign-in
  that omits it (ITL2c); the Before User Created hook is armed by the
  CreateAccount decision ALONE (ITL3b/ITL3c carry a claim ITL3d proves it
  refuses, down the LinkAccount and AccountExists paths, and get sessions),
  its payload carries `user.user_metadata.custom_claims.transfer_sub` and
  `user.email`, and a refusal leaves 0 `auth.users` rows behind - unlike
  IT01e's unverified-email refusal. Not probed: the managed platform's hook
  config surface (`hook_before_user_created_enabled` / `_uri` / `_secrets` are
  read off the published Management API document; IT02 and IT03 are the
  managed-vantage modules and have NOT been run).

## experiments/audit-integrity - key facts (validated 2026-09-08, micro x2 on Pro + Team orgs; entitlements and members read on Free + Pro + Team)

- Question: the tenant of a managed project is also its administrator, so
  "is the audit trail tamper-proof" reduces to which side of the tenant
  boundary each copy of an event lives on. Two fresh Micros, one per plan,
  because the DB-side facts turned out plan-independent and the retention and
  export surfaces are entitlements. `make probe ORG=team` repoints the battery.
- `auth.audit_log_entries` is owned by `supabase_auth_admin` with ACL
  `{supabase_auth_admin=arwdDxtm, dashboard_user=arwdDxtm, postgres=ar*wdDxtm}`.
  4 of 10 roles can delete; `supabase_read_only_user` is select-only;
  `service_role`, `anon` and `authenticated` hold NOTHING, not even select (an
  older session note claiming service_role can tamper here is wrong for PG17).
  PK only, no FK, no triggers, so no cascade and no sequence gap to detect a
  deletion by. As `postgres`: insert of a backdated forged entry, in-place
  UPDATE of `ip_address` and action, DELETE and TRUNCATE all accepted.
- **The in-database copy is OFF by default and the API cannot switch it on.**
  `GET config/auth` returns `audit_log_disable_postgres=true` (present in the
  response, absent from the spec); PATCHing the OPPOSITE value answers 200 and
  changes nothing. Dashboard-only. This confirms the lexicanum MFA/impersonation
  guide's 2026-07-24 measurement on a fresh project in another region. Any
  module that needs a populated table reads `auditCopyEnabled()` and skips with
  a reason - patching a value to itself, and scoring `0 before, 0 after` as a
  pass, were both bugs in the first pass.
- **Erasure is unlogged by default; the positive control is what makes that
  claim safe.** Defaults are `log_statement=ddl`, `log_connections=off`,
  `log_min_duration_statement=-1`, no pgaudit. A nonce-carrying DDL statement was
  first seen in `postgres_logs` 32 s after it was fired, while a bare DELETE and
  TRUNCATE with their own nonces were still absent at the end of a 192 s search
  at a 30 s poll interval. The 189 s / 191 s figures the first write-up
  published as the control's lag were the search loop's EXIT time:
  `findMarkers` ran to its timeout because the two missing nonces never arrive.
  It records per-marker first-seen times now, which is what produced the 32 s. `PUT config/database/postgres {log_statement}` -> 400
  `Unrecognized key`; the GET answered 0 keys on both fresh projects, and
  "returns only overrides that have been set" is the inference that fits, not a
  tested rule.
  pgaudit SESSION mode catches DELETE and TRUNCATE, both first seen 32 s later;
  OBJECT mode catches the DELETE at 33 s and produces NO line for the TRUNCATE
  across a 193 s window even with `truncate` granted to the auditor role. So
  object mode alone leaves the fastest erasure path unlogged - the write-up
  claimed both modes caught both until the 06:35 UTC pass measured it. Neither
  mode needs a restart (`alter role postgres set pgaudit.log` applies to new
  sessions). `log_connections` DOES take through the API (PUT 200, GET echoes
  true, a later session reports `on`), though no connection line was seen in
  the 97 s after.
- **The stream is the copy the tenant cannot reach.** With the copy OFF: 3
  users + 3 logins -> 6 rows in `auth_audit_logs` 2 s after the writes, 0 in
  the table. With it ON (Dashboard, Run 4): 6 in each, stream at 33 s, then a
  DELETE took the table **6 -> 0** and left the stream at **6**. That count
  pair over one window is the tamper check, and it needs nothing from the
  tenant's own logging. A forged table row never appears in the stream (126-127
  s searches, two runs). `GET /auth/v1/admin/audit` is a window onto the TABLE:
  0 entries with the copy off, and with it on the tagged entries went **2 -> 0**
  when the table rows were deleted. DELETE/POST on it are 405.
- **A hash-chained mirror catches an interior deletion, and by construction an
  edit to a row's hashed contents; it does not catch truncation.** No module
  edited a mirror row, so the edit half is arithmetic and not a measurement. A trigger on `auth.audit_log_entries` fires for GoTrue's own
  insert (SECURITY DEFINER capture, 4-row mirror, chain clean). Deleting the
  TAIL (`seq 4` of 4) leaves the verifier silent; deleting an interior row
  (`seq 2` of 3) breaks it at `seq 3`; rehashing every row silences it again and
  moves only the head hash (`5d462b0c1893` -> `2eb685578caa`). The A09c row in
  the 06:10 UTC pass was WRONG - a 2-row mirror made "the second row" the tail,
  so it measured truncation while claiming an interior cut. The module now makes
  two users and reports the two shapes separately (06:15 UTC pass).
- **Attribution is by path, never by person.** Every tenant path arrives as
  `postgres`; only `application_name` differs (`mgmt-api` vs
  `supabase/dashboard-query-editor`, confirmed both in the Dashboard and in
  `postgres_logs`). The platform appends `-- source:` / `-- user: pat:<id>` /
  `-- date:` to statements it runs. `postgres` CANNOT `set role dashboard_user`
  or `supabase_read_only_user` (`permission denied to set role`), so the
  Dashboard connects as those roles directly.
- **Retention and export are per-plan entitlements** (`GET
  /organizations/{slug}/entitlements`, 64 each): `security.audit_logs_days`
  free 0/no-access, pro 0/no-access, team 62; `log.retention_days` 1 / 7 / 28;
  `backup.retention_days` 0 / 7 / 14; `audit_log_drains` false/false/true;
  `log_drains` false/true/true. A Pro project has NO platform audit log; its
  whole auth audit trail is a 7-day stream and its only preservation lever is a
  project log drain. The platform audit log has no API surface at all - 0 of
  115 `/v1` paths mention audit - so it cannot be exported OR rewritten.
- **`POST /projects/{ref}/cli/login-role {read_only}` is the practical
  control**: 201 with role + password + `ttl 300`, and BOTH variants
  (`cli_login_supabase_read_only_user` and `cli_login_postgres`) are refused on
  the audit table with `permission denied for schema auth` when connected
  through the session pooler. A JIT credential is strictly weaker against the
  audit trail than the project database password. Revocation is measured with
  the credential itself (06:35 UTC pass): the same role and password answered
  before `DELETE /cli/login-role` (200) and got `FATAL: (EAUTHQUERY) user not
  found in the database` after. The earlier version probed with a deliberately
  WRONG password, which cannot distinguish a revoked role from a live one. A
  freshly minted credential is also not immediately usable: one connect failed
  seconds after minting while later probes on the same role authenticated.
- **The organization audit log records control-plane calls and project
  lifecycle; SQL execution is absent from it.** Dashboard-only read (no `/v1`
  path exists), Team-plan org: it carries actor + organization role + method +
  description + status + target project + timestamp, INCLUDING reads (`GET Get
  project api keys`) and lifecycle (`Create a project`, `Deletes the given
  project`). A13 settles it with a control that IS audited - a `PATCH
  config/auth` fired 0.2 s before a `database/query` DELETE: control recorded
  at 06:56:47, neither the API SQL nor a Dashboard SQL Editor statement
  recorded, both proven to have executed via `postgres_logs`. The audit-log
  column is an operator read the module stores verbatim
  (`PVLAB_AUDIT_OBSERVED`), because nothing in the harness can assert it. The
  first control choice
  for this comparison (`GET /functions`) was itself unaudited and proved
  nothing; the battery's own PUT/PATCH/POST/DELETE served as the control.
- The Dashboard UI labels the switch in the POSITIVE form ("Write audit logs to
  the database"), where the vendor docs describe the negative ("Disable
  writing auth audit logs to project database"). Anyone following the doc text
  looks for the opposite switch.
- Pending: a restore-and-diff recovery of deleted rows. NOT an omission - a
  decision: A10c prices PITR at \$100/month (7 days), \$200 (14), \$400 (28),
  and applying it does not create a restore point until a base backup lands, so
  the probe is a monthly charge plus an indeterminate wait. Also pending: a
  Read-Only member exercised end to end (none exists in any of the three orgs).
  See experiments/audit-integrity/RUNLOG.md.

## experiments/s2z-wake - key facts (2026-09-09 platform-plan org on the STAGING control plane; 2026-09-23 close-out on production free-plan)

Whether a Management API call wakes a parked project and so restarts billable
compute. Enumerated from the published OpenAPI document rather than by guessing
path names (the F05 method note in platform-facts): 169 operations, and
`harness/scripts/gen-surface.ts` reconciles coverage against the document on
every run, printing uncovered operations by name.

- **No Management API operation wakes a parked project.** 52 parameter-free
  project GETs (Z01, executed) plus 73 write operations (script-measured, see
  the RUNLOG - Z02 exists but has never run), zero wakers. The endpoints that
  need the instance fail instead: `544` carries a connection timeout and costs
  the caller the full wait (`/database/migrations` 20.0 s), seven answer `500`.
  `POST /pause` and `POST /restore` are declared exclusions - they change state
  by definition.
- **A parked project has NO public DNS record.** NXDOMAIN on two independent
  resolvers, `db.<ref>` gone too, while a healthy sibling resolves. This is why
  the null result is structural rather than incidental: there is no hostname
  for traffic to arrive at. The `HTTP 540 Project paused` reading that
  instance-sizing I04 recorded is a TRANSIENT during teardown - measured
  seconds after the pause completed, with DNS still live or cached. At 13 and
  50 minutes parked the answer is NXDOMAIN.
- **Auto-pause lands in the same state as a manual pause** (2026-09-23): two
  production free-plan projects that auto-paused read NXDOMAIN on both
  resolvers, identical to the manual-pause reading. The control project carries
  that result - nothing touched it after its create call.
- **Three endpoints answer `200` with an empty body when parked** after
  answering `200` with content while awake: `/api-keys` (1524 B to `[]`),
  `/advisors/performance` (763 B to `{"lints":[]}`), `/config/database/pooler`
  (574 B to `[]`). A status-code check cannot tell "nothing to report" from
  "could not look", so a fleet-wide advisor sweep scores every parked tenant
  clean. Z01 seeds a real advisor finding before its awake pass so the check
  has something to lose; an earlier size-threshold version reported eight false
  positives on endpoints that are legitimately empty on a fresh project.
- **Manual pause and restore timing on a platform-plan nano**: pause 50-70 s to
  `INACTIVE` (n=4), restore 170-220 s to `ACTIVE_HEALTHY` via
  `COMING_UP -> RESTORING` (n=3). A pause issued the moment a restore reports
  healthy is refused with `400` - there is a settle period.
- **The staging control plane does not appear to run the inactivity reaper.**
  Twelve nano projects on a staging platform-plan org sat 13 days with zero
  activity and none auto-paused, while production free-plan projects auto-paused
  over the same window. Z03/Z04 (the auto-pause fan-out, one project per wake
  candidate) are therefore built and never fired. Point them at production
  free-plan projects, and mind the 2-active-project cap per free org.
- **Scale-to-zero/hibernation was never reachable** on any account available.
  Four ladder rungs to 2 hours of idleness showed no elevated first-request
  latency and no `project_hibernating`; the subject then auto-paused instead.
  Sub-second spikes around 0.65 s occur on a project known to be warm, so the
  wake threshold is over 3 s on a rung's first sample, not "elevated over the
  0.04-0.11 s baseline".
- **Staging PATs expire after 24 hours.** Every `401` across this experiment
  was expiry, not revocation; a resume instruction that assumes a stored token
  survives between sessions is wrong.
- Two of the control-plane reads in this sweep return live credential material
  in full rather than redacted, to any PAT holder. Treat a PAT as equivalent to
  full project access when scoping one; it is not a read-only analytics
  credential. The `?reveal=true` redaction sfp-platforms S14 documented applies
  to the api-keys CREATE response and does not extend to every read.


## experiments/github-branching - key facts (validated 2026-09-23 and 2026-09-29, micro x2, Pro org)

Two projects connected to ONE repository, workdirs `apps/a` and `apps/b`,
Automatic branching on. The GitHub connection is dashboard-only (no provider
resource); `GET /v2/organizations/{slug}/integrations/github/connections`
reads it back, including `supabase_changes_only`. Details: RUNLOG.md.

- **With "Supabase changes only" off, the working directory does not scope
  preview creation; with it on, a project previews only pull requests changing
  its own `<workdir>/supabase/`.** Off: both projects previewed all five pull
  request shapes, a root README change included (GB01 run 1). On:
  `apps/a/README.md` did not trigger A (GB01 run 2); tested with migrations
  only.
- **Every connected project posts `Supabase Preview` check-runs to every pull
  request head commit read.** Same name, same app; one check suite on the
  setting-off commits (RUNLOG snapshot). A project that branches
  posted 5 or 6 (1 `skipped`, 1 `success` or `failure`, 3 or 4 left
  `in_progress`: at 600 s in GB01 run 2 and GB02, at the 01:59:12 snapshot in
  GB01 run 1, at 480 s in GB03); one that does not, with
  changes-only on, posted 2, both `skipped`. Of `external_id`, `details_url`,
  output title and summary, only `details_url` carries a project ref (the
  parent's, then the preview branch's own).
- **Read check-runs with `filter=all`.** The endpoint's default (`latest`)
  returns one run per name, which on these commits is one project's. GB01's
  first revision undercounted 10 runs as 1 because of it.
- **The docs' `fountainhead/action-wait-for-check@v1.2.0` workflow read
  project B's run on both GB02 pull requests.** With a path filter on app A,
  it returned B's `skipped` on an A-only pull request (migrate job skipped)
  and B's `success` on a two-app one.
- **An action run's `check_run_id` is not a wait target**: it pointed at a
  run left `in_progress` while the action's steps were all `EXITED`.
- **Per-project signal: the parent's branch list, matched on `git_branch`.**
  `status` went `CREATING_PROJECT` -> `RUNNING_MIGRATIONS` ->
  `MIGRATIONS_FAILED` for A and -> `FUNCTIONS_DEPLOYED` for B (GB03). The
  first sample (15 s) read `FUNCTIONS_DEPLOYED` on both, before
  `CREATING_PROJECT` appeared at 32 s, so a waiter should not accept
  `FUNCTIONS_DEPLOYED` until it has seen a non-terminal state. The OpenAPI
  document marks the field deprecated. The failed preview's action run showed `migrate:DEAD`.
- **Each of four file kinds under `<workdir>/supabase/` triggered a preview
  with changes-only on** (GB04, project A only): `seed.sql`, a `config.toml`
  comment, a new function (flagged: only functions declared in `config.toml`
  deploy to branches) and a `NOTES.md` the CLI never reads.
- **With changes-only on, a pull request that opened without Supabase changes
  did not preview after a migration was pushed; close and reopen did** (GB05):
  no preview in 240 s after the push; one at the first 20 s poll after the
  reopen. A
  `seed.sql` change pushed to an existing preview did not re-seed it (row
  absent 240 s later), as the bot comment says.
- **The bot comments once per connected project** (GB04), each starting
  `[supa]:<ref>`. The ignored project's comment carries its parent ref and
  names its directory; a branching project's carries its preview ref (not the
  parent's), so the comments alone do not tie a branching project to its
  parent; check-run `details_url` does on the early runs (GB01).
- **A merge that changed only A's `supabase/` also started a production action
  run on B** (GB06, one merge): 1 new action run on each parent within 240 s,
  both `clone,deploy,health,migrate,pull,seed` EXITED and `configure` PAUSED,
  and 3 check-runs per project on the merge commit; changes-only on did not
  stop B's run. The migration landed on A only.
- **Preview-branch secrets (GB07, 2026-09-29, project A, one run per shape).**
  `GET /v1/projects/{ref}/secrets` lists `value` as the SHA-256 of the value
  set (2 of 2 checked: the parent control and the dotenvx preview). An Edge
  Function secret set on the parent, not referenced in `config.toml`, was
  absent from the three previews that returned readings (secrets list and
  function env); the wrongkey preview listed nothing at all. A
  dotenvx `.env.preview` under `apps/a/supabase/`, mapped through
  `[edge_runtime.secrets]` + `env()`, with `DOTENV_PRIVATE_KEY_PREVIEW` set on
  the parent only, reached the preview's function with the set value; the key
  itself was absent from the dotenvx preview, so decryption used the parent's copy
  (inferred: no shape ran without the key on the parent). A `.env.preview`
  built the same way but encrypted to a key the parent does not hold:
  `clone:DEAD`, nothing deployed, bot comment (read by hand, not in the
  artifact) `failed to decrypt secret: ... message authentication failed`,
  and branch `status` `MIGRATIONS_FAILED` although no migration ran. An
  `env(NAME)` with no value anywhere: every step `EXITED`,
  `FUNCTIONS_DEPLOYED`, the secret absent. The parser error in the bot
  comment (read by hand) gives the secret name lowercased
  (`pvlab_gb07_wrongkey`).
- Harness notes: `gh api` writes under `.github/workflows/` need the OAuth
  `workflow` scope, so GB02's workflow goes in over SSH (`make push-ci`).
  The connection form defaults Branch limit to 3; raise it before a matrix
  run. `make publish-evidence REPO=...` strips the repository name, which has
  no identifier shape for the shared redaction to catch.

## Write-up workflow (added 2026-09-02 after three review passes)

The numbers that went wrong in that day's write-ups were all retyped from
memory of a run; the artifact had the right value every time. The tooling now
assumes prose quotes by paste.

- `pvlab --facts run.json [--only EF08,EF09]` renders a run's measurements as
  markdown tables (offline, no credential). Quote from it.
- `make publish-evidence RUN=evidence/<ts>/run-<stamp>.json` (per experiment)
  redacts refs, project and pooler hostnames and emails and writes the artifact
  plus its facts.md to `out/<date>/`, which IS committed (`.gitignore` carves
  dated `experiments/*/out/20*/` directories out of `**/out/`; raw artifacts
  at an `out/` root stay ignored). edge-resilience's 14 raw runs from
  2026-08-16/17 were published this way on 2026-09-02 (redacted JSON, facts
  and report per run under `out/2026-08-16/` and `out/2026-08-17/`; the raw
  originals moved to the ignored `evidence/raw-out/`). RUNLOGs and the docs
  site cite `out/`; `evidence/` stays private.
- `bun harness/scripts/check-doc-numbers.ts <doc> <run.json> ...` lists every
  number on a measured line of a doc that appears in none of the artifacts -
  the reviewer's hand check as a command. Judge each hit: a documented figure
  is fine, a retyped measurement is the bug.
- `harness/src/identifiers.test.ts` scans every tracked markdown file,
  every `out/` artifact and (since 2026-09-07) every tracked source, config
  and script file for the project-ref SHAPE (20 lowercase letters) and for
  emails, so a ref nobody listed still fails `bun test harness`. The
  2026-09-07 history sweep found four modules (I03, L01, M04) and the
  rendered edge-resilience wrangler.jsonc holding refs as constants at HEAD
  while the prose-only scan passed; the refs moved to `ctx.peers.legacy`,
  `ctx.peers.scoped` (else `ctx.ref`) and `ctx.peers.standing`, wrangler.jsonc
  is gitignored (render-wrangler.ts recreates it), and the history was
  rewritten with git filter-repo the same day. Its first
  run (2026-09-02) found two project refs and the Pro org slug in three tracked
  files from August (two RUNLOGs, one plan doc), all redacted the same day; the
  hand-run sweeps had missed them for a month. The eighteen modules that
  carried org slugs as constants in test SOURCE (compute-disk, instance-sizing,
  byo-oauth, usage-metering, residency-facts R02, edge-resilience W21) now read
  `ctx.orgs.pro|team|free`, populated from `PVLAB_ORG_PRO|TEAM|FREE`, and skip
  with a reason when the role is absent; the local `.pi/probe-*.sh` scripts
  export the three roles.
- `harness/src/platform.ts` holds the helpers every experiment rewrote: `sql`
  (the query endpoint answers 201), `fetchKeys` (both key generations),
  `logsQuery` (the logs endpoint needs both time-window parameters),
  `functionPresent` (a deploy is not done on its exit code). Import from here.
- `bun harness/scripts/new-module.ts <experiment> <ID> <slug> "<question>"`
  scaffolds a module with the doc-comment skeleton: side/key/project named per
  row, per-row ids, DESTRUCTIVE and cleanup notes, "not settled by this module".
- `make probe-bg` runs a battery detached with a log (a killed run leaves
  functions deployed); `BUILD=0 RUNNER="bun $(ROOT)/harness/src/run.ts"` runs
  from source while another battery holds the compiled binary (Linux refuses
  to overwrite a running executable).
- The `lab-writeup` skill carries the ambiguity checklist and the reviewer
  brief; run the brief as a subagent on the diff before every commit of prose.

## Commands

Root: `make secrets-decrypt`, `make secrets-encrypt`, `make experiments`.
Per experiment: see its Makefile (`init phase1 wait-ready arns phase2
suite suite-clean ssm restrict unrestrict destroy`). `make suite` is the
automated path (SSM-deployed phases, S3 artifact pull, REPORT.md);
`make suite-clean` removes the suite S3 bucket, which is orchestration
state tofu does not track.

## experiments/wrappers-delete-scope - key facts (validated 2026-09-23, free org, Postgres 17.6, wrappers 0.6.2)

One throwaway project per run, created and deleted through the Management API
(free org, no tofu). The Studio SQL is generated from Studio's own pg-meta by
`scripts/gen-studio-sql.ts` into `lib/studio-sql.generated.ts`, pinned to a
supabase/supabase commit; regenerate it rather than hand-editing - the first
hand copy got the Vault secret name wrong. Details: RUNLOG.md.

- **The Wrappers list is per foreign server but labelled with the FDW name,
  and Delete and Edit both run `drop foreign data wrapper <name> cascade`.**
  Dashboard-created connections each own an FDW, so this removes one (X01a).
  Five servers on one shared FDW: Delete on any row removes all five, their
  foreign tables, and views/materialized views on them (X01b); Edit leaves only
  the edited one (X01c). Nothing warns.
- **The shared shape only comes from SQL.** Studio's create refuses an existing
  FDW name with `42710` and rolls back (X01e).
- **Without cascade, each step refuses to take more than it names.** `drop foreign data wrapper`,
  `drop server` and `drop foreign table` without cascade each refuse with
  `2BP01` while anything depends on them; drop view -> table -> server removes
  exactly one connection (X01d).
- **A cascade delete leaves the servers' Vault secrets**: Studio only deletes
  `<fdw>_<option>`, so SQL-created secrets survive.

## experiments/medium-serverless - key facts (validated 2026-09-30, Medium, ap-southeast-2, Team org, Postgres 17.6 image 17.6.1.166)

One Medium project probed from an IPv4-only vantage in Singapore, as a
serverless client on a shared multi-tenant project would see it. Every
earlier pooler and downtime number in this repo is Micro or Small.
Redacted artifacts: `out/2026-09-30/`. Details: RUNLOG.md.

- **The dedicated pooler (`db.<ref>.supabase.co:6543`) takes user `postgres`
  only**; the Supavisor tenant shape `postgres.<ref>` gets `no such user`
  (MS01d). pooler-semantics S01c/S02b take `PVLAB_ENDPOINT_POOLER_TXN_USER`
  for this.
- **Neither pooler's pool size or client cap is readable through the API**
  on this project: `/config/database/pooler` returns `default_pool_size null`,
  `max_client_conn null`; `/config/database/pgbouncer` omits both and returns
  `pool_mode transaction`, `query_wait_timeout 80`, `server_lifetime 3600`,
  `server_idle_timeout 600`, `reserve_pool_size 1` (MS01b). Measured from
  `pg_stat_activity` under 40 saturating clients: 16 concurrently active
  backends through the dedicated pooler, 17 through Supavisor (MS12).
- **`log_statement` ships as `ddl`, not the docs' `none`** (MS01a); with
  `log_min_error_statement=error` a FAILING statement's full text, literals
  included, lands in `postgres_logs` as `log_attributes['parsed.query']`; a
  succeeding statement's literal does not. Storage object paths are in
  `edge_logs` (`request.path`) and `storage_logs` (`objectPath`, and the
  worker's `ObjectRemoved:Delete` event). A Realtime topic name did not appear
  in `realtime_logs` (MS05). Ingestion lag exceeded 4 minutes on one run.
- **`logs.all` is gone (410 since 2026-09-23).** The unified `logs` table is
  ClickHouse SQL, filter on `source` (not the changelog's `source_name` - the
  corpus guide `supabase-management-api-logs-endpoint` already records this),
  nested fields via `log_attributes[...]`. The endpoint throttles; one query
  per 20-30 s held; the endpoint answers 10 requests per 60 s
  (`x-ratelimit-limit: 10`, `x-ratelimit-reset: 60`, 2026-10-10).
- **Enabling the IPv4 add-on left `db.<ref>.supabase.co` with no record for
  more than 10 minutes from this resolver** (AAAA withdrawn, A not yet
  visible, `getaddrinfo ENOTFOUND` for 217 samples at 500 ms), then an A at
  TTL 30. Shared pooler and REST: 0 failed samples through it (MS02).
  Negative caching at the vantage not ruled out.
- **A network restriction presents differently per path** (MS03): Supavisor
  refuses at 2.7-3.3 s with `(EADDRNOTALLOWED) address not in tenant
  allow_list`; direct 5432 and dedicated 6543 drop, so the client sees its own
  connect timeout (6.7 s here). Recovery 3.8-4.3 s on all four after restoring
  `0.0.0.0/0`. The PrivateLink reference's "hang to timeout means a security
  group" is not the only cause.
- **A dead client's open transaction is closed by the pooler itself in
  1.5-1.6 s on both poolers, with or without a role timeout** (MS04c/d). An
  ALIVE client stuck idle in a transaction is ended only by the role's
  `idle_in_transaction_session_timeout` (5s -> gone at 6.7 s, MS04e); with
  none it was still there at 30 s (MS04f). Role GUCs are honoured through
  both transaction poolers (MS04a). Supavisor refused a role's password
  seconds after the role was recreated and accepted it a minute later
  (MS04a second run, one occurrence).
- **Prisma 6.19 under 20 concurrent clients breaks on Supavisor transaction
  mode without `pgbouncer=true`** (7/500 iterations ok, `26000 prepared
  statement "s10" does not exist`), works on the dedicated PgBouncer with or
  without the flag, and the flag costs about five times per iteration on
  either pooler (p50 20384-20553 ms vs 4090-4207 ms; direct 4212 ms) (MS10).
  The single-client S01 matrix passes all 9 features on every mode and cannot
  see this.
- **Both poolers cap at the published 600 clients on Medium, Supavisor refusing the 601st and the dedicated PgBouncer holding 599** (MS09):
  PgBouncer `no more connections allowed (max_client_conn)`, Supavisor
  `(EMAXCONN) max client connections reached, limit: 600`. Connect p50 sat at
  5701-6011 ms from the first 50 clients up - the pool queue, not the cap, is
  what a client meets first. The `pg` client surfaced 0 queueing NOTICEs.
- **The dedicated pooler cost the instance more CPU than Supavisor at equal
  load**: 5.8% vs 3.5% busy (idle 0%) at 62.866998 vs 62.16422 tps of pgbench
  -S with 16 clients (MS08). The metrics endpoint exposes 123
  `pgbouncer_*`/`supavisor_*` lines.
- **S02 from Singapore is round-trip-bound**: 31.34425 / 31.449556 /
  31.173369 tps at 8 clients on direct / dedicated / shared, p95 262.2 /
  262.74 / 263.41 ms. Not a pooler measurement; the 1.5x PrivateLink ratio
  needs an in-region runner.
- **Postgres Changes with external-issuer tokens carrying Clerk's `o`
  claim** (MS11): RLS off, both subscribers received both tenants' rows; RLS
  on with `tenant_id = auth.jwt()->'o'->>'id'`, each received only its own;
  anon-key-only and unregistered-issuer subscribers received nothing; the
  unregistered issuer is refused at join with `JwtSignerError: Failed to
  generate JWT signer for key ID (kid)`.
- **Encrypting in an Edge Function before the row lands** (AES-GCM under
  WebCrypto, key in a function secret, pastebin-shaped envelope) cost p50 371
  / p95 843 ms per write against 216 / 610 ms for a plaintext Data API write
  from the same vantage; the row holds a 380-char blob with no plaintext, the
  function decrypts it, and the marker reached 0 log lines (MS14).
- **A read replica in the primary's own region is accepted and serves**
  (MS06): with `pitr_7` on, `read-replicas/setup {read_replica_region:
  ap-southeast-2}` on an ap-southeast-2 primary returned 204 at once; the
  `READ_REPLICA` entry appeared in the pooler config after 216 s and answered
  `pg_is_in_recovery() = true` after 219 s; removal 204, gone on the first
  poll. The docs only say "across multiple regions".
- **A Medium <-> Large resize costs 30-55 s per Postgres, Auth and Storage
  path and nothing on REST or Realtime** (MS07, n=1 each way): up Auth 35 s
  `HTTP 521`, Storage 34 s, shared 6543 30 s, shared 5432 36 s, dedicated 6543
  34 s, direct 35 s; down 42 / 44 / 39 / 39 / 55 / 41 s. Same shape as
  platform-downtime's Micro <-> Small, at a fraction of those windows (Auth
  131 s, pooler 207 s there). The dedicated PgBouncer came back last on the
  way down, answering `server login has been failing, cached error: connect
  failed (server_login_retry)` for ~14 s after Postgres was up. An addon PATCH
  right after another one answers 429 and `applyAddon` waits it out (185 s).
- **A custom hostname's `_acme-challenge` TXT is not in the initialize
  response**; it arrives on a later GET/reverify poll (3-23 s across four
  runs), after the `_cf-custom-hostname` ownership TXT. Re-read the record
  list on every poll and write what is new. With the records in DNS,
  verification took 45-193 s, activation reported complete within a second,
  and the name served (probed via 1.1.1.1's answer) 71 s after that; a
  Storage signed URL minted on the origin fetched 200 through the custom
  host; `/rest/v1/` answers the anon key 401 on both hosts; certificate
  issuer `Google Trust Services, CN=WE1` (MS13). Probe custom names from a
  public resolver: the LAN resolver here answers `10.0.10.1` for the lab
  zone (split-horizon), which cost two runs.
- **A preview branch created without git is healthy on the create call
  itself** (`POST /projects/{ref}/branches`, the call runs longer than 30 s,
  201) on `ci_micro` with a newer image than the parent; its `db_host` is
  IPv6-only, its Supavisor tenant (`postgres.<branch-ref>`) is readable via
  `GET /projects/<branch-ref>/config/database/pooler`. `prisma db push`
  over that path took 14859 ms; `GET /diff` returns the pushed schema as SQL;
  **`POST /merge` is accepted (201, workflow run id) and applies nothing**
  when there are no migration files (no `pg_net` on the parent 10 min later).
  DELETE on a persistent branch is `422 Cannot delete persistent branch.`;
  PATCH `persistent: false` first (MS15).
- Harness: `pg` `Client` needs an `error` handler before its socket is
  destroyed or the whole run dies; `import.meta.dir` in the compiled binary is
  the bundle. `publish-evidence` redacts keys and values alike (it runs over
  the raw JSON text). Until 2026-10-06 its `\b[a-z]{20}\b` let a ref
  touching `_` through (`b4d1083`, work-supabase-lab#10); a dot-joined
  `postgres.<ref>` was always caught, so the 2026-09-30 key leak most likely
  had the ref next to `_` or a digit (inferred - the leaked key was not kept).

## experiments/tls-surface - key facts (validated 2026-10-02, micro, ap-southeast-1, Team org)

- HTTP edge, every project name and `api.supabase.com`: TLS 1.0/1.1 refused
  (alert 70), 1.2/1.3 accepted; no SNI refused (alert 40); ECDSA + RSA
  leaves, 90-day lifetime; HSTS preload. `<ref>.supabase.co`,
  `<ref>.functions.supabase.co`, the custom domain and `api.supabase.com`
  accept 10 TLS 1.2 suites, four of them CBC (ECDHE-{ECDSA,RSA}-AES128-SHA256
  and -AES256-SHA384). `<ref>.storage.supabase.co` accepts 20, 12 CBC,
  including SHA-1 CBC and six static-RSA suites, and does not redirect port
  80 (cleartext gateway 404 on `/auth/v1/health`; the Storage route probed,
  `/storage/v1/version`, hangs after the client has sent its `apikey`).
  TL02 (per suite) and TL05 (per route) are columns, so `make diff` between
  two `make probe` runs shows any change.
- Postgres TLS 1.2 suites: Supavisor 6 (0 CBC), dedicated PgBouncer 6543 20
  (12 CBC), direct 5432 40 (22 CBC; `ssl_ciphers='HIGH:MEDIUM:+3DES:!aNULL'`;
  3DES not testable from an OpenSSL 3.6.5 client). PG17 direct TLS works on
  direct 5432 and the dedicated PgBouncer 6543, not on Supavisor. One private
  CA (Supabase Root 2021 CA, to 2031-04-26, sent in the chain); the
  direct-DB leaf runs to 2031-10-01, past its root.
- With SSL enforcement off (default) Supavisor's hop into Postgres is
  plaintext (`pg_stat_ssl.ssl=false`); PgBouncer's is TLS 1.3. Enforcement on
  makes every hop TLS and refuses plaintext within seconds, with a different
  message per path. Every enforcement switch, on or off, restarts Postgres,
  and switching on once refused a TLS client on Supavisor for 4 s (hba "no
  encryption" on the pooler's still-plaintext hop).
- Outbound: pg_net 0.20.4 refuses TLS < 1.2 and expired, self-signed,
  untrusted-root and wrong-host certificates, reaches CBC-only servers, and
  refused the revoked-cert host for a cause not established. An Edge Function
  cannot reach a CBC-only server and connects to the revoked-cert host
  (revocation not enforced; one host tested).
- Harness: TL14's in-process `node:dns` never saw the IPv4 add-on's A record
  (12- and 20-minute budgets) while `dig` did - poll with `dig`.
  `publish-evidence` redacts the publishing vantage's public IP by literal
  (Postgres names the client in hba refusals) and any addresses named in
  `PVLAB_REDACT_ADDRS`; documentation-range addresses stay.

## experiments/governed-starter-kit - key facts (validated 2026-10-07; K06 and K07 2026-10-10, micro, ap-southeast-1, Team org)

Two projects (`kit-live` baseline only, `kit-ready` baseline + example app +
agent + webhook) plus any `make new-app` backends. Details: the experiment's
README.md, RUNLOG.md and docs/.

- **PAT**: the `~/.supabase/access-token` keyfile returns 401 since
  2026-10-07; run every target under `sx SUPABASE_ACCESS_TOKEN --`.
- **`make probe` on macOS** runs `bun harness/src/run.ts` (the compiled
  `pvlab` is linux-x64 only). K01-K04 share the seeded users and rows: do not
  run two probes at once (a concurrent K02 row made K01.01 count 4 instead
  of 2).
- **K03 (agent chat) skips until an Anthropic key is a function secret**
  (`make fn-secret ANTHROPIC_ITEM=<vault item>`). First run against a model
  2026-10-09: 8 of 8 hosted with `claude-opus-5-5` (wording checks needed no
  change); the run used the key's remaining credit (API then answers 400
  "credit balance is too low"; the page now shows that reason). `/assistant`
  renders replies as Markdown without links, images or raw HTML (replies can
  quote untrusted KB text); `bun test src/app/assistant` in `app/` holds the
  hostile cases. `make agent-local ENV_FILE=<path>` runs the same checks
  (`lib/agent-chat-checks.ts`) on a local stack (5452x) with the key from a
  dotenv file the runner never reads; verified 2026-10-08 with a dummy key
  only (tool and embed checks pass, K03 reports `BLOCKED` with the reason).
- **The `with-supabase` scaffold does not run on Workers as generated**: next
  16.4.0 + OpenNext 1.20.9 500s every page, `cacheComponents: true` hangs.
  `make live-app-prep` pins next 16.3.8 and drops it. `create-next-app -e`
  needs the unauthenticated GitHub API (60/h per IP): pre-scaffold.
- **Wrangler**: the vault `CLOUDFLARE_TOKEN` fails Workers calls with 10000.
  For an agent use `sx CLOUDFLARE_API_TOKEN=CLOUDFLARE_STAGE_WORKERS_TOKEN
  CLOUDFLARE_ACCOUNT_ID --`: one account, Workers Scripts Write plus Workers
  KV Storage Read (without KV Read `wrangler delete` removes the Worker, then
  exits 1 listing KV namespaces). Not yet tried on the OpenNext app's asset
  upload.
- **Headless MCP**: the hosted Supabase MCP server takes the PAT as
  `"headers": {"Authorization": "Bearer ${SUPABASE_ACCESS_TOKEN}"}` in
  `.mcp.json` (Claude Code expands the variable), so `claude -p` needs no
  `/mcp` login. `apply_migration`/`execute_sql` with DROP, DELETE, TRUNCATE
  or an unbounded UPDATE ask for confirmation, which `-p` cannot give: the
  call returns `{"status":"cancelled"}` (repeated once on 2026-10-10); with an
  Elicitation hook `claude -p` can answer it (K07).
- **The in-app agent needs a Console API key** (or Bedrock/Vertex). A
  claude.ai subscription login may not be used inside a product
  (https://code.claude.com/docs/en/legal-and-compliance).
- **`make new-app`**: separate `supabase_project.app` for_each fed by the
  gitignored `apps.auto.tfvars`; every plan is jq-checked for exactly one
  create/delete. 15-16 s request to ready.
- **pg_net**: `postgres` cannot revoke PUBLIC execute on `net.*` (owned by
  supabase_admin). Delivery is at most once.
- **Dashboard Read-only role** (`supabase_read_only_user`) has BYPASSRLS and
  `pg_read_all_data`: it sees every department's rows.
- **BFF demo (`fanout-api` + `upstream-mock`, 2026-10-08, local and hosted)**:
  `make bff-local` runs `lib/bff-checks.ts` on a throwaway local stack
  (ports 5442x, so it does not clash with a default local stack); K05 runs
  the same checks against a deployed project and skips when `fanout-api`
  is not deployed. The cache is a Postgres table, not an isolate map, because
  hosted functions run many isolates. Hosted K05 8/8 on every run
  2026-10-08/09. The first call after each fresh deploy answers 502 (four of
  four): the function's own all-failed body, all four upstreams `timeout` at
  ~801 ms (read 2026-10-09); idle-for-hours without a redeploy answered 200.
  Make one warm-up call after a deploy before a demo.
- **Troubleshooting faults**: 400k `activity_events` rows hit the 8 s
  `authenticated` statement timeout, so the seed is 100k. pg_stat_statements
  has no entry for a statement that errors; the logs endpoint does.
- **App MCP server block (K06, 2026-10-10, new project per run)**: the
  Select 2026 library block (`https://supabase.com/library/r/mcp.json`, item
  `mcp`, installed in the kit as `supabase/functions/mcp`) with Supabase
  Middleware 1.0 (`pipeline`, `withOAuthProtectedResource`) ran on a new
  project (ES256 in use; deploy with `--use-api --no-verify-jwt`, 5 s).
  Measured: the unauthenticated call answers 401 `Bearer` with
  `resource_metadata`; dynamic client registration 201; the headless
  code flow (PKCE, consent through the API) issued 4 of 4 tokens carrying
  `client_id`, `aud=authenticated`, `scope=email`, ES256, 3600 s; tools ran as
  the user (alice 2 of 3 rows, carol 1, no overlap; employee refused,
  same-department manager approved, other-department manager refused); RLS on
  `auth.jwt() ->> 'client_id'` isolated client A, client B and a password
  session (null client_id) from each other. Refused with 401: publishable key,
  legacy anon JWT, garbage. The scope does not limit the Data API (200 with
  the same token). The block's `runtimeErrorResult` printed `[object Object]`
  for a PostgREST error (fixed in the kit copy). Not done: interactive client
  login, the OAuth Consent block, Workers deploy, a legacy-HS256 user token.
- **MCP confirmations (K07, 2026-10-10, hosted server `serverInfo` version
  0.13.0)**: the server speaks a legacy session shape and the 2026-07-28
  stateless shape; elicitation (`resultType: "input_required"`) is offered
  only to a request that declares `elicitation.form` in `params._meta` of the
  2026-07-28 shape. Raw clients with no capability, with a form capability
  declared at a 2025 `initialize`, and with URL elicitation only ran DROP,
  TRUNCATE, UPDATE and DELETE without WHERE and `apply_migration` with DROP
  with no confirmation (20 of 20). A form-capable client was asked for `drop`,
  `truncate`, `update`/`delete` without `where`, `delete ... where true`,
  `alter table ... drop column`, a `do` block with `execute 'drop ...'` and a
  multi-statement string; not for `update ... where true`, an `update` with a
  `where`, `insert`, `select` or a string literal containing DROP. Decline and
  cancel ran nothing. `skip_elicitations=<comma list>` is per tool and removes
  the prompt; wrong case, `all`, an unknown name and a repeated parameter
  answer HTTP 400. `read_only=true` stops DROP in Postgres (25006). One
  accepted `requestState` (expires about 120 s later; bound to tool, project
  and query hash) ran the same query again when replayed. `create_branch`:
  form clients get a cost message, decline/cancel create nothing; clients
  without form elicitation on a project-scoped URL cannot create one at all;
  account-scoped, they use `get_cost`/`confirm_cost` (no human step in the
  protocol) and can. `reset_branch`, `rebase_branch`, `delete_branch` raised
  no prompt. Claude Code 2.1.287 declares form and URL elicitation; with an
  Elicitation hook answering `hookSpecificOutput.action` it declined or
  accepted (SQL applied only on accept; branch created only on accept); with
  no hook, `-p` cancels. A hook with the answer nested under `decision`
  made every run report `cancelled`. Interactive dialog, other clients and
  `create_project` not run.

## experiments/static-hosting - key facts (validated 2026-10-06, micro, ap-southeast-1)

One project, no AWS (DNS through the Cloudflare API for the custom-domain
modules). Can a project host a static site the way Pages/Netlify do? Not on
the project hostnames; with the custom domain add-on, only under
`/functions/v1/<slug>/`. Details: RUNLOG.md; artifacts `out/2026-10-06/`.

- **A real Astro build does not render.** The same build on a local Bun static
  server rendered, hydrated its React island, applied its font and followed a
  nav link (HS05-control; "font" is the computed font-family, not the file); from a public bucket and from an Edge Function
  Chromium got `text/plain` and showed the source (HS05-storage, HS05-fn).
  Screenshots stay in gitignored `evidence/<ts>/screens/`.
- **Storage has no index document**: bucket root `400 InvalidKey`; `about/`,
  `about` and a missing path all answer HTTP `400` with `"statusCode":"404"`
  in the JSON body (HS02a-d). No SPA fallback, no custom 404.
- **The rewrite covers XHTML and XML too.** Storage and the Edge Function path
  both served `text/html`, `application/xhtml+xml` and `application/xml` as
  `text/plain`; `image/svg+xml` kept its type with `Content-Disposition:
  attachment`; every GET of those four types carried `Content-Security-Policy:
  default-src 'none'; sandbox` and `nosniff`, the other types neither (HS01,
  HS03). Uppercase `TEXT/HTML`, no-space
  `text/html;charset=utf-8`, `<ref>.functions.supabase.co`,
  `<ref>.storage.supabase.co` and signed URLs all stayed rewritten. On the
  function, POST and HEAD keep `text/html` (HEAD without the CSP/nosniff
  headers); neither was sent to Storage.
- Assets a site hosted elsewhere loads (CSS, JS, WASM, JSON, PNG, web manifest;
  fonts were not in the fixture set) keep their declared types; `max-age` uploads serve from the CDN
  (`cf-cache-status` HIT). An overwrite took 47085 ms to reach the public URL
  (HS02f), per object - there is no atomic deploy.
- Each host mounts a site under a different base path, so the build is made
  once per host (`make site`: dist-root, dist-storage, dist-fn via
  `SITE_BASE`). The function deploy inlines the build as base64 (538978 B of
  source, API path, 5 MB ceiling).
- **The custom domain lifts the rewrite for Edge Functions only** (HS05): the
  Astro build rendered through it at `/functions/v1/<slug>/`; the bucket
  through the same domain stayed `text/plain`. The gateway has no root route:
  `/` answers `404 {"error":"requested path is invalid"}` and only
  `/functions/v1/<slug>/` reaches a function (`/<slug>/` `404`,
  `/functions/<slug>/` `401`; HS05-domain-paths). Build with
  `SITE_BASE=/functions/v1/<slug>`.
- `custom-hostname/activate` answered `400` straight after reverify reported
  `4_origin_setup_completed` (verified at 175 s) and `201` about ten minutes
  later; cause not established (body not recorded). Three later cycles the
  same day (same hostname, fresh projects) verified in 67 s, 24 s and 66 s and
  got `201` on the first call. The retry (`lib/activate.ts`) is unit-tested
  (`make unit`) and has not fired live. HS04 creates its own probe fixture
  (`ensureSite`) - before that, `make domain-up` on a fresh project probed a
  missing object.
- HS06 is the contrast case: a Cloudflare Worker on an own hostname gives `/`,
  `308` clean-URL redirects and a real 404 in front of Storage (no custom
  domain needed) or the function (`/about` -> `308` to `/about/`, recorded
  from the re-run on). Supabase then only holds the files.
- Harness: runs from source by default (`dist/pvlab` is linux-x64 and HS05
  drives a local Chromium via `site/browser-check.ts` as a subprocess -
  `bunx playwright install chromium` once). PAT from the environment, plus the
  Cloudflare key trio for HS04/HS06/HS07: `sx SUPABASE_ACCESS_TOKEN
  CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL CLOUDFLARE_ACCOUNT_ID -- make
  domain-up|front|domain-down DOMAIN=<host> ...`. Run `domain-down` before
  `destroy`: the DNS records and Workers live on the Cloudflare account, not
  the project. `PUBLISH_ONLY`, not `ONLY`, narrows `publish-evidence`.

## Related

- ~/.pi/agent/skills/terraform/SKILL.md - tofu conventions used here
- ~/.pi/agent/skills/supabase/SKILL.md - CLI/pooling behaviour

## experiments/bu-attribution - key facts (2026-10-02, platform-plan org)

What a system for deterministic per-business-unit cost attribution in
ONE platform-plan org can build on. The operator builds the system; this
experiment only measures the platform. Plan and requirements pattern:
docs/plans/2026-10-02-bu-attribution.md.

- `POST /v1/projects` answers 201 with the ref in the body in ~6 s (the body
  already reads `ACTIVE_HEALTHY`), so the creating service can record
  ref -> unit in the same call (BA02a).
- The sweep source is `GET /v1/organizations/{slug}/projects`: a new ref
  shows in ~6 s; the body is `{projects, pagination: {count, limit: 100,
  offset}}`, so page it (BA02b).
- No creator/tag/label/metadata field on the project list entry or detail
  (BA02f). Names are mutable (`PATCH` 200, BA02d). A deleted ref is gone from
  the listings in ~3 s (BA02e).
- Branches: own ref, absent from both listings, `GET /v1/projects/{branch_ref}`
  404; the parent link exists only on the parent's
  `GET /v1/projects/{ref}/branches` entry (`parent_project_ref`).
  `GET /v1/branches/{id}` returns connection config including `db_pass` and
  `jwt_secret` - record key names only (BA03).
- Entitlements: `project_scoped_roles` true, roles Owner/Administrator/
  Developer/Read-only/None, `security.audit_logs_days` 366,
  `api.members.roles` false; `x-ratelimit-limit` 120 (BA01).
- Audit log (BA06, production Team org): the dashboard reads it from
  `GET /platform/organizations/{slug}/audit` (open-source Studio); a PAT gets
  `401 JWT could not be decoded` there while `/v1` answers 200. Public types
  (`AuditLogsResponse_Output`) declare `token_type`, `token_hash`,
  `token_alias`, `oauth_app_id/name` per actor; the guide lists no export and
  no drain. Security review only - not an attribution input (2026-10-07).
- Role assignment on the Management API is Enterprise-only by default per the
  spec (not measured on an org with the entitlement enabled): v2
  `PATCH /v2/organizations/{slug}/members/{user_id}/roles` and
  `POST /v2/organizations/{slug}/members/invitations` carry
  `x-allowed-plans: ["Enterprise"]`; v1 has only `GET .../members`. On the
  platform-plan org `api.members.roles` reads false (BA01a), so an org admin
  assigns roles in the dashboard, where a project-scoped invite names one
  project.
- Credential for the write path: a scoped PAT limited to the one org with
  Organization Projects (Read-write) per the public Personal Access Tokens
  guide; classic tokens reach every org the user belongs to. Unmeasured on
  production (Q14, Task 5b); an org-scoped staging PAT gets `[]` from
  `GET /v1/projects` (s2z-wake), so sweep the org listing.
- BA04 (transfer-in) needs a second org on the same control plane; an org
  cannot be deleted on `/v1`, so it waits for a decision. BA05 (restricted
  member, `PVLAB_PAT2`, `PVLAB_PEER_INSCOPE`/`OUTSCOPE`) needs a second user
  with a dashboard-assigned role.

## experiments/redundant-writes - key facts (validated 2026-10-08, local only)

Three containers (`postgres:15-alpine` 15.19, `postgres:17-alpine` 17.11,
the supabase CLI 2.120.0 image `public.ecr.aws/supabase/postgres:17.11.0.004`),
no managed project. `make all` runs RW01-RW06 and publishes to `out/<date>/`.
Numbers: `RUNLOG.md`, artifacts `out/2026-10-08/`.

- A plain upsert or UPDATE of unchanged rows writes a new version of every
  row; `DO UPDATE ... WHERE (...) IS DISTINCT FROM (...)` and
  `suppress_redundant_updates_trigger()` stop the versions and dead tuples but
  still lock every row (54 bytes of WAL per row with no full-page images,
  plus an FPI per page on the first touch after a checkpoint). Only filtering
  before the write (WHERE guard on UPDATE, anti-join before ON CONFLICT,
  guarded MERGE) wrote 0 bytes on an identical batch.
- Measure row versions by xmin/xmax inside the statement's transaction, WAL
  with EXPLAIN (ANALYZE, WAL) or `pg_current_wal_insert_lsn()`, and VACUUM's
  WAL from VACUUM (VERBOSE). `pg_current_wal_lsn()` is the WRITE position and
  read 0 bytes for a VACUUM that removed 10,000 dead tuples; a post-commit
  seq scan can prune the dead versions before the VACUUM you meant to measure
  (reasoned from opportunistic page pruning, not measured here), so count
  inside the transaction.
- `n_live_tup` read double the row count when a sub-second insert and a
  VACUUM (ANALYZE) ran on one connection (RW06, 35 of 36 reps), 0 after
  `pg_stat_reset()` and after a SIGKILL, and only post-reset inserts after
  that. `reltuples` stayed at its last VACUUM/ANALYZE value through all of it.
- `pg_stat_force_next_flush()` exists on 15.19 and 17.11 (to_regproc) but is
  not on the PG 17 statistics docs page; disconnecting also flushes.
- The Alpine images ran every 1,000,000-row ON CONFLICT case 2.95x to 6.45x
  slower than the Supabase image (derived from the RUNLOG medians) with the
  same WAL; cause not isolated (musl vs glibc untested, JIT ruled out).
- `drop_caches` in the Docker VM does not drop the macOS cache under it; a
  "cold" read here is not a disk read.

## experiments/data-api-defaults - key facts (validated 2026-10-10, one API-created Pro project, Postgres 17.11)

- A project created through `POST /v1/projects` on 2026-10-10 still carried the
  legacy default privileges: `pg_default_acl` for `postgres` in `public` grants
  `arwdDxtm` on tables (`anon`, `authenticated`, `service_role`), so a table made
  in SQL is readable by anon with no GRANT (DD01a, DD01b). The v1 create body has
  no field for the setting. The 2026-05-30 default in the public notice (github
  discussion 45329) was therefore not seen on an API-created project; whether
  that is the creation path or the gradual rollout is not separated. The
  standing-project re-run after 2026-10-30 is not done. The existing key-facts
  line "SQL-created tables get anon SELECT via default privileges" holds for this
  project and is the state the opt-in below ends.
- After the notice's `alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated,
  service_role` (and the sequences form), a new SQL table answers the Data API
  with 42501 `permission denied for table <t>` and hint `Grant the required
  privileges to the current role with: GRANT SELECT ON public.<t> TO anon;`:
  HTTP 401 for anon and the publishable key, HTTP 403 for service_role and
  sb_secret_ (hint names `TO service_role`). TRUNCATE, REFERENCES, TRIGGER and
  MAINTAIN stay in the default ACL (`Dxtm`). A GRANT to anon re-opens the table
  at once (DD01c, DD01d).
- pg_graphql is absent on a new project: `/graphql/v1` answers HTTP 200 with
  `errors: pg_graphql extension is not enabled.` After `create extension
  pg_graphql` (1.6.2) `__schema` and `__type` answer HTTP 200 with `Unknown
  field ... on type Query` until `comment on schema public is
  e'@graphql({"introspection": true})'`; `"introspection": false` refuses them
  again (DD02). A GraphQL probe must use `{ __typename }` and read the body: the
  old `{ __schema }` probe read HTTP 200 in all three states.
- `GET /rest/v1/` OpenAPI spec: anon 401 `Invalid API key` / hint `Only the
  `service_role` API key can be used for this endpoint.`; publishable 401
  `Secret API key required`; legacy service_role and sb_secret_ 200 (same
  swagger 2.0 spec, apikey alone or with Authorization). The notice's text
  `Access to schema is forbidden` was not seen. `GET
  /v1/projects/{ref}/database/openapi` with a PAT returns the same path set
  (DD04). The spec title is the `public` schema comment.
- As `postgres` (not superuser): `CREATE EXTENSION x VERSION '<v>'` succeeds,
  warns `only superusers can specify extension versions, ignoring version ...`
  and installs the default, also for a version that does not exist; the warning
  is visible on a pooler connection, not in the Management API query response.
  Every `ALTER EXTENSION ... UPDATE [TO v]` form errored `XX000 pgaudit stack
  is not empty` with installed equal to default; the real-upgrade path is
  unmeasured (DD03).
- Realtime schema as `postgres` on that project: CREATE in the schema, ALTER and
  DROP of `realtime.messages`, `realtime.topic()` and `schema_migrations` DDL
  refused (42501); `INSERT`, `UPDATE`, `DELETE` on `realtime.schema_migrations`
  and `drop trigger tr_check_filters` were ALLOWED, against the changelog's
  list. Realtime service version not read; policies on `realtime.messages` work
  (DD03).
- iap-lockdown: `lib/inventory.ts` GraphQL probe now sends `{ __typename }` and
  `http()` reports `errors[0].message` or `ok:<type>` as the row code.

## experiments/realtime-surface - key facts (validated 2026-10-10, Pro org, n = 1 per row)

- **Postgres Changes filters and `select` against Postgres's own evaluation**
  (RT01): 19 filters (AND over two and three columns, two conditions on one
  column, `like`/`ilike`, `is`, `match`/`imatch`, `isdistinct`, `not.` forms)
  each delivered exactly the ids that the equivalent SQL predicate selects on
  the same 8 rows. `select` always added the PK and still delivered an UPDATE
  event when only an unselected column changed. DELETE under a column filter:
  0 of 2 matching DELETEs with replica identity default (the PK filter got its
  1 and the unfiltered subscriber all 4), 2 of 2 with replica identity full.
  `select` naming a column revoked from the subscribing role, and a filter on
  it, both left the subscribe callback at `SUBSCRIBED` with 0 events; the only
  signal is the channel `system` event (`invalid column for select secret`).
  With no `select`, the revoked column was absent from every payload. 20
  inserts reached an unfiltered subscriber 20 times and a `team=eq.a`
  subscriber 10 times; billed message counts are not readable with a PAT.
- **A fresh project's first change event** arrived about eleven seconds after the
  subscribe on five of five projects, and on the three runs that recorded it the
  first canary INSERT was the one not delivered (RT01a, RT02-setup).
- **Disconnect loss and the heartbeat canary** (RT02): a 30 s client-side gap
  with 25 rows inserted delivered 0 of 25 on rejoin, on both the client's own
  reconnect and a manual `disconnect()`/`connect()`; the original channel
  rejoined by itself. A 2 s heartbeat row with a 6 s staleness rule and a REST
  backfill on `updated_at > last_seen` recovered all 40 of 40 rows (9 live, 26
  on the new channel, 5 backfilled, 0 duplicated). Clean close, not a network cut.
- **Broadcast Replay** (RT03): 26 database-sent messages replayed as the newest 25
  with `limit` omitted, 26 or 100, no error; `limit: 10` gave the newest 10. A
  public channel is refused (client-side constructor, and server-side
  `UnableToReplayMessages`). Client-sent messages (WebSocket and `httpSend`)
  were not persisted and not replayed. On a fresh project `realtime.messages`
  had no partition for the day until the first Realtime join; before that a
  private join answered `MissingPartition` and `realtime.send` persisted nothing.
- **Binary Broadcast** (RT04): `httpSend(Uint8Array)`, raw `application/octet-stream`
  and `realtime.send_binary` arrived byte-for-byte as `ArrayBuffer` on the
  current client and not at all (0 events, no error) on the old client, which
  still received JSON. A `Uint8Array` over WebSocket `send` arrived as a
  JSON-encoded object on both; an `ArrayBuffer` arrived binary on the current
  client only. Private-channel policy applied to binary as to JSON (no select
  policy: join refused; select-only topic: WebSocket send errored, REST 403,
  secret API key 202).

## experiments/auth-providers - key facts (AU01-AU04 2026-10-10, self-provisioned throwaway projects)

- Question: how the managed Auth server behaves for custom OIDC providers,
  passkeys (experimental) and SAML SSO, and what a synthetic sign-in canary can
  tell apart per method. Self-provisioning, no OpenTofu state: each module
  creates a `au-*` project (Pro org; AU01 also a Free org) and deletes it
  in `finally`; AU01/AU03 deploy `worker/issuer.ts` (RS256 OIDC issuer, per-run
  key) to Cloudflare Workers and delete it; AU02 runs headless Chromium with a
  CDP virtual authenticator in a Playwright container; AU04 signs SAML
  Responses with xml-crypto in a bun container. `make probe ONLY=AU0N`.
- Custom OIDC (AU01): the admin API is `/auth/v1/admin/custom-providers` with the
  `sb_secret_` key (not in the Management API OpenAPI document). Create resolves
  the issuer (unresolvable host: 400 `validation_failed`). Quota measured at 3
  providers per project on BOTH a Pro-org and a Free-org project
  (`over_custom_provider_quota`); the docs say Pro is unlimited, so whether the
  3 is a default that can be raised is open. Update is PUT; `provider_type` and
  `identifier` in the body are ignored with 200, not refused. `pkce_enabled`
  defaults true and the authorize redirect carries `code_challenge` S256 and
  `state` but no `nonce`; the client secret is sent by HTTP Basic. No email
  claim is refused (`unexpected_failure`, "Error getting user email from
  external provider") until `email_optional=true`, then the user has an empty
  email. A wrong `aud` is refused in the browser flow with a message that does
  not mention the audience, and by `signInWithIdToken` with "Unacceptable
  audience"; `acceptable_client_ids` fixes both. `signInWithIdToken` accepts a
  `custom:` provider. Claims reach `user_metadata.custom_claims` only through
  `custom_claims_allowlist`.
- Passkeys (AU02, supabase-js 2.112.3, headless Chromium, virtual
  authenticator): disabled default answers 404 `passkey_disabled`. An origin
  outside `webauthn_rp_origins` is refused by the server
  (`webauthn_verification_failed`, 400); an `rp_id` that is not a suffix of the
  page host is refused by the browser (`SecurityError`, no request sent). The
  config rejects an http origin other than localhost/127.0.0.1 (400). Changing
  the RP ID leaves the old credential unusable (browser `NotAllowedError`); new
  enrolment works. Admin list/delete need the secret key (publishable: 401);
  after delete, sign-in is `webauthn_verification_failed`, not the documented
  `webauthn_credential_not_found`. Cap: 10 per user (`too_many_passkeys`, 422).
- Canary (AU03, one workstation to ap-southeast-1): password, `signInWithIdToken`
  and the OAuth browser flow all answered 200 with latencies in the hundreds of
  ms or less. Error classes: bad signature, expired and wrong `iss` ID tokens
  are all "Bad ID token" (one class); wrong `aud`, unknown provider and disabled
  provider are distinct. With the client unable to reach `/auth/v1` a session
  keeps working on REST until the access token expires (a `jwt_exp` of 60 s
  token was still accepted at 8 s and rejected by 38 s after expiry) and
  supabase-js keeps the session in storage, recovering on unblock. A global
  sign-out does not stop PostgREST accepting an issued access token before
  expiry. With the custom issuer deleted, `signInWithIdToken` kept succeeding
  for the 482 s polled (cached keys; lifetime not bounded), the browser flow
  failed at the issuer, and password sign-in was unaffected.
- SAML (AU04): a SAML SSO provider created from metadata XML needs no reachable
  IdP; a lab-signed Response POSTed to the ACS signs in (`sso:<uuid>` provider),
  a replay is refused (`saml_relay_state_not_found`), and bad signature,
  unsigned, wrong audience, expired and wrong recipient are all refused with
  `validation_failed` whose description is the full Response XML (2-4 kB,
  indistinguishable by tail). An email outside the provider's `domains` and an
  IdP-initiated Response (no `InResponseTo`) both signed in.
- Not covered: Pro limit above 3, real IdPs (Okta/Entra), metadata URL refresh,
  encrypted assertions, real authenticators and Safari/Firefox, SAML on Free,
  and any server-side Auth outage (no lever; AU03c/e are client-side or
  issuer-side).
- Ops: Pro-org micro projects, minutes each; AU03 runs about 10 minutes
  (60 s `jwt_exp`, 4 min REST polling, up to 8 min outage series). Worker
  names `au-iss-*`; `make sweep` lists leftover projects. The new
  workers.dev hostname was once refused on the first provider create (cause
  not captured); `createProviderWhenResolvable` waits.

## experiments/observability-surface - key facts (2026-10-10, Pro-plan org)

Self-provisioning (`ob-surface-` projects, ap-southeast-1), no OpenTofu state.
Modules OB01-OB05; docs claims and measurements are kept apart in RUNLOG.md.

- **supabase-js trace propagation (OB01)**: with the OTel API resolvable at run
  time, 2.111.0, 2.112.0 and 2.117.3 all attach `traceparent` (never `tracestate`
  or `baggage` with the default provider) to REST and Edge Function calls made
  inside a span. A bundle run with no `node_modules` loses it on 2.111.0 only
  (Bun and esbuild bundles, no warning); 2.112.0 and 2.117.3 kept it in all five
  packagings. 2.112.0 without the `/tracing` import: no headers plus one
  warning; unsampled spans: none on 2.112.0, `traceparent` on 2.117.3. The
  host check passes the client's own base URL (a non-Supabase base URL gets
  headers on its own host) and any `*.supabase.co` host; `xsupabase.co` and
  `supabase.co.example.test` get none.
- **Where the trace id lands (OB01)**: `edge_logs` rows carry it as the
  `trace_id` attribute (38 of 38 rows have one, the client's value when a header
  was sent). `function_edge_logs` (0 of 39), `function_logs` (0 of 78) and every
  other source do not. The function itself receives the client's `traceparent`
  and prints it only if its own code logs it. An untraced function call still
  receives a platform `traceparent` (flags 00) and `baggage: sb-request-id`.
- **Health Check Advisors (OB02)**: `POST /v2/projects/{ref}/advisors/run`
  fires `log_{data_api,auth,storage,edge_function}_error_rate_high` (level
  ERROR, category HEALTH) after at least 5 failing 5xx requests in each of two
  consecutive clock-aligned five-minute buckets. 5 of 100, 5 of 250 and 6 of
  600 fired; 4 of 100, 3 of 100 (twice), 1 of 5 and a 404-only load did not;
  the lint text says "at least 10%" but 1% fired. One bucket of failures, or
  failures in only one of the two buckets, did not fire. Fires 35-66 s after
  the second bucket closes (30 s polling), the answer is cached about 60 s
  (`observed_at` steps of 62-64 s at 10 s polling), clears 306-367 s after the
  last failure. Induce 5xx with `raise sqlstate 'PT500'` (PostgREST), a raising
  `BEFORE INSERT` trigger on `auth.users` (Auth admin create), a raising
  `storage.objects` policy function (Storage list), an Edge Function returning
  500 or throwing.
- **Logs endpoint ingestion and sources (OB03)**: 36 of 36 marked REST and
  function requests came back within the 15 s poll interval (max 30 s) in a
  36-minute window; the 4-minute lag seen once in earlier runs did not recur.
  Sources on a project: `auth_audit_logs`, `auth_logs`, `edge_logs`,
  `function_edge_logs`, `function_logs`, `pgbouncer_logs`, `postgres_logs`,
  `postgrest_logs`, `realtime_logs`, `storage_logs`, `supavisor_logs`. Filter on
  `source`; `select *` answered a backend error in an exploratory query (not archived), so name the columns. A 300-request
  burst: 300 rows. `usage.api-requests-count` equalled the project's
  `edge_logs` row count (341); the platform organization usage route rejects a
  PAT (401), so logs GB usage is not reachable by token.
- **Notebooks (OB05)**: `supabase notebooks pull` writes
  `supabase/notebooks/<name>.json` (keys `description`, `favorite`, `content`;
  no id in the file); `push` creates by name and updates in place, cell ids
  survive, a cell without an id gets one; a project notebook missing locally is
  left alone with `--yes` and a closed stdin (exit 0).
- **Log drains (OB04)**: `log_drains` entitlement true on Pro, but
  `GET`/`POST /v2/projects/{ref}/analytics/log-drains` answered 403 "Your
  organization does not have access to this API" on a Pro and a Team org; the
  Dashboard route rejects a PAT. Creation is blocked here, so batch size, flush
  spacing, content-encoding and lag of a drain are unmeasured. The Worker sink
  (OB04b) is tested and waits for a drain. The v1 API publishes no log-drains route (v2 does). The v2 route
  refuses these orgs regardless of the entitlement; what grants access was not
  determined. Missing prerequisite: an org the v2 route accepts, or a drain
  created in the Dashboard pointed at the sink.

## experiments/edge-runtime-auth - key facts (validated 2026-10-10, Pro org, ap-southeast-1, self-provisioned projects, one per module run)

Self-provisioning: each module creates and deletes its own project (name
prefix from `ER_PROJECT_PREFIX`), no OpenTofu state. Package under test:
`@supabase/server` 1.9.1 (pinned in the experiment's own `package.json`, with
`@supabase/supabase-js` 2.117.3). Run ER01 and ER02 from source:
`bun harness/src/run.ts --where local --tests experiments/edge-runtime-auth/tests --experiment edge-runtime-auth --only ER01 --destructive`
after `bun harness/scripts/gen-registry.ts` (the generated registry is used
when present, so a new module is invisible until it is regenerated).

- **Cloudflare deployment (2026-10-10, new project, `out/2026-10-10/run-2026-10-10T09-28-52-860Z.json`).**
  The same Worker bundle deployed to workers.dev (wrangler 4.147.0, secrets as
  Worker secrets) in its three env configurations (`process.env`, overrides,
  overrides + inline JWKS): 0 of 70 cells differ from the workerd cell of the
  same configuration, in each configuration; all three are identical to each
  other. A real user token verified (`200 ran:user`) on all three, including the
  two that fetch the JWKS at run time. First 200 from the deployed Worker 18 s
  after the deploy command started. The Worker and the project were deleted
  (Worker list re-read: 0 `er-` scripts; `GET /v1/projects`: none with the
  prefix). One account, one colo vantage (SIN on a smoke deploy, not in the
  artifact), one sequential pass; no rate or cold-start figures. The earlier
  workerd-only runs stay in the RUNLOG.
- **ER01, 14 credential presentations x 5 auth modes x 5 targets (Edge Function
  `verify_jwt` false and true, three workerd Worker configs), plus the three
  Cloudflare Worker configs in the later run.** On an
  Edge Function with `verify_jwt` false, 0 of 44 docs-stated cells differed from
  the package docs; 26 of 70 cells are ones the docs do not state. Workers
  runtime: same 70 cells in all three env configurations (process.env,
  overrides, overrides + inline JWKS), and equal to the Edge Function cells
  except a well-formed unknown `sb_secret_` key, which the Edge Function
  gateway refuses (`401 Invalid API key`) in every mode including `none`.
- **`user` mode accepts only a real project-issued ES256 token.** Refused with
  `INVALID_JWT`: expired, third-party-issuer (registered through third-party
  auth), unregistered-key, legacy HS256 under the shared secret, and the legacy
  anon/service_role JWTs. A bad JWT in `['user','secret']` is refused, not
  downgraded to the secret path. The library accepted a token up to 2.9 s
  before its `exp` and refused it by 1.4 s after (probes ~4.2 s apart, this
  machine's clock).
- **The platform gateway and the library disagree.** With `verify_jwt` true the
  gateway passed a legacy HS256 token the library refuses, and refused a
  third-party token (registered issuer; PostgREST answered 200 to it) for the
  120 s it was polled after registration, and again in the later matrix cell
  (not timestamped). Not settled: propagation versus rule.
- **`verify_jwt` true did not block valid `sb_` keys.** A bare publishable key,
  a bare secret key and the publishable key in both headers reached the handler;
  the gateway refused a missing credential and a bad bearer (expired,
  third-party, foreign). The docs' blanket "set `verify_jwt = false` for
  `publishable`, `secret` or `none`" is stricter than what these cells needed.
- **A valid user JWT with no `apikey` sent to `secret` or `publishable` mode
  returns `INVALID_CREDENTIALS`**, the code the docs call a fallback that
  specific codes have replaced.
- **Runtime variables on an Edge Function:** `SUPABASE_PUBLISHABLE_KEYS` and
  `SUPABASE_SECRET_KEYS` (each with one key named `default`), inline
  `SUPABASE_JWKS` (one ES256 key), `SB_EXECUTION_ID` and
  `SUPABASE_FUNCTION_SLUG` were set; the singular key variables and
  `SUPABASE_JWKS_URL` were not.
- **`jwt_exp` readback is not the setting in force.** After the Management API
  read back 300, the first sign-in still got a 3600 s token; the second, 10 s
  later, got 300 s. Poll sign-ins for the lifetime, not the config readback.
- **ER02: no mixed-version window after a redeploy.** Five redeploys, 4
  pollers (618 to 639 samples per ~30 s cycle): 0 old-build answers after the first new-build
  answer, 0 non-200; the last old answer was at most 36 ms and the first new
  answer 781-987 ms after the deploy call returned (requests issued at the
  boundary took up to ~1 s; first-10-s p95 240 ms against 109 ms before).
  Management API deploy path, one function, one region (SIN vantage).
- **`functions.invoke` (supabase-js 2.117.3) did not retry** an injected 503
  (with or without `Retry-After`), 502, 500 or 429: 1 client attempt and 1
  function-side row (a table witness, not an in-memory counter) in each of 3
  trials per status; error class `FunctionsHttpError`. Not measured: a 503
  produced by the platform relay, network errors, other client versions.
- **Latency, 600 s at 1 request/s each:** Edge Function p50 88 / p95 112 / p99 146
  / max 242 ms (600 answers) against an RPC twin p50 27 / p95 44 / p99 68 / max
  147 ms. 466 of 600 function answers reported a module-load age under 2 s
  (`age_ms`; a recent module load, not shown to be a new instance; older-age
  answers had p50 61 ms). Per-30-s p95 median 110, max 151; 0 of 20 buckets over 2x the
  median.
- **Open:** the module counted 543 distinct instance ids over 600 answers while
  134 answers carried a served count above 1; the instance id is not relied on.
- **Superseded:** the first ER02 run reported a 3-6 s mixed-version window; it
  was a time-origin defect in the module, withdrawn (RUNLOG).

## experiments/lifecycle-ops - key facts (validated 2026-10-10, Pro org)

- Status page as a change gate (LO01, `experiments/lifecycle-ops/lib/gate.ts`):
  `status.supabase.com/api/v2/components.json` carries each of the 18 region
  names 10 or 11 times (189 components in all, no group or service field), so a
  lookup by region name must take the worst status over every match.
  `incidents.json` has no component or region field and `incidents/unresolved.json`
  answers 404; region scope is read from incident text (title first), and
  `impact` is ignored because an upgrade suspension and a project-creation
  degradation were both published as `none`. All 189 components read
  `operational` on 2026-10-10, so component status has no positive case in the
  lab yet. `summary.json` lists a 2026-07-02 maintenance still `scheduled`.
  Replay of the 25-incident feed (1113 h): a restart gate would have refused
  `ap-southeast-1` (38.5 h in total); heuristic, not ground truth.
- A create whose response the caller abandoned still creates the project, and
  an identical re-send is refused with HTTP 400 `Project with name "<name>"
  already exists in your organization.` (LO04, n=1). Keep the name stable
  across retries of one logical create; list by name before retrying. Invalid
  create bodies fail fast and create nothing (LO03a: unknown region 400,
  unknown org 404, missing name 400, unknown size 400).
- `ACTIVE_HEALTHY` after a create came back at the first poll twice and at 145 s
  once (LO03, n=3, 10 s poll); the project that read healthy at the first poll
  served REST, Auth, Storage, pooler and direct within 5 s (LO05a).
- Restart envelope, one Micro project, `ap-southeast-1`, n=5 (LO05): REST never
  failed; Auth 54 s, Storage 58 s, pooler 54 s, direct 50 s at p50 with maxes
  60, 59, 151 and 56 s; first failure 2 to 3 s after the POST; the control-plane
  status flipped back to `ACTIVE_HEALTHY` at 40 to 71 s, before the pooler
  recovered in one run. Windows were about 30 s in runs 1 and 2 and 50 to 60 s
  in runs 3 to 5. D01 (2026-08-04, n=1) had 75, 78 and 158 s.
- `POST /restart` right after a create answered HTTP 400 `Project restarts are
  only allowed ten minutes after the creation process has completed...`
  (about 70 s after the POST, handed-over project), yet a restart 300 s after
  the first `ACTIVE_HEALTHY` read was accepted on another project (LO05f). The
  boundary is unresolved. A second restart sent while `RESTARTING` returned 200
  (LO05c).
- Vantage note: on the macOS orchestrator, `dns.lookup` (getaddrinfo) returned
  ENOTFOUND for an AAAA-only `db.<ref>` host while `dns.resolve6` and a TCP
  connect to the literal address worked; the direct probe resolves with
  `resolve6` (`lib/probes.ts`).
- Retire FAILURE-MATRIX 10.1 `[doc]` for the measured halves (create and
  restart lifecycle surfaces); capacity-driven failures remain `[doc]`.

## experiments/restore-paths - key facts (2026-10-10, ap-southeast-1, one IPv4-only vantage)

Which restore paths a Pro org can drive through the Management API, and what
each does to the db password, Storage and the per-path outage. Self-provisioning
(`rp-*` projects, deleted in `finally`); run from source with bun
because `harness/dist/pvlab` is a linux-x64 build.

- **Pro has no pause, and `backups/restore` is "unavailable".** `POST /pause`
  answers `400` "Project is not free-tier" (entitlement `project_pausing` false
  on the Pro org). `POST database/backups/restore {id}` and `GET
  .../restore-point` answer `400` "This endpoint is unavailable at the moment" on
  a fresh Pro project, and the same by a manual call after `pitr_7` was applied
  (RP01). On this org the in-place restore route that ran is `restore-pitr`.
- **Restore to a new project (clone) was not run.** The OpenAPI document has no
  clone path and the create-project body no source field; the Dashboard's
  clone route answers a PAT `401 Unsupported access token` (RP01d). The
  entitlements `project_cloning` and `backup.restore_to_new_project` are true on
  the Pro org, so the feature is entitled but its API path is the Dashboard's.
  Password and Storage behaviour after a clone are unread.
- **`restore-pitr` refuses a target past the platform's upper bound and the
  message names the range** ("Recovery time target must be within range:
  <earliest> <= t <= <latest>"); a target 19 to 96 s past that bound was
  accepted on a retry 60 or 121 s later (RP02c, retries every 60 s so the lag is
  bounded, not resolved). With `pitr_7` just applied, the first read already had
  `pitr_enabled=true` and a window of 359 or 360 s in 5 of 5 runs.
- **PITR restore on Small, 10 MB database: back to `ACTIVE_HEALTHY` in 30 s**
  (10 s polling; n=3), 40 s for a restore to a target after a rotation (control,
  30 to 41 s, n=5), 81 s for a 574 MB database (n=1). Per path: REST, Auth and
  Realtime showed no failed 1 s sample; Storage failed for 12 s (8 of 9) with
  `The operation timed out`; the pooler 5 to 13 s on 10 MB, 41 s at 574 MB.
- **The current password works after a PITR restore; the replaced one is
  refused** (9 of 9 clean restores, targets before and after a rotation). The
  stored verifier is a third value each time, so credentials are set again
  after the restore (inference from fingerprints, matching the 2026-07-30
  changelog). The current password was refused for about one 5 s poll between
  "database answers" and "password works" in 6 of 7 restores observed at that
  resolution: a short stale window, not a measured duration. A restore target
  hours or days old was not run.
- **Storage did not 500 after any restore or unpause** (list, download with
  bytes equal, upload all `200`). A PITR restore to before an object's upload
  makes the download `404` and the listing omit it, and the same path is
  writable again (R6). While a Free project is pausing, Storage answered `HTTP
  500` on the first failing sample (2 of 3 runs). `GET /health` read
  `realtime=COMING_UP` in the read taken right after the restore or unpause in 4 of 8 runs (RP02 R3, R4, R6; RP03 R7).
- **Free-plan pause then unpause (6 cycles):** `INACTIVE` after 62 or 63 s
  (5 cycles; 276 s once), unpause to healthy 183 to 212 s (5 cycles; 444 s once)
  via `COMING_UP -> RESTORING`. After the unpause REST and Realtime answer at
  15 to 20 s, Auth at about 150 to 175 s, Storage and the pooler at about 180 to
  217 s.
- **A password change while paused is refused** (`400` "Cannot reset password
  for non-active projects"), so the stale-credential condition the changelog
  describes cannot be set up through the API on a Free project. The password
  set before the pause works after the unpause (3 of 3 first cycles).
- **The pooler's circuit breaker is a measurement hazard.** Polling a known-wrong
  password every 4 s plus a 1 s probe opened it within about a minute:
  `(ECIRCUITBREAKER) too many authentication failures, new connections are
  temporarily blocked` answered every login, including the correct password,
  before the password was checked. Poll a wrong password at most once a minute
  and read `blocked` as "unanswered".
- **Small's disk is 2 GB gp3 and WAL counts against it.** Growing a PITR project
  to 574 MB left 505 MB free with 736 MB of WAL (R5); asking for 1500 MB filled
  the disk at 715 MB, the next rotation call failed and the restore request was
  refused as "database appears to be unreachable" until 301 s (R4). What filled
  it was not separated.
- Pending: clone (Dashboard session needed), `backups/restore` on an older
  project, a restore target hours old, a database over 1 GB, direct 5432.

## experiments/pooler-checkout - key facts (validated 2026-10-10, Micro, ap-southeast-1 and us-east-1, Pro org, Supavisor aws-0 hosts)

Self-provisioning (Management API create and delete, no OpenTofu state), one
Micro project per run. IPv4-only vantage in Singapore. Raw artifacts are in the
ignored `evidence/`; none published to `out/`. Details: RUNLOG.md.

- **Transaction-pool exhaustion is a statement-time error, after 60 s.** With the
  effective pool (16 active backends on Micro, PC01b; the API reports
  `default_pool_size null`) held by `pg_sleep`, client N+1 connects in 43 to
  52 ms and its first `select 1` fails after 60,007 to 60,009 ms (6 of 6
  trials) with `XX000 (ECHECKOUTTIMEOUT) unable to check out connection from the
  pool after 60000ms in Transaction mode`. A statement that queues for less than
  60 s is served (6,018 to 6,056 ms behind 8 s holders). A public status mirror
  quotes `after 15000ms` for other clusters; this project did not reproduce
  that figure, and what sets it was not separated.
- **Fallback to the Supavisor session pooler (5432) works while the transaction
  pool is exhausted:** 49 to 70 ms from the primary's failure to the fallback's
  answer (PC02a), 56 to 117 ms after the server's own 60 s error (PC02c). The
  session client was an extra backend: 17 active `pg_sleep` backends with 16
  transaction-mode holders plus one session client (PC02h), against the docs'
  combined-pool wording. Direct 5432 is unreachable from an IPv4-only client
  without the add-on (`ENOTFOUND`, 6 of 6); with the add-on on, the dedicated
  pooler and direct answered 126 to 168 ms after the failure. The add-on took
  80 s (both runs) from the PATCH to an IPv4 address on this resolver.
- **Driver pools evict reset connections; the retry has to wait.** Through a
  toxiproxy reset or cut, node-postgres, postgres.js and Prisma had 0 failed
  first attempts after the fault cleared (111 non-crashed runs). A retry-once
  at 0 ms did not rescue stale-connection failures after a 150 ms flap on pg or
  Prisma (0 of 30 each); at 300 ms it did (25 of 25, 30 of 30). postgres.js
  waited out a 2 s cut in 9 of 12 runs (slowest statement 1,902 to 2,103 ms).
  node-postgres `Pool` without an `'error'` listener exited in 9 of 12 runs at
  the cut (`Unhandled 'error' event`).
- **The `aws-0` prefix was the current one**, not a legacy one: fresh Pro
  projects in two regions were on `aws-0` and the `aws-1` host answered
  `(ENOTFOUND) tenant/user ... not found` for them (PC04). The lint
  (`lib/lint-pooler-hosts.ts`) flags a literal host; read `db_host` from
  `GET /v1/projects/{ref}/config/database/pooler` instead.
- **Host sleep voids timings.** Run 1 lost PC02 to a laptop idle sleep (a 100 s
  deadline fired at 241 s of wall time); later runs use `caffeinate` and a
  `-clock` row (wall minus monotonic clock).

## experiments/jit-db-access - key facts (2026-10-10, Pro org, Postgres 17)

Temporary token-based database access: the caller's PAT is the Postgres
password for a role the project grants it. Self-provisioning, one Pro
project per run. Sources (docs claims, not measurements):
https://supabase.com/changelog/46346-feature-preview-temporary-token-based-database-access
and https://supabase.com/docs/guides/platform/temporary-access.

- The grant routes work on Pro: `PUT /jit-access {state}` and
  `PUT /database/jit` answer 200 (JA01c, JA01d). The 500 recorded under
  sfp-platforms was the invite route.
- Prerequisite: SSL enforcement. Without it `GET /jit-access` reads
  `{"state":"unavailable","unavailableReason":"ssl_enforcement_required"}`
  and `PUT enabled` answers 200 with that same body. `PUT /ssl-enforcement`
  `{"requestedConfig":{"database":true}}` is followed 1 s later by a
  `received fast shutdown request` row in postgres_logs (5 of 5 runs, JA01b).
- Grant body key is `roles`, NOT the docs' `user_roles` (400 `roles:
  Invalid input`); the response uses `user_roles`. `PUT` replaces the user's
  whole role set (JA01d).
- `expires_at` is epoch SECONDS. Fresh logins are refused at +0 to +1 s
  (pooler `password authentication failed`, direct `PAM authentication
  failed`). The docs example writes milliseconds: that value is accepted
  with 200 and was not refused within 70 s, so copying the docs example
  yields a grant with no practical expiry (JA01g, 3 runs direct, 1 pooler).
- Expiry and `DELETE /database/jit/{user_id}` stop NEW logins only; open
  sessions stayed alive (300 s after expiry, runs 4-5; 15 s after delete).
  `PUT /jit-access disabled` closed the pooler session and not the direct
  one. `PUT enabled` restores login with no re-grant (JA01g, JA01i).
- Paths with the PAT as password: shared pooler 6543 and 5432 with
  `options=-c jit=true` work; without the option, and for an unmapped role,
  `password authentication failed`; direct works over IPv6 (AAAA only, no A
  record without the IPv4 add-on; macOS needs `hostaddr` pinned); dedicated
  pooler (db host :6543) `SASL authentication failed`. The docs' `aws-1-`
  pooler host answered `ENOTFOUND tenant/user`; use the host from
  `GET /config/database/pooler` (`aws-0-` here) (JA01e).
- A PAT session is `current_user = session_user = postgres` with the role's
  own privileges; nothing inside the session names the Supabase user (JA01f).
- Logs: a direct JIT login is `connection authenticated: identity="postgres"
  method=pam` plus `connection authorized ... application_name=<client>` in
  postgres_logs; a pooler login is a supavisor_logs row with `user` and
  `peer_ip`. No row from the logins carries the user id, email or `sbp_`
  token; the only row with the user id was the Management API's own
  `-- user: scoped_pat:<id>` tag on a `POST /database/query` statement
  (JA01k). The changelog's "see who accessed the database" is not visible in
  these two sources.
- `allowed_networks`: documentation-range CIDR refused on both paths; the
  direct path works with `allowed_cidrs_v6` set to the `/128` the database
  saw; the pooler path is judged against the pooler's IPv6 address (a pooler
  session shows an IPv6 `inet_client_addr()`), and the verdict for an
  IPv4-only grant differed between runs and within one run (`password,
  password, ok-v6, ok-v6`, 8 s apart). Per-client-IP scoping through the
  shared pooler is unproven (JA01j).
- Failed pooler logins trip `(ECIRCUITBREAKER) too many authentication
  failures`, which also refuses valid grants and listed one banned IPv4 in
  `POST /network-bans/retrieve` (lifted by `DELETE /network-bans`). Do not
  retry a refused JIT login in a tight loop (run 1, discarded rows).
- Not run: membership removal and PAT revocation (needs a second human; the
  changelog claim is doc-cited-not-tested), sessions beyond 300 s,
  `branches_only`, Team/Free orgs.

## experiments/client-retries - key facts (supabase-js PostgREST retries, validated 2026-10-10)

- Built-in retries (supabase-js 2.102.0 and later; 2.101.1 sent one request): GET, HEAD and
  `rpc({get: true})` answered 503 or 520, or hit by a connection reset, make 4 attempts at 1, 2,
  4 s with `X-Retry-Count` 1, 2, 3 (CR01a1-a3, CR01a5, CR01b3). POST, PATCH, DELETE, upsert
  and default `rpc()` send 1 (CR01b1, CR01b2, CR01b3). 525, 502, 504, 500, 429, 408, 521, 522
  and 524 each send 1 (CR01a4). Measured on a local fault proxy, supabase-js 2.112.3, Bun 1.3.14.
- `Retry-After` on a 503 sets the spacing: 2 gave 2000 ms, 0 gave 0, 40 gave 40000 ms (above the
  30 s cap), an HTTP date was ignored (CR01a6). The real Data-API-off 503 (PGRST002) carries
  `Retry-After: 0`, so its four attempts ran back to back, 7252 ms in total (CR01e1).
- Opt-out spelling: `.retry(false)` works from 2.102.0; `db: { retry: false }` only from 2.112.0
  (2.111.0 and earlier ignore it); `db: { retryEnabled: false }`, the name in the public
  changelog, did nothing in any of the 14 versions tested (CR01c, CR03).
- No default timeout: a 10 s response completes (CR01d2) and a request never answered was still
  pending at 330 s on Bun and on Node (CR04; one trial each). `db.timeout` is per attempt, not
  per call (CR01d4).
- Under Bun 1.3.14 an inline `.abortSignal(AbortSignal.timeout(n))` did not end a call that was
  sleeping between retries (4 attempts, 7 s for a 2.5 s or 5 s deadline; CR01d5a, CR01d7,
  CR03 on every version from 2.102.0). Node ended it at the deadline. An `AbortController` with
  `setTimeout`, or a timeout signal with an `abort` listener, worked on both.
- gateway edge_logs do not show `X-Retry-Count` (5 rows, `source = 'edge_logs'`); attempts are
  visible only as rows (CR01f).
- Client policy (lib/policy.ts): deadline plus one hedged GET bounded a held request to 1575 ms
  and a hang to the 4000 ms deadline, and sent 2 requests where the built-in policy sends 1 for a
  525 (CR02b-e). Leaving the built-in retries on under the hedge sent 6 requests in 6 s against
  2 (CR02f). Hedging a plain insert wrote 2 rows; a hedged primary-key upsert wrote 1 (CR02g).
- refresh-then-retry on a 401: injected and real 401s recovered with 1 refresh call and 2 REST
  requests; a revoked session returned the original 401 after a failed refresh; 5 parallel 401s
  made 1 refresh call (CR02h; the last is one trial).

## experiments/hostname-path - key facts (validated 2026-10-10, ap-southeast-1, Pro org, n=1 per row)

Self-provisioning (project `hp-<ms>`, deleted by HP09; run state in
gitignored `.state.json`, `make down` recovers a crashed run). Custom hostname
DNS through the Cloudflare v4 API with the global key pair (the scoped token did
not list the zone). Details: RUNLOG.md.

- **The Auth callback follows the custom domain, about 6 s after
  `5_services_reconfigured`** (HP03d): polled every 5 s, both entry hosts named
  the project host at 1 s and the custom host at 6 s; a round trip started
  within seconds of `activate` in the first cycle still used the project host.
  With the domain active, `redirect_uri` (to the issuer and in the token
  request) is `<custom host>/auth/v1/callback` whichever host the client entered
  at; after `DELETE custom-hostname` it named the project host again 5 s later
  (HP09). Measured through the Keycloak slot with a mock issuer (an Edge
  Function); a real provider's reaction to an unregistered `redirect_uri` was not
  run.
- **The access token's `iss` stays `<project host>/auth/v1`** for sign-ins
  entered at the custom host (OAuth and password grant); the token is accepted
  by `/auth/v1/user` on both hosts and the JWKS answers `200` on both (HP04,
  HP05d). The PostgREST OpenAPI root reports `host` as the project host on both
  (hand-read, HP05c counts the hostname).
- **supabase-js builds every URL from the base URL it was given** (HP05): with
  the custom hostname, all 12 operations (`getPublicUrl`, `createSignedUrl(s)`,
  `createSignedUploadUrl`, REST, Functions, Auth, Storage) sent and returned the
  custom host; the Storage server's sign and upload responses contain no
  hostname. `getPublicUrl` makes no request.
- **A custom hostname that is a CNAME to `<ref>.supabase.co` does not survive
  `supabase.co` NXDOMAIN at the resolver** (HP07): 0 of 6 app operations,
  `ENOTFOUND`; the same hostname as A records holding the project host's 2
  addresses: 6 of 6 (curl pinned: `200` on both addresses with SNI = custom
  host), platform status still `5_services_reconfigured` seconds later. Validity
  over time and certificate renewal without the CNAME were not tested. A resolver
  that had the chain cached kept answering until the 300 s target TTL ran out
  (first failure at 301 s; no serve-stale, one configuration).
- Resolution (HP06): the project host is 2 A records, no AAAA, TTL 300, same set
  on the system resolver, 1.1.1.1, 8.8.8.8, 9.9.9.9 and DoH (Cloudflare, Google);
  `supabase.co` is delegated root > `co.` (4 NS) > 2 NS on Cloudflare, no DS and
  no DNSKEY, no wildcard (an unused label is NXDOMAIN).
- Latency from one APAC vantage (HP08, 40 interleaved samples per host, new
  connection each): p50 phases (ms) project host dns/tcp/tls/ttfb 3/10/15/27,
  custom host 3/10/14/26, both through the SIN colo, 40 of 40 `200`. The
  eastern-US :00/:30 vantage was not measured (the vault AWS keys were rejected
  by STS, `InvalidClientTokenId`); ISP and `.co` TLD behaviour from other
  networks not measured.
- Custom-domain provisioning, two cycles on one project: verified in 221 s and
  66 s (the `_acme-challenge` TXT was asked for in the first only), `activate`
  `201` on the first call both times, host serving 1 s after.
- Harness: the Keycloak provider stores userinfo claims under
  `identity_data.custom_claims`. Docker container IPs are not routable from
  macOS, so resolver probes run `dig` inside the Unbound container.

## experiments/storage-surface - key facts (validated 2026-10-10, Pro org, ap-southeast-1, n = 3 runs each)

- storage-surface (SS01, SS02; 2026-10-10, Pro org, ap-southeast-1, n = 3 runs
  each; `experiments/storage-surface/RUNLOG.md`). Self-provisioning, projects
  named `ss-<tag>-<epoch>`. The AWS SDK for JavaScript v3 is a
  dependency of `canary/` only and is spawned as a child process, so the
  compiled registry and the root typecheck do not need it; the harness runs
  from source for this experiment (`make probe`).
- Direct SQL delete guard (SS01a-b): `storage.protect_delete` is a
  statement-level BEFORE DELETE trigger on `storage.objects` and
  `storage.buckets`. As `postgres`, `DELETE ... WHERE false` is already refused
  (SQLSTATE 42501) because it fires per statement. It accepts only the exact
  string `true` (`'on'` and `'TRUE'` are refused). `SET`, `SET LOCAL` in a
  transaction, and `set ...; delete ...` in one Management API query request
  all work. `TRUNCATE` is not covered (probed inside a rolled-back
  transaction; a committed TRUNCATE was not run). `storage.prefixes` is absent
  (3 of 3 runs).
- SQL-deleted objects are orphaned (SS01c): after a SQL delete the REST API and
  the S3 endpoint report the object absent, but a row re-inserted with the
  original `version` serves the original bytes again (REST and S3), while a row
  re-inserted after an API delete, or with a different `version`, does not.
  Inference from controlled reads, not a view of the backend. Persistence time
  and storage accounting not measured.
- List v2 (cursor) against v1 (offset) (SS01d): v1 latency grows about linearly
  with offset (DB-side `storage.search` at the last page, in milliseconds:
  43 / 217 / 864 at 5,000 / 25,000 / 100,000 rows); v2 is flat DB-side
  (about 1.2 to 1.5 at every size); client side it shows no depth trend beyond
  run-to-run noise of roughly 40 to 130 ms on single samples (one 131 ms first
  page at 100,000 rows in run 3). The per-run client-side ratios are in the derived table of SS01d in
  the RUNLOG. Flat prefix, SQL-inserted rows, one laptop vantage; the blog's
  14.8x figure is a 60-million-row benchmark and is not reproduced.
- S3 endpoint key canary (SS02; session-token auth with the service_role JWT,
  AWS SDK v3): of 40 keys, 18 round-trip on every operation (space, `+`, `=`,
  `&`, `,`, `;`, `@`, `:`, `$`, `!`, `'`, parentheses, `*`, `?`, nested paths,
  leading and trailing space), 19 are refused `400 InvalidKey` (including `%`,
  `#`, `~`, brackets, braces, backtick, `<` `>`, `"`, `\`, tab, and every
  non-ASCII key tried), 3 get `403 SignatureDoesNotMatch` (`a//b.txt`,
  `dot/./seg.txt`, `dot/../seg2.txt`). REST GET returned the same `InvalidKey` body (REST upload not recorded). Same
  result on both hosts and on both Bun and Node. On Bun the dot-segment 403 is
  the client rewriting the path after signing (local wire control); on Node
  and for `//` the request matches what was signed and the endpoint still
  answers 403. Dashboard-generated S3 access keys not exercised (no API to
  create them).
- Client action: restrict object keys to the 18-key class at upload; never
  send `//` or dot segments in a key; percent-encode path segments in REST
  calls (supabase-js with a plain `?` key lost the object under another name).

## experiments/pipelines - key facts (validated 2026-10-10)

- **Pipelines (PL, experiments/pipelines/, 2026-10-10).** The managed service
  cannot be driven with a PAT: the public Management API description has no
  pipelines route and `/platform/replication/{ref}/...` answers 401
  "Unsupported access token" while `/v1` answers 200 (PL01). A destination
  with no third-party credentials exists (DuckLake; catalog and storage can be
  Supabase projects per the docs), but creating one is Dashboard-only. All
  behaviour below is from the open-source engine image the docs say the managed
  service runs, pinned by commit, with a DuckLake destination on local
  containers, from a laptop with a 171 ms round trip to the eu-central-1 source:
  not managed-service figures. Initial copy of 1M rows (101 MB heap): 53 s from
  start to `sync_done`, 13.3 s of it copy (PL02). Lag tracks `batch.max_fill_ms`:
  p50 5577 ms at the 10000 ms default, 1131 ms at 1000 ms (PL03). RLS applies
  to neither the copy nor the change stream for a BYPASSRLS role; a role
  without BYPASSRLS silently copied only the 100 policy-visible rows of 1000
  (PL04). DDL: add/rename/drop column, drop NOT NULL and constant defaults
  propagate in about 5 s; tightening NOT NULL and volatile defaults are skipped
  with a WARN; an int-to-bigint change leaves the destination INTEGER and a
  later out-of-range value made the replicator process exit while the table
  state still read `ready` (PL05). 0 duplicates in 11 kill/stop trials, with and
  without a primary key (PL06; not a bound). A stopped pipeline retains WAL
  linearly (about 410-620 bytes per 1 KB-class row written); past
  `max_slot_wal_keep_size` (512MB) the slot went `unreserved` then `lost`
  (`wal_removed`) at the next automatic checkpoint, `CHECKPOINT` is refused for
  `postgres`, default restart exits with `ReplicationSlotInvalidated`,
  `recreate` rebuilds the table (PL07). The `etl_pipeline` add-on is listed at
  0.053 USD/h but a PAT PATCH is refused 400 (PL08). Not measured: managed
  copy time and lag, billing while stopped, Supabase-backed catalog/storage,
  BigQuery/ClickHouse/Snowflake.

## experiments/orioledb - key facts (validated 2026-10-10, hosted)

Self-provisioning: one OrioleDB project (`POST /v1/projects` with
`postgres_engine: "17-oriole"`), one heap control, three extra OrioleDB
projects (feature battery, two conversion probes), all `small`,
`ap-southeast-1`, deleted by OR99. `make probe` runs OR01-OR10; numbers in
`RUNLOG.md`, artifacts `out/2026-10-10/`.

- The create-body field `postgres_engine` is typed deprecated `null` in the
  published OpenAPI document (read 2026-10-10) but was accepted and applied:
  the project reads back `postgres_engine` `17-oriole` (PostgreSQL 17.6,
  aarch64, `OrioleDB public beta 14`). The heap control read 17.11 on x86_64
  with `wal_compression` zstd (OrioleDB project: pglz), and was created with a
  2 GB disk against 8 GB for the OrioleDB project. Cross-project comparisons
  carry all three differences; compare `USING orioledb` with `USING heap`
  inside one project for the engine alone.
- The hosted `postgres` role has no `pg_checkpoint` (`CHECKPOINT` refused) and
  OrioleDB tables have no `xmin`; measure OrioleDB write volume with the
  `pg_current_wal_insert_lsn()` diff across the transaction.
- Unchanged-row upsert/UPDATE, 100,000 rows: 5,786,200 bytes of WAL on an
  OrioleDB table against 30,946,504 on a heap table in the same project; the
  OrioleDB table did not grow, the heap table doubled. Guards that wrote 0 on
  heap wrote 0 on OrioleDB; the guarded upsert (which locks every row) wrote
  5,616,512 on heap and 224 on OrioleDB. Ten all-row UPDATE rounds with
  autovacuum off: heap 7,659,520 to 84,148,224 bytes, OrioleDB constant at
  8,445,952; OrioleDB `n_dead_tup` still counts the updates (1,000,000), and
  `VACUUM FULL` is refused on OrioleDB tables.
- pgbench at `small`, 12 clients, 30 s, 2 runs, through the pooler (7.1 to
  7.8 ms round trip): no throughput difference between an OrioleDB and a heap
  table in the same project (ranges overlap in 3 of 4 script cells; 4-client
  cell 466.3 vs 463.3 tps). The cells sit at the round-trip bound, not the
  server. The vendor's 1.8x (8xlarge, TPC-C-derived) was not tested.
- Refused on an OrioleDB table: `CREATE INDEX CONCURRENTLY`, SERIALIZABLE,
  `VACUUM FULL`, `CLUSTER`, `ALTER TABLE ... SET ACCESS METHOD` (either
  direction on an OrioleDB table). Accepted: GIN/GiST/BRIN/hash, FKs to and
  from heap tables, triggers, RLS, partitions, TOAST, pgvector HNSW,
  publications and logical slots (decoded messages identical to a heap
  table), Realtime `postgres_changes` (6 of 6 events), Data API.
- `ALTER TABLE ... SET ACCESS METHOD orioledb` on a heap table ended the
  backend connection in 5 of 5 attempts; the server came back in 3 and sat in
  a startup-process segfault loop in 2 (manual probes; `POST /restart` did not
  recover the one tried). Do not run it on a project you need.
- PITR: `PATCH /billing/addons` pitr_7 answers HTTP 400 "Projects using the
  OrioleDB Technical Preview image do not support PITR addon." on the OrioleDB
  project and 200 on the heap control. Backups: `walg_enabled` false on the
  OrioleDB project, true on the control.
- A Free org created an OrioleDB project (`instances.orioledb` is true on the
  Pro, Team and Free orgs read), matching the changelog and not the "Pro and
  up" in the announcement.
- The heap control's 2 GB default disk filled during a 1,000,000-row plain
  upsert (303 to 312 MB WAL per statement; `pg_wal` 0.69 then 1.29 GB with
  `walg_enabled` true); it passed with the disk set to 8 GB. Cause not
  isolated.

## experiments/branching-nogit - key facts (validated 2026-10-10, Pro org, ap-southeast-1)

- **Branching without git: `POST /merge` applies the branch's migration
  history, not the schema difference `GET /diff` shows** (branching-nogit
  BN01-BN03, two runs each on 2026-10-10, Pro org, ap-southeast-1). A branch
  created with no `git_branch` reads `ACTIVE_HEALTHY` 1-2 s after the create
  call, before the parent's schema is on it (baseline table first seen after
  43-53 s; a diff read in that window proposes `drop table` for the parent's
  table, one trial by hand). `POST /projects/{branch_ref}/database/query`
  works on the branch ref (`GET /projects/{branch_ref}` is 404). A table, RLS,
  policy, privilege change, function, column and index written that way
  were all in `GET /diff` (default, `pgdelta=true`, `pgdelta=false`; default
  equals `pgdelta=false`) and none reached the parent: merge 201
  (`workflow_run_id`), nothing present after 245-258 s, parent history
  unchanged (BN01, BN03). `PATCH request_review: true` first changed nothing
  (BN03). The same objects written through `POST /projects/{branch_ref}/
  database/migrations` merged in 42-56 s with a history row (BN02, same
  branch and merge as a `/database/query` set that stayed out). By hand, once:
  the MCP `execute_sql` set stayed out and the `apply_migration` set merged.
  `pg_net` appears in every diff and was never installed on the parent. Not
  measured: the dashboard's own SQL Editor and Table Editor routes (a PAT
  cannot call them), so the blog's "tracked" is untested for the dashboard;
  `migration_version`; the dashboard merge-request screen.

## experiments/replica-routing - key facts (validated 2026-10-10, Pro org)

- **The API load balancer's host is `<ref>-all.supabase.co` and the Management
  API does not return it** (RR01e, 2026-10-10): the Dashboard route
  `GET /platform/projects/{ref}/load-balancers` answers a PAT with 401
  `Unsupported access token`, and the replica's REST host is
  `<identifier>.supabase.co` (the `identifier` of the `READ_REPLICA` pooler
  entry). Both were found by name, not read from an API.
- **A GET through the load balancer reached the replica, a POST did not**
  (RR01f/g/h): replica in ap-southeast-1, primary in ap-northeast-1, from a
  Singapore workstation 40 of 40 GETs to `rpc/rr_whoami` were served by the
  replica and a `POST` to the same stable function and a `POST` insert by the
  primary. From Edge Functions pinned with `x-region` (10 GETs each): replica
  for ap-southeast-1, ap-southeast-2, ap-south-1, sa-east-1; primary for
  ap-northeast-1, eu-west-1, us-east-1, us-west-1. One project, one run.
- **The load balancer's log row names its own choice** (RR01o): `edge_logs`
  carries `request.cf.colo`,
  `load_balancer_geo_aware_info.available_supabase_regions`,
  `load_balancer_geo_aware_info.chosen_supabase_region` and
  `load_balancer_redirect_identifier` (the target's host). Chosen region
  followed the Cloudflare colo in all 9 colo groups seen (SIN, SYD, BOM, GRU to
  the replica's region; NRT, DUB, IAD, SJC to the primary's). The rule is not
  separated: a distance rule and a fixed colo table both fit. Query with
  `source = 'edge_logs'` and `log_attributes['...']`; a `split(...)[1]` in the
  select list was refused with `Backend error!`.
- **`inet_server_addr()` cannot identify a replica**: it returned the
  loopback address on both nodes. Use `pg_is_in_recovery()` plus
  `pg_postmaster_start_time()` (RR01, exploratory run).
- **`max_standby_streaming_delay` is 30 s on a replica and the primary, source
  `default`; `hot_standby_feedback` is off** (RR01l). A replica query held in a
  repeatable-read transaction was cancelled in 6 of 6 trials with SQLSTATE
  40001 `canceling statement due to conflict with recovery`, about 30 to 32 s
  after the primary ran UPDATE+VACUUM (3) or an ACCESS EXCLUSIVE lock (3)
  (RR01m/n). Replay stopped for that time: a row written on the primary
  afterwards was invisible on the replica for about the same 30 to 32 s, so the
  read-your-writes gap on a replica is bounded by this setting, not by network
  lag. Not run with `hot_standby_feedback` on.
- **First read after a write on a cross-region replica (Tokyo to Singapore,
  light load)**: 0 of 30 first reads missed, but the writing client took longer
  to return than replication took, so this bounds the gap for that client shape
  only (RR01i). Per-insert delay from database clocks is in RR01k (40
  inserts, includes clock skew; one insert took a few hundred ms).
- **Cross-region replica provisioning on Small**: entry and first answer at 271 s
  in the published run (roughly 150 s in an exploratory run with no artifact); removal 204,
  gone at once (RR01d, RR01p).
- **Resetting a project's database password** (`PATCH /database/password`)
  left the Tokyo session pooler refusing it for over 60 s in 2 exploratory
  runs; a fresh project's pooler accepted its create-time password at once.

## experiments/scoped-pats - key facts (SP01-SP10, validated 2026-10-10)

Scoped personal access tokens (GA, https://supabase.com/changelog/scoped-personal-access-tokens-ga)
against the Management API. Self-provisioning, no OpenTofu state.

- Creation has no API. The public `/v1` OpenAPI document (115 paths, 170
  operations on 2026-10-10) has no access-token creation operation, and the
  dashboard's route `GET /platform/profile/access-tokens` answers a PAT
  `401 "Unsupported access token"` (SP01a/b). Modules that need a token of a
  chosen scope skip with the dashboard hand-off until `PVLAB_SCOPED_PAT_<ROLE>`
  is set (`ORG`, `RO`, `DBRW`, `NARROW`, `MEMBER`, `REVOKE`, optional
  `PVLAB_LEGACY_PAT`); fixtures come from `PVLAB_PEER_FIXTURE` / `_OTHER`.
- The OpenAPI document declares `x-fga-permissions` on 164 of 170 operations
  (73 distinct names). SP02 generates its 59 probes from it and compares the
  refusal it predicts with the observed 403 `missing_permissions`. Reading
  (outer OR, inner AND) is a hypothesis until a narrow token is run.
- The lab's own `SUPABASE_ACCESS_TOKEN` has the `sbp_fc` format (the docs' mark
  of a scoped token). With it: `GET /v1/profile` is 403 "requires a
  user-scoped access token", `supabase whoami` exits 1 on that 403, `supabase
  orgs list` and `projects list` exit 0 (SP06); all 59 SP02 probes pass the
  permission check (0 `missing_permissions`; 6 feature-absent 4xx).
- `/database/query/read-only` refuses `create table` with SQLSTATE 25006 and
  `/database/query` creates it (SP05 control).
- `x-ratelimit-remaining` is a per-route counter (limit 120): the same route
  falls 117,116,115,114; two alternated routes keep separate sequences (SP10).
  An SP04d comparison of two tokens is valid only on one route.
- Not measured, with prerequisites in RUNLOG.md: Q14 org-scoped token on
  production, the per-permission matrix and 403 body, SQL read-only without
  Database read-write, the project boundary, creator-role tracking (needs a
  second human), revocation latency, immutability and expiry (dashboard-only).

## experiments/free-email-templates - key facts (validated 2026-10-10)

Source claim: changelog 2026-06-03, https://github.com/orgs/supabase/discussions/46599.
Measured on new projects (free n=3 across two free orgs, Pro control n=1),
Management API `PATCH /v1/projects/{ref}/config/auth`, ap-southeast-1:

- Free project on default SMTP: each of the six `mailer_templates_*_content`
  fields alone, all six `mailer_subjects_*` in one PATCH, and the seven
  notification-template content fields in one PATCH are all refused with HTTP
  400 `Email template modification is not available for free tier projects
  using the default email provider. Please upgrade your plan or configure a
  custom SMTP provider.` (0 of 6 persisted, 3 of 3 runs for content and
  subjects; notification templates n=2). A non-template PATCH (`site_url`) and
  enabling a notification flag return 200.
- Same project after writing dummy custom SMTP fields (host, port, user,
  password, admin email, sender name; the write accepts a host that is not an
  SMTP server): 6 of 6 content PATCHes 200 and persisted, subjects 200.
- `smtp_host` alone did not lift the refusal (400, n=2). One PATCH carrying the
  SMTP fields plus a template field succeeded (n=3).
- Clearing the SMTP fields (null) returned 200 and the stored custom templates
  were gone (6 of 6 equal to default text, n=2); template writes were refused
  again (n=3).
- Pro-org control, default SMTP: 6 of 6 content PATCHes, subjects and
  notification templates all 200 and persisted (n=1).
- Not measured: pre-2026-06-03 free projects, email delivery, which SMTP
  fields lift the lock, the dashboard path, other plans.

## experiments/mgmt-api-faults - key facts (MF01-MF05, validated 2026-10-10)

Fault injection in front of the Management API (local proxy container; the CLI
via a profile file whose `api_url` is the proxy, the OpenTofu provider via
`endpoint`, the harness via `mgmtBase`). Every fault is injected; no real 5xx
was observed. Counts are proxy-log rows. Pro org, ap-southeast-1, one trial per
cell unless the RUNLOG says otherwise.

- Harness `mgmt()` never retries (1 attempt on 500/502/503/504, MF01a).
  `functionPresent()` retries 429 only, a fixed 15 s sleep (3 attempts, about
  30 s for two 429s); a 500 on its read returns `present: false` with `status`
  500 (MF01c). `mgmt()` throws `TimeoutError` at its 30 s default (MF01d).
- supabase CLI 2.120.0: GET, PUT and DELETE get 6 attempts per call with no
  pause on a 500 (GET: also 502/503/504); POST gets 1 attempt on 500, 502, 503,
  504 and 429; 429 is not retried for GET either (MF03a-c). Per-attempt timeout
  60 s (a 100 s hold gave attempts at 0, 60, ..., 300 s, exit after 360 s,
  MF03e). A held POST is not resent: the create lands, the CLI exits 1 at
  60 s (MF05a).
- OpenTofu provider (supabase/supabase, version in the experiment lock file):
  retries GET (4 attempts on a persistent 503; 2 on a single 500 or 429), does
  not retry POST, PATCH or DELETE on 500 (MF04a, d, e, f). Waited a 130 s held
  create without giving up (MF05b).
- A create answered 500 after upstream created the project leaves state empty
  and an orphan upstream; re-apply gets 400 (name already exists in the org)
  until the orphan is deleted (MF04b-c). The same-name 400 is the only
  duplicate protection observed; a retry with a fresh name is not covered and
  was not run (MF02c).
- Partial apply: project in state, settings write failed (MF04d0); a settings
  write that landed but answered 500 converges at the next plan (MF04d2); a
  DELETE that landed but answered 500 leaves a state entry that destroys
  cleanly later (MF04f2-f3).
- Not measured: real 5xx bodies, connection-level faults, PATCH through the CLI,
  writes answered 502/503/504/429 in the provider, docs claims.

## experiments/pg-minor-17-11 - key facts (validated 2026-10-10, local Docker, supabase/postgres 17.6.1.178 -> 17.11.0.004 and 15.14.1.178 -> 15.19.0.004)

Local only, no managed project. Each module starts the old image on a fresh
data directory, builds a fixture, stops it, and starts the new image on the
SAME data directory (binaries replaced, data kept; not the hosted upgrade
procedure). Reference answers come from a sequential scan or from a count that
does not use the code under test. Details: RUNLOG.md.

- **pgcrypto bf / blowfish / cast5 were stored unencrypted on the old image
  and fail to decrypt by default on the new one (PG01).** The sentence is
  visible in the ciphertext bytes, a wrong key decrypts, and on the new image
  right and wrong key both raise `encrypt error: Cipher cannot be initialized`
  unless `ignore-cipher-failure=1` is passed (then both decrypt). The old image
  rejects that option (`Illegal argument to function`), so it exists only after
  the upgrade. A wrong-passphrase scan flags the three ciphers on the old image
  and flags nothing on the new image by default (the values error like
  properly encrypted ones, with a different message); run it before the
  upgrade or with the option. aes128, aes256, 3des and the default are
  unaffected. Same on 15.14 -> 15.19. Public-key variants not measured.
- **A non-built-in RESTRICT / JOIN estimator needs superuser on the new image
  (PG02).** As `postgres`: refused with 42501 for CREATE OPERATOR and for ALTER
  OPERATOR; `eqsel` accepted. As `supabase_admin`: accepted. `postgres` cannot
  create C functions (42501 permission denied for language c). Operators created
  on the old image keep working; `pg_dump` restored as `postgres` fails (2 of 3
  operators missing), as `supabase_admin` is clean. Same on both pairs.
- **btree_gist float4 / float8 indexes with NaN return wrong counts and
  REINDEX INDEX CONCURRENTLY fixes them (PG03).** On the old image 5 of 10
  predicates (float4) and 7 of 10 (float8) disagree with the heap, for example
  `x = 'NaN'` returns 0 of 50; a stale index on the new image still disagrees on
  3 and 5; after reindex and for a fresh index, 0. amcheck 1.4 / 1.3 has no
  GiST check on these images.
- **ltree values over 14,654 labels compare wrongly on the old image (PG04).**
  First wrong n is 14655 on both pairs (19 of 34 sweep values); the B-tree
  built on the old image fails `bt_index_parent_check`. On the new image
  comparisons are right; the stale index passed amcheck and answered correctly
  for one 453-row fixture, which does not show stale indexes are safe.
- **The ltree case-folding index advice did not reproduce (PG05).** A GiST
  index on ltree misses rows for case-insensitive (`@`) matches whose accented
  letters differ in case from the stored label (about 72 percent of 600 queries)
  on the old image, the new image, after REINDEX and for a fresh index, in ICU
  and libc databases, on both pairs. The index hash function is byte-identical
  in the upstream 17.6 / 17.11 and 15.14 / 15.19 sources; the operator side
  changed (libc databases: `U+0130 STANBUL@` matches 3 rows instead of 1, the
  index still returns 1). Inference: the index-side fix described by the
  changelog is the 18.2 one; whether the hosted build differs is untested.

## experiments/cli-surface - key facts (Supabase CLI 2.120.0, validated 2026-10-10)

- **pg-delta vs migra (CL01, CL02, CL03).** Measured by catalog fingerprint (238 lines,
  lib/fingerprint.ts), not by reading the SQL. On a fixture with FORCE RLS, 6 policies,
  column and sequence grants, default privileges, comments and a security_invoker view, a
  `db diff --use-migra` migration rebuilt 223 of 238 lines (it dropped FORCE RLS, the comments,
  default privileges, schema USAGE grants, security_invoker and the function EXECUTE grant to
  `authenticated`, and left PUBLIC execute); `--use-pg-delta` rebuilt 238 of 238. On 2.120.0 a fresh
  `supabase init` ran pg-delta with no flag (`[experimental.pgdelta] enabled = true`); the sources disagree
  on whether that is the default (the changelog says not yet, the Select 2026 blog says it is for new init projects). Declarative
  `generate`, then `sync`, then `db reset` also gave 238 of 238, and a second sync, diff and export
  were empty or identical. `sync` orders by dependency (hand-written tree, files named against
  dependency order), turns a deleted table file into DROP TABLE with a destructive-changes
  warning, and rewrites a changed policy as drop plus create. pg-delta named 17 of 22 object
  kinds in its diff; `--strict-coverage` fails on cast, operator, statistics object and text
  search configuration. With an exported `supabase/schemas` tree present, `db diff --use-migra`
  fails (`extension "pgcrypto" already exists`). Unmeasured: Postgres 15 targets (the diff
  contains MAINTAIN grants), correctness of kinds beyond a marker-name regex.
- **config pull and pull (CL04).** `config pull` compares api, auth, database, pooler, realtime,
  storage. Written after API-side changes: max_rows, storage file_size_limit, anonymous
  sign-ins. Skipped: an enabled GitHub provider ("requires values pull cannot write"; the secret
  must be set by hand). Not pulled: storage buckets. `supabase pull` on a never-migrated
  project exits 1 on the migration-history step but writes the schema migration (238 of 238
  fingerprint lines on a local rebuild). `db diff --linked --use-migra` failed with
  `getaddrinfo ENOTFOUND` for the direct DB host from a vantage that resolves no A record for it,
  while pg-delta worked; cause not separated.
- **Experimental stack without Docker (CL20-CL22).** Off by default: no variable or key means
  the legacy Docker backend (exit 1 without Docker). `SUPABASE_EXPERIMENTAL_STACK=1` or
  `[experimental] stack = true` selects the stack; the variable wins over the key (0 beats true).
  `supabase init` under the variable writes `stack = true` and no `port =` lines, so every stack
  gets its own random ports (3 stacks, 30 distinct ports). Native runtime in a linux/arm64
  container: cold start 14145 ms (artifact download), warm restart 643 ms, 2 extra worktrees
  about 2 s each, `stop` about 12 s. Only the database runs at return; 9 services start on first
  request (rest 312 ms ... studio 4937 ms). Summed PSS 252 MB asleep, 2145 MB awake per stack (one run, n=1, 10 CPUs).
  Stack identity is directory plus branch: a branch switch inside a worktree then `start` makes a
  second, empty stack. A config with fixed legacy ports makes the second worktree fail to bind.
  Config changes apply on `stop` then `start` (not `start` or `stack restart`). The stack backend
  refuses `--use-migra`. Image transformation, pooler and drift behaviour: RUNLOG CL22c, CL22d.
  Unmeasured: amd64, CI runners, idle stops, pooler SQL path.

## experiments/self-hosted-defaults - key facts (SD01-SD08, validated 2026-10-10, local rig)

Local rig, no project or PAT: `make stack up probe clean` clones
supabase/supabase at a pinned commit into the gitignored `work/`, copies
`docker/` to `work/stack`, runs the upstream key scripts and drives the stack
through the gateway port, `docker exec` and `docker compose`. The directory
`work/` holds a full clone: run `bun test` with a path (`make unit` does), or
bun discovers the clone's own test files.

- Gateway is Envoy (`api-gw`), no Kong service, nothing published on host 8443
  or 8001 (SD01); the Kong override swaps it in with 8443 and a `server: kong/...`
  header, and the swap back restores Envoy (SD07, the control for SD01's
  absences). The Envoy container keeps the network aliases `envoy` and `kong`,
  so a hostname that still says `kong` reaches Envoy.
- Opaque keys: no key or a made-up `sb_secret_` key gets Envoy's own 401
  (`text/plain`, `Unauthorized`); `sb_publishable_` behaves as the legacy anon
  JWT and `sb_secret_` as the legacy service_role JWT on the six routes probed;
  PostgREST sees `role` anon or service_role with claims `exp`, `iat`, `iss`,
  `role` only (SD02). Precondition: `.env.example` ships the four opaque-key
  variables empty; with them empty Envoy logs "legacy API key mode (sb_ keys
  disabled)" and answers 401 to both `sb_` keys while the legacy JWTs still work
  (SD08). `utils/add-new-auth-keys.sh` also uncomments four lines in
  `docker-compose.yml` (`GOTRUE_JWT_KEYS`, `API_JWT_JWKS`, `JWT_JWKS`,
  `SUPABASE_JWKS`; SD02d); with it, access tokens are ES256 with a `kid` that
  verifies against `/auth/v1/.well-known/jwks.json` (SD06b).
- Database is Postgres 17 by image tag, server and data directory (SD03a). The
  `pg_graphql` extension is available but not created on a fresh stack, and
  `POST /graphql/v1` answers HTTP 200 with an error body (SD03c).
- Studio and postgres-meta run as `postgres` (not a superuser: rolsuper false;
  `supabase_admin` is) through `/pg/query` and Studio's pg-meta route (SD04).
  The database shows one application name for both, so Studio's own connection,
  if it has one, was not observed. Realtime, Supavisor, `pg_cron` and `pg_net`
  still connect as `supabase_admin`.
- Analytics and Vector exist only with `docker-compose.logs.yml`: the override
  adds exactly those two services, Vector is the only service mounting the
  Docker socket, Studio's `ENABLED_FEATURES_LOGS_ALL` flips false to true, and
  Envoy has no `/analytics/v1` route (SD05).
- `API_EXTERNAL_URL` is `<public url>/auth/v1` and equals `GOTRUE_JWT_ISSUER`;
  token `iss` is that value; `generate_link` returns `/auth/v1/verify` (no
  doubled prefix) (SD06a-c). With SAML disabled, `/auth/v1/sso/saml/metadata`
  reaches Auth (404 `saml_provider_disabled`) and the old `/sso/saml/metadata`
  falls to the dashboard gate; with SAML enabled the metadata entityID and ACS
  URL are `<API_EXTERNAL_URL>/sso/saml/{metadata,acs}`, the ACS route needs no
  apikey, and an invented IdP registered with the secret key yields a SAMLRequest
  redirect (SD06d-f). A real IdP assertion was not exercised.
- Not measured: `sb_` keys against Realtime and Edge Functions, a Postgres 15 to
  17 upgrade, Linux amd64, image digests, repeat runs.

## experiments/multigres - key facts (validated at runtime; see RUNLOG.md)

Setup:

- Local only, no cloud spend: the upstream repo's all-in-one image
  (`Dockerfile.cluster`) runs etcd + multiadmin + per cell pgctld/postgres,
  multipooler, multiorch, multigateway as child processes. The v0.1.0 tag has
  no such Dockerfile (404 at that ref); the Makefile builds a pinned `main`
  commit. This is NOT the Kubernetes operator path the blog describes.
- 3 cells, `synchronous_standby_names = ANY 1 (3 poolers)`,
  `synchronous_commit=on`, multiorch timers 500 ms, and
  `allow-unsafe-initial-cohort: true` set by the entrypoint. A single cell
  never becomes ready; the shard needs 2 poolers to elect a leader.
- Run from source (`bun harness/src/run.ts`), not the linux-x64 `pvlab`.
  Faults are `docker exec kill`; the tests recreate the container themselves.

Measured (macOS Docker Desktop, 8 closed-loop writers; out/2026-10-10/run-2026-10-10T01-44-48-951Z.json):

- 17 failovers, 2,216,532 acknowledged writes checked, 0 acknowledged-but-lost.
  Includes MG08: a standby held 22-23 MB behind (SIGSTOP 20 s), then primary
  and the current standby killed; the lagging standby was never promoted.
- Client-visible stall (longest ack-free gap): postgres SIGKILL 1.1-4.2 s
  (MG02), 1.9-6.7 s with one 10 writes/s client (MG09); whole-cell kill
  14.7-15.1 s (MG03); hung primary (SIGSTOP) 20.0 and 25.1 s in run5 (the 25.1
  includes a client 5 s connect timeout) and 20.0 to 56.2 s over six runs in
  three artifacts: the pooler-level promote lands at about +20 s, multiorch
  logs the promotion success at about +40 s (the recruit RPC to the frozen cell
  times out first), and in the 56 s run the first promotion attempt failed and
  a second succeeded at +57.8 s (MG04). Detection after a postgres kill varies
  from about 1 s to about 6.7 s and the cause is unexplained.
- Clients are not shielded: in-flight statements fail (one per worker), new
  connections get `no writable primary is currently available` or `database is
  temporarily unavailable; please retry`, and 2-5 connects per postgres-kill
  run were refused with `password authentication failed` using the correct
  password. pgbench clients abort at the kill (exit 2); a relaunch loop
  recovered with a 2.3 s gap.
- Nothing restarts a killed cell in this container: after killing a primary's
  postgres + multipooler + pgctld the cluster stayed at 2 nodes for 45 s.
- Gateway feature matrix (S01 probes): 9 of 9 on the zone1 and zone2
  gateways, one uncontended client. Per-user pools: each role got a backend
  logged in as that role (2 roles).

Not measured: the operator/kind path, the invite-only private alpha, network
partitions, other durability policies, a contended pool.

## experiments/terraform-edge-functions - key facts (validated 2026-10-10, tofu 1.13.1, supabase provider 1.11.0)

- 24 `supabase_edge_function` resources + one `supabase_edge_function_secrets`
  in one apply at `-parallelism=24`: tofu reported 25 created, exit 0, 0 errors
  in 4 of 4 runs; the Management API listed 3, 5, 3 and 4 of the 24 (the
  listing did not grow between +10 s and +70 s). In the 2 runs that probed the
  unlisted slugs, `GET /functions/{slug}` was 404 on all of them (21, 20) and
  an invocation answered 200 on all of them. At `-parallelism=1` the same
  apply listed 24/24 (3 runs, 31 to 41 s).
- Re-applying at 24 does not converge: after 4 rounds 13, 14, 14, 10 of 24
  listed. Each round's reported creations equal 24 minus the listed count
  before the round (16 of 16 rounds).
- Width sweep, fresh state, listed at +70 s: width 1 24, width 2 17 (2 runs),
  width 4 9 and 13, width 10 4 to 6, width 24 2 to 4. Direct
  `POST /functions/deploy`, 24 in flight: 24 x 201, 3/24 listed (2 runs); one
  at a time: 24/24. The loss is the endpoint's, as in edge-function-limits
  EF05a; the provider adds a success report with no check.
- Updates are planned in place (24 change, 0 replace) and land (24/24 serve
  the new body), but every update apply exits 1 with `Provider produced
  inconsistent result after apply` on `.checksum`, `.updated_at`, `.version`
  (72 errors for 24 functions), at width 1 and at 24. At width 24 the listing
  showed 2/24 (6/24 in one run) versions increased while 24/24 served the new
  body; the cause is not separated.
- Destroy at `-parallelism=24` exits 0 and empties state while the listed
  functions stay: 14 listed before, 13 after (run3); 10 and 10 (run4); in
  run4 23 of 24 slugs still answered 200 after the destroy (one trial).
  Fresh-state destroy at the same width left 7 of 17 (width 2), 4 to 7 (width
  4), 3 to 5 (width 10), 1 to 3 (width 24) listed; `-parallelism=1` left 0.
- The secrets resource listed 0/3 after a width-24 apply (run3 and run4 first
  apply, run2 and run4 fresh apply) and 3/3 at width 1.
- Not measured: other provider versions, Terraform, other regions or sizes,
  whether unlisted functions list later, how long a destroyed function keeps
  answering.
