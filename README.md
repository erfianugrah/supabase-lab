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
- `edge-resilience` - what a client can do about platform incidents that
  are not theirs to fix: 25 measured modules (W01-W26) across JWT skew,
  edge cache/failover (Cloudflare worker), warm-standby replication and
  cutover, storage, realtime, edge functions, and pg_cron. Full battery
  battery unattended. See its FAILURE-MATRIX.md + RUNLOG.md.
- `platform-downtime` - what a platform operation (restart, resize,
  upgrade, pause) costs a client, per connection path, in measured
  seconds.
- `platform-facts` - not a behaviour test; harvests per-project facts
  (pg_settings, extensions, versions) for reference.
- `pooler-semantics` - Supavisor session-vs-transaction mode behaviour,
  error codes, and capacity signatures.
- `pdf-corpus-graph` - PDF corpus ingestion + entity graph experiment.
- `stripe-sync-schema` - does the Stripe Sync Engine's projected Postgres
  schema stay in sync with the Stripe API surface.
- `vault-root-key` - two projects; the migration-guide item about vault
  secrets and the project root key.
- `image-transformations` - Storage image transformation billing and runtime
  surface: which URL surfaces transform, docs-vs-runtime limits, edge cache
  and overwrite invalidation, signed-URL tampering, RLS on the render path,
  the rate ceiling, and the (dashboard-gated) billing counter.

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
