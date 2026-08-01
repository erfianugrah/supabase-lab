# Template for secrets.tfvars. Copy to secrets.tfvars, fill in, then
# `make secrets-encrypt` to produce the committed secrets.enc.tfvars.
# secrets.tfvars itself is gitignored; never commit it.

# Supabase Management API PAT - used by BOTH the supabase provider and the
# restapi provider (PrivateLink association calls).
supabase_access_token = "sbp_REPLACE_ME"

# Target org. Not actually secret, but kept here so plan/apply needs only
# one var file.
supabase_org_id = "REPLACE_ME"

# AWS account the RAM resource share is sent to (PrivateLink target account).
aws_account_id = "REPLACE_ME"

# AWS credentials for that account. Optional: leave both empty to use the
# ambient chain (~/.aws/credentials profile, SSO, or env vars) instead.
# Filled in, they win over anything in the environment - which is the point:
# a stale AWS_ACCESS_KEY_ID in your shell cannot silently break a run.
aws_access_key_id     = ""
aws_secret_access_key = ""

# Postgres password for the lab project. Generate: openssl rand -hex 16
db_password = "REPLACE_ME"

# Your current public IP, /32. Used as the break-glass allowlist entry when
# testing "public access closed" (make restrict).
breakglass_cidr = "REPLACE_ME/32"
