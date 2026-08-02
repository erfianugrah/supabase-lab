#!/bin/bash
# Bootstrap for the supabase-lab runner (Amazon Linux 2023).
# Terraform templatefile - dollar-brace references below are TF-substituted.
set -euxo pipefail

# dnf metadata can be cold at boot (run 4: both install attempts failed at
# 30s uptime, packages visible 20min later) - refresh first.
# No `curl` in the list: AL2023 ships curl-minimal, which conflicts (run 4b).
# curl-minimal provides /usr/bin/curl with HTTP(S), enough for the CLI fetch.
dnf makecache --refresh
dnf install -y postgresql16 postgresql16-contrib bind-utils jq tar gzip || \
  dnf install -y postgresql15 postgresql15-contrib bind-utils jq tar gzip

# supabase CLI, latest release (linux amd64 tarball)
ASSET=$(curl -s https://api.github.com/repos/supabase/cli/releases/latest \
  | jq -r '.assets[] | select(.name | test("linux_amd64.tar.gz")) | .browser_download_url' | head -1)
curl -sL "$ASSET" | tar xz -C /usr/local/bin supabase
chmod +x /usr/local/bin/supabase

mkdir -p /etc/pvlab /home/ssm-user
cat > /etc/pvlab/env <<'ENV'
REF=${ref}
PHZ_HOST=${phz}
AWS_REGION=${region}
ENDPOINT_DNS=${ep_dns}
ENDPOINT_IPS="${ep_ips}"
POOLER_HOST=aws-0-${region}.pooler.supabase.com
API_HOST=api.supabase.com
ENV
chmod 644 /etc/pvlab/env

# Test payload - the thing under test, not provisioning glue.

# ssm-user does not exist until the first SSM session - do not fail the boot.
chown -R ssm-user:ssm-user /home/ssm-user 2>/dev/null || true
echo "pvlab bootstrap complete (phase2=${phase2})"
