#!/bin/bash
# suite.sh - run the typed harness from both vantages and render one report.
#
# Ships a single compiled binary to the runner (same S3-presign path gocurl
# used) instead of base64-ing a pile of shell scripts through SSM payloads -
# which is where the quoting bugs lived. Artifacts come back the same way.
#
#   ./suite.sh              # read-only battery
#   ./suite.sh --destructive  # includes restart / replacement tests
set -euo pipefail
cd "$(dirname "$0")"

# Local env quirk: stale AWS env keys override ~/.aws/credentials.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

DESTRUCTIVE=""
[ "${1:-}" = "--destructive" ] && DESTRUCTIVE="--destructive"

ROOT=$(cd ../.. && pwd)
REGION=$(grep aws_region experiment.tfvars | cut -d'"' -f2)
ACCOUNT=$(grep aws_account_id "$ROOT/secrets.tfvars" | cut -d'"' -f2)
RUNNER=$(tofu output -raw runner_id)
REF=$(tofu output -raw project_ref)
DBPW=$(grep -E '^db_password' "$ROOT/secrets.tfvars" | cut -d'"' -f2)
TOK=$(grep -E '^supabase_access_token' "$ROOT/secrets.tfvars" | cut -d'"' -f2)
BUCKET="supabase-lab-suite-$ACCOUNT"
TS=$(date +%Y%m%d-%H%M%S)
EVID="evidence/$TS"
mkdir -p "$EVID"

echo "== 1/5 build the harness binary =="
(cd "$ROOT/harness" && bun run build >/dev/null && ls -lh dist/pvlab | awk '{print "  "$5" dist/pvlab"}')

echo "== 2/5 stage it to the runner =="
aws s3 mb "s3://$BUCKET" --region "$REGION" 2>/dev/null || true
aws s3 cp "$ROOT/harness/dist/pvlab" "s3://$BUCKET/bin/pvlab" --quiet
GET_URL=$(aws s3 presign "s3://$BUCKET/bin/pvlab" --expires-in 3600 --region "$REGION")
PUT_URL="s3://$BUCKET/artifacts/runner-$TS.json"   # runner writes with its instance role

ANON=$(curl -s -H "Authorization: Bearer $TOK" \
	"https://api.supabase.com/v1/projects/$REF/api-keys" | jq -r '.[] | select(.name=="anon") | .api_key' | head -1)

ssm() { # <commands-json-file> <label>
	local cid st
	cid=$(aws ssm send-command --region "$REGION" --instance-ids "$RUNNER" \
		--document-name AWS-RunShellScript --timeout-seconds 3600 \
		--parameters "file://$1" --query 'Command.CommandId' --output text)
	echo "  [$2] $cid"
	while true; do
		sleep 10
		st=$(aws ssm get-command-invocation --region "$REGION" --command-id "$cid" \
			--instance-id "$RUNNER" --query Status --output text 2>/dev/null || echo Pending)
		case "$st" in Success|Failed|Cancelled|TimedOut) break;; esac
	done
	aws ssm get-command-invocation --region "$REGION" --command-id "$cid" \
		--instance-id "$RUNNER" --query StandardOutputContent --output text
	[ "$st" = Success ] || echo "  [$2] status: $st"
}

echo "== 3/5 run the runner-side battery =="
# Phase 2 replaces the runner (the endpoint flips a user_data template var),
# so the instance may still be registering when we get here. Wait for SSM,
# then let cloud-init finish before the tests look for psql/pgbench.
for i in $(seq 1 40); do
	ping=$(aws ssm describe-instance-information --region "$REGION" \
		--filters Key=InstanceIds,Values="$RUNNER" \
		--query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || echo none)
	[ "$ping" = "Online" ] && break
	echo "  waiting for SSM on $RUNNER ($ping)"
	sleep 15
done

jq -n --arg get "$GET_URL" --arg put "$PUT_URL" --arg dbpw "$DBPW" --arg anon "$ANON" --arg tok "$TOK" --arg d "$DESTRUCTIVE" '{
  commands: [
    "cloud-init status --wait >/dev/null 2>&1 || true",
    "curl -sL \"" + $get + "\" -o /usr/local/bin/pvlab && chmod 755 /usr/local/bin/pvlab",
    "export DB_PASSWORD=\"" + $dbpw + "\" SUPABASE_ANON_KEY=\"" + $anon + "\" SUPABASE_ACCESS_TOKEN=\"" + $tok + "\"; pvlab --where runner --out /tmp/pvlab " + $d,
    "aws s3 cp \"$(ls -t /tmp/pvlab/run-*.json | head -1)\" \"" + $put + "\" && echo artifact-uploaded"
  ]
}' > "/tmp/pvlab-run-$TS.json"
ssm "/tmp/pvlab-run-$TS.json" runner | tail -25
aws s3 cp "s3://$BUCKET/artifacts/runner-$TS.json" "$EVID/runner.json" --quiet

echo "== 4/5 run the local-side battery =="
PVLAB_REF="$REF" PVLAB_LAMBDA="$(tofu output -raw lambda_invoke 2>/dev/null | grep -q 'disabled' && echo 0 || echo 1)" \
	DB_PASSWORD="$DBPW" SUPABASE_ACCESS_TOKEN="$TOK" AWS_REGION="$REGION" \
	"$ROOT/harness/dist/pvlab" --where local --out "$EVID" $DESTRUCTIVE | tail -20

echo "== 5/5 merge =="
LOCAL_JSON=$(ls -t "$EVID"/run-*.json | head -1)
"$ROOT/harness/dist/pvlab" --merge "$EVID/runner.json,$LOCAL_JSON" --out "$EVID"
echo "== suite done: $EVID/REPORT.md =="
