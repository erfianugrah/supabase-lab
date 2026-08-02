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
- Tests live in `harness/` (shared contract + runner + report renderer) and
  `experiments/<name>/tests/*.ts` (the test modules). Adding a test is ONE
  file exporting a `TestModule`: `where` picks the vantage (runner vs local
  orchestrator), `requires` gates on capabilities so it self-skips with a
  reason, `destructive` defers it behind `--destructive`, and anything in
  `measurements` becomes a report column with no renderer change.
- A measured `fail` is data, not an error to retry away. The suite records
  outcomes; it never drives the external system to green.
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
