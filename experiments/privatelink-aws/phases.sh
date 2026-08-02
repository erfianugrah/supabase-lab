#!/bin/bash
# phases.sh - the run-6 test phases that drive AWS/Supabase APIs from HERE
# rather than from the runner: the Lambda path (the customer-shaped client),
# restart measured through Lambda retries, endpoint replacement as a DNS event,
# and the dualstack/IPv6 attempt.
#
# Each phase records what happened - including failures, which are findings,
# not something to retry away. Usage: ./phases.sh <phase> ; phase in
#   lambda | lambda-restart | endpoint-replace | ipv6 | all
set -uo pipefail
cd "$(dirname "$0")"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

REGION=$(grep aws_region experiment.tfvars | cut -d'"' -f2)
ROOT=$(cd ../.. && pwd)
SECRETS="$ROOT/secrets.tfvars"
VARS="-var-file=$SECRETS -var-file=experiment.tfvars -var-file=arns.tfvars"
REF=$(tofu output -raw project_ref)
PHZ=$(tofu output -raw phz_host)
TOK=$(grep -E '^supabase_access_token' "$SECRETS" | cut -d'"' -f2)
OUT="evidence/phases-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

lambda_invoke() { # -> prints JSON payload
	local resp=/tmp/pvlab-lambda-resp.json
	aws lambda invoke --region "$REGION" --function-name supabase-lab-probe \
		--cli-binary-format raw-in-base64-out --payload "${1:-{\}}" "$resp" \
		--query 'StatusCode' --output text >/dev/null 2>&1
	cat "$resp" 2>/dev/null
}

phase_lambda() {
	echo "== Lambda through the endpoint: both ports =="
	local r
	r=$(lambda_invoke '{}')
	echo "$r" | tee "$OUT/lambda-probe.json" | jq -r '
		"  host: \(.host)",
		(.results[] | "  port \(.port): ok=\(.ok) connect=\(.connect_ms // "-")ms query=\(.query_ms // "-")ms prepared=\(.prepared // "-") \(.error // "")")
	' 2>/dev/null || echo "  raw: $r"
}

phase_lambda_restart() {
	echo "== Restart window measured through the Lambda client (customer shape) =="
	echo "  triggering restart, then invoking Lambda on 6543 every ~5s"
	local log="$OUT/lambda-restart.csv"
	echo "ts,ok,connect_ms,error" > "$log"

	local code
	code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
		-H "Authorization: Bearer $TOK" \
		"https://api.supabase.com/v1/projects/$REF/restart" --max-time 30)
	echo "  restart API: HTTP $code"
	local t0=$SECONDS first_fail="" recovered=""

	while [ $((SECONDS - t0)) -lt 420 ]; do
		local r ok cms err
		r=$(lambda_invoke '{"port":6543}')
		ok=$(echo "$r" | jq -r '.all_ok // false' 2>/dev/null)
		cms=$(echo "$r" | jq -r '.results[0].connect_ms // ""' 2>/dev/null)
		err=$(echo "$r" | jq -r '.results[0].error // ""' 2>/dev/null | tr ',' ';')
		echo "$(date +%H:%M:%S),$ok,$cms,$err" >> "$log"
		echo "    $(date +%H:%M:%S) ok=$ok ${err:+err=$err}"
		if [ "$ok" = "false" ] && [ -z "$first_fail" ]; then first_fail=$SECONDS; fi
		if [ "$ok" = "true" ] && [ -n "$first_fail" ]; then recovered=$SECONDS; break; fi
		sleep 5
	done

	if [ -n "$first_fail" ] && [ -n "$recovered" ]; then
		echo "  Lambda-visible outage: $((recovered - first_fail))s (5s probe granularity)"
		echo "lambda_window_seconds=$((recovered - first_fail))" > "$OUT/lambda-restart-window.txt"
	else
		echo "  no Lambda-visible failure observed (restart may have completed between probes)"
		echo "lambda_window_seconds=0" > "$OUT/lambda-restart-window.txt"
	fi
}

