# supabase-lab

OpenTofu reference environments for Supabase platform features, validated end-to-end on disposable infrastructure. Each experiment is one OpenTofu state under `experiments/<name>/` - build, run the test suite, `make destroy` the same day. Where platform behaviour diverges from the docs (undocumented endpoints, auth-model gaps, multi-pass applies), the code comments and `RUNLOG.md` capture what was actually measured.

Current experiments:

- `privatelink-aws` - PrivateLink (VPC Lattice) to a Supabase project in
  ap-southeast-1 (demo region; region is one var - `aws_region` in
  experiment.tfvars - and both sides take it, since PrivateLink is
  same-region only): endpoint + SG (5432 AND 6543), Route53 PHZ for
  verify-full, in-VPC runner, CLI migration paths, network-restriction
  closure, restart behaviour.

## Setup (once)

```sh
aws configure sso            # or export AWS creds - none configured on a fresh box
make secrets-decrypt         # writes secrets.tfvars from secrets.enc.tfvars
```

`secrets.tfvars` holds: Supabase PAT, org id, AWS account id, DB password,
break-glass CIDR. Edit + `make secrets-encrypt` to update the committed copy.

## Running an experiment (privatelink-aws)

```sh
cd experiments/privatelink-aws
tofu init
make phase1          # project + PrivateLink association
make wait-ready      # polls association status (needs a dashboard session JWT - PATs get 401; or just watch the dashboard)
make arns            # RAM share + resource config ARNs -> arns.tfvars
make phase2          # VPC, endpoint, PHZ, runner
make suite           # automated: TLS matrix, latency bench (psql/pgbench/gocurl),
                     # pooler-ceiling probe, restart-downtime measurement;
                     # pulls artifacts, renders evidence/<ts>/REPORT.md
make destroy         # when done - NAT + endpoint are the hourly costs
make suite-clean     # remove the suite artifact bucket (not tofu-tracked)
```

Suite evidence lands locally in `experiments/privatelink-aws/evidence/<ts>/`
(gitignored): REPORT.md plus the raw suite-out artifacts. For interactive
work, `make ssm` gives a shell on the runner (`run-matrix.sh` is the manual
test matrix); its logs land in `/home/ssm-user/evidence-<ts>.log` on the
runner - copy them out via the SSM session before destroying.

See `experiments/privatelink-aws/RUNLOG.md` for what each run established
and the measured numbers.

## Cost note

NAT gateway + VPC endpoint + t3.micro is roughly $2.50/day. The lab is
designed to be applied and destroyed within a day. The Supabase project is
deleted with `make destroy` (it is a tofu resource).
