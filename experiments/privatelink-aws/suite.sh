#!/bin/bash
# suite.sh - local orchestrator for the on-runner test suite.
# Deploys suite scripts + gocurl to the runner (S3-staged), runs the phases,
# pulls artifacts back via presigned PUT, leaves an evidence/<ts>/ dir ready
# for render-report.sh. Run via `make suite`.
set -euo pipefail
cd "$(dirname "$0")"

# Local env quirk: stale AWS env keys override ~/.aws/credentials.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

REGION=$(grep aws_region experiment.tfvars | cut -d'"' -f2)
SECRETS=../../secrets.tfvars # repo root, relative to this script's dir (cd'd above)
ACCOUNT=$(grep -E '^aws_account_id' $SECRETS | cut -d'"' -f2)
RUNNER=$(tofu output -raw runner_id)
REF=$(tofu output -raw project_ref)
DBPW=$(grep -E '^db_password' $SECRETS | cut -d'"' -f2)
TOK=$(grep -E '^supabase_access_token' $SECRETS | cut -d'"' -f2)
BUCKET="supabase-lab-suite-$ACCOUNT"
TS=$(date +%Y%m%d-%H%M%S)
EVID="evidence/$TS"
mkdir -p "$EVID"

ssm() { # run a command list file on the runner, poll, print stdout
	local params_file=$1 desc=$2 timeout=${3:-1200}
	local cid st
	cid=$(aws ssm send-command --region "$REGION" --instance-ids "$RUNNER" \
		--document-name AWS-RunShellScript --timeout-seconds "$timeout" \
		--parameters "file://$params_file" --query 'Command.CommandId' --output text)
	echo "  [$desc] command $cid"
	while true; do
		sleep 10
		st=$(aws ssm get-command-invocation --region "$REGION" --command-id "$cid" \
			--instance-id "$RUNNER" --query 'Status' --output text 2>/dev/null || echo Pending)
		case "$st" in Success|Failed|Cancelled|TimedOut) break;; esac
	done
	echo "  [$desc] status: $st"
	aws ssm get-command-invocation --region "$REGION" --command-id "$cid" \
		--instance-id "$RUNNER" --query 'StandardOutputContent' --output text
	[ "$st" = Success ]
}

echo "== 1/6 deploy suite scripts =="
cmds=/tmp/pvlab-deploy-$TS.json
{
	echo '{"commands":['
	first=1
	for f in runner/run-matrix.sh runner/suite/tls-tests.sh runner/suite/bench-latency.sh runner/suite/ceiling.sh runner/suite/t14-restart.sh; do
		b64=$(base64 -w0 "$f")
		name=$(basename "$f")
		[ $first = 1 ] || printf ','
		first=0
		printf '"echo %s | base64 -d > /usr/local/bin/%s && chmod 755 /usr/local/bin/%s"' "$b64" "$name" "$name"
	done
	printf ',"dnf install -y postgresql16-contrib >/dev/null 2>&1 || dnf install -y postgresql15-contrib >/dev/null 2>&1; command -v pgbench || echo PGBENCH-STILL-MISSING"'
	printf ',"ls -la /usr/local/bin/*.sh"]}'
} > "$cmds"
ssm "$cmds" deploy | tail -8

echo "== 2/6 stage gocurl =="
if [ ! -x /usr/local/bin/gocurl ]; then
	echo "  WARNING: /usr/local/bin/gocurl missing locally - HTTP probes will be skipped"
	GOCURL_URL=""
else
	aws s3 mb "s3://$BUCKET" --region "$REGION" 2>/dev/null || true
	aws s3 cp /usr/local/bin/gocurl "s3://$BUCKET/bin/gocurl" --quiet
	GOCURL_URL=$(aws s3 presign "s3://$BUCKET/bin/gocurl" --expires-in 3600 --region "$REGION")
fi
if [ -n "$GOCURL_URL" ]; then
	jq -n --arg url "$GOCURL_URL" '{commands:["curl -sL \"" + $url + "\" -o /usr/local/bin/gocurl && chmod 755 /usr/local/bin/gocurl && gocurl --version 2>&1 | head -1 || echo gocurl-install-failed"]}' > /tmp/pvlab-gocurl-$TS.json
	ssm /tmp/pvlab-gocurl-$TS.json gocurl-install
fi

echo "== 3/6 fetch anon key for HTTP 200s =="
ANON=$(curl -s -H "Authorization: Bearer $TOK" "https://api.supabase.com/v1/projects/$REF/api-keys" \
	| jq -r '.[] | select(.name=="anon") | .api_key' | head -1)
echo "  anon key: ${ANON:0:12}..."

echo "== 4/6 run phases =="
jq -n --arg dbpw "$DBPW" '{commands:["export DB_PASSWORD=\"" + $dbpw + "\"; tls-tests.sh"]}' > /tmp/pvlab-p-$TS.json
ssm /tmp/pvlab-p-$TS.json tls-tests | tee "$EVID/tls-tests.out" || true

jq -n --arg dbpw "$DBPW" --arg anon "$ANON" '{commands:["export DB_PASSWORD=\"" + $dbpw + "\" SUPABASE_ANON_KEY=\"" + $anon + "\"; bench-latency.sh"]}' > /tmp/pvlab-p-$TS.json
ssm /tmp/pvlab-p-$TS.json bench-latency 1800 | tee "$EVID/bench-latency.out" || true

jq -n --arg dbpw "$DBPW" '{commands:["export DB_PASSWORD=\"" + $dbpw + "\"; ceiling.sh"]}' > /tmp/pvlab-p-$TS.json
ssm /tmp/pvlab-p-$TS.json ceiling 1800 | tee "$EVID/ceiling.out" || true

jq -n --arg dbpw "$DBPW" --arg tok "$TOK" '{commands:["export DB_PASSWORD=\"" + $dbpw + "\" SUPABASE_ACCESS_TOKEN=\"" + $tok + "\"; t14-restart.sh"]}' > /tmp/pvlab-p-$TS.json
ssm /tmp/pvlab-p-$TS.json t14-restart 900 | tee "$EVID/t14-restart.out" || true

echo "== 5/6 pull artifacts =="
# aws s3 presign only signs GET; a PUT upload needs a real put_object presign (boto3)
# endpoint_url pins the REGIONAL host: the global s3.amazonaws.com endpoint
# 307-redirects fresh buckets, and a redirect breaks the host-signed presign
PUT_URL=$(python3 -c "import boto3,sys; print(boto3.client('s3', region_name=sys.argv[1], endpoint_url='https://s3.'+sys.argv[1]+'.amazonaws.com').generate_presigned_url('put_object', Params={'Bucket':sys.argv[2],'Key':sys.argv[3]}, ExpiresIn=3600))" "$REGION" "$BUCKET" "artifacts/suite-$TS.tar.gz")
jq -n --arg url "$PUT_URL" '{commands:["cd /home/ssm-user && tar czf /tmp/suite-artifacts.tar.gz suite-out evidence-*.log 2>/dev/null; curl -sf -T /tmp/suite-artifacts.tar.gz \"" + $url + "\" && echo uploaded || echo UPLOAD-FAILED"]}' > /tmp/pvlab-pull-$TS.json
ssm /tmp/pvlab-pull-$TS.json artifact-push
aws s3 cp "s3://$BUCKET/artifacts/suite-$TS.tar.gz" "$EVID/artifacts.tar.gz" --quiet
tar xzf "$EVID/artifacts.tar.gz" -C "$EVID"
echo "  artifacts in $EVID/"

echo "== 6/6 render report =="
./render-report.sh "$EVID"
echo "== suite done: $EVID/REPORT.md =="