phase_endpoint_replace() {
	echo "== Endpoint replacement as a DNS event =="
	local before after
	before=$(tofu output -json endpoint_ips | jq -r '.[]' | sort | tr '\n' ' ')
	echo "  ENI IPs before: $before"

	# Two-pass, for the same reason phase 2 is two-pass: replacing the endpoint
	# makes network_interface_ids unknown at plan time, so the ENI data source's
	# for_each fails. Pass 1 replaces the endpoint alone; pass 2 re-resolves the
	# ENI IPs and refreshes the PHZ record.
	echo "  pass 1: replace the endpoint (targeted)"
	tofu apply $VARS -replace='aws_vpc_endpoint.supabase[0]' -target='aws_vpc_endpoint.supabase[0]' -auto-approve >"$OUT/endpoint-replace-pass1.log" 2>&1
	local rc1=$?
	echo "  pass 1 exit: $rc1"
	echo "  pass 2: re-resolve ENIs + refresh the PHZ record"
	tofu apply $VARS -auto-approve >"$OUT/endpoint-replace-pass2.log" 2>&1
	local rc2=$?
	echo "  pass 2 exit: $rc2"

	if [ $rc1 -ne 0 ] || [ $rc2 -ne 0 ]; then
		echo "result: INCONCLUSIVE - replacement did not complete (see logs); no claim recorded" \
			| tee "$OUT/endpoint-replace-result.txt"
		grep -m2 -E 'Error' "$OUT"/endpoint-replace-pass*.log | sed 's/^/    /'
		return 1
	fi

	after=$(tofu output -json endpoint_ips | jq -r '.[]' | sort | tr '\n' ' ')
	echo "  ENI IPs after:  $after"
	{
		echo "before: $before"
		echo "after:  $after"
		echo "passes: replace=$rc1 refresh=$rc2 (two-pass required - single apply fails on ENI for_each)"
		if [ "$before" = "$after" ]; then
			echo "result: IPs UNCHANGED across a completed replacement"
		else
			echo "result: IPs CHANGED - the PHZ record had to be refreshed by the same apply"
		fi
	} | tee "$OUT/endpoint-replace-result.txt"
}

phase_ipv6() {
	echo "== dualstack endpoint attempt (the IPv6-VPC question) =="
	# The lab VPC is IPv4-only, so this asks two things at once: whether the
	# provider/API accepts dualstack on a Resource endpoint, and what the error
	# says if it does not. Both are recorded; neither is retried.
	local ep
	ep=$(tofu state show 'aws_vpc_endpoint.supabase[0]' 2>/dev/null | grep -E '^\s+id\s+=' | head -1 | cut -d'"' -f2)
	echo "  current endpoint: ${ep:-none}, ip_address_type=ipv4"
	aws ec2 modify-vpc-endpoint --region "$REGION" --vpc-endpoint-id "$ep" \
		--ip-address-type dualstack >"$OUT/ipv6-attempt.log" 2>&1
	local rc=$?
	echo "  modify to dualstack exit=$rc"
	head -3 "$OUT/ipv6-attempt.log" | sed 's/^/    /'
	if [ $rc -ne 0 ]; then
		echo "  -> recorded as: dualstack rejected on this endpoint/VPC shape"
	else
		echo "  -> dualstack accepted; reverting to ipv4"
		aws ec2 modify-vpc-endpoint --region "$REGION" --vpc-endpoint-id "$ep" \
			--ip-address-type ipv4 >>"$OUT/ipv6-attempt.log" 2>&1
	fi
}


phase_assoc_delete() {
	echo "== Association DELETE: what happens to live clients =="
	echo "  probing Lambda (6543) + RAM share state every 5s for 6 min."
	echo "  >>> Remove AWS account 350724347689 in the dashboard now. <<<"
	local log="$OUT/assoc-delete.csv"
	echo "ts,lambda_ok,share_status,error" > "$log"
	local first_fail="" t0=$SECONDS
	while [ $((SECONDS - t0)) -lt 360 ]; do
		local r ok err share
		r=$(lambda_invoke '{"port":6543}')
		ok=$(echo "$r" | jq -r '.all_ok // false' 2>/dev/null)
		err=$(echo "$r" | jq -r '.results[0].error // ""' 2>/dev/null | tr ',' ';')
		share=$(aws ram get-resource-shares --resource-owner OTHER-ACCOUNTS --region "$REGION" \
			--query "resourceShares[?contains(name, '$REF')].status | [0]" --output text 2>/dev/null)
		echo "$(date +%H:%M:%S),$ok,$share,$err" >> "$log"
		echo "    $(date +%H:%M:%S) lambda_ok=$ok share=$share ${err:+err=$err}"
		if [ "$ok" = "false" ] && [ -z "$first_fail" ]; then
			first_fail=$SECONDS
			echo "  -> clients started failing $((first_fail - t0))s into the probe"
		fi
		sleep 5
	done
	echo "  probe window ended; see $log"
}

case "${1:-all}" in
	lambda) phase_lambda;;
	lambda-restart) phase_lambda_restart;;
	endpoint-replace) phase_endpoint_replace;;
	ipv6) phase_ipv6;;
	assoc-delete) phase_assoc_delete;;
	all) phase_lambda; phase_ipv6; phase_endpoint_replace; phase_lambda_restart;;
	*) echo "unknown phase: $1"; exit 1;;
esac
echo "== artifacts in $OUT =="
