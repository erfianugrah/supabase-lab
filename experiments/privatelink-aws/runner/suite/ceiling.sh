#!/bin/bash
# ceiling.sh - probe the pooler client ceiling on this compute tier, ON the runner.
# Published limit for Micro: 200 pooler clients. Each client holds a backend
# via pg_sleep so the (N+1)th concurrent client should be REFUSED at accept.
# The number to cap serverless/Lambda concurrency against.
#
# Env: DB_PASSWORD (required)
# Output: /home/ssm-user/suite-out/ceiling.csv
set -uo pipefail
. /etc/pvlab/env

OUT=/home/ssm-user/suite-out
mkdir -p "$OUT"
export PGCONNECT_TIMEOUT=8 PGPASSWORD="${DB_PASSWORD:?DB_PASSWORD required}"

echo 'select pg_sleep(20);' > /tmp/pvlab-hold.sql
echo "tier_clients,established_note" > "$OUT/ceiling.csv"

echo "== pooler ceiling probe (6543, transaction mode) =="
for c in 100 150 180 200 220 250; do
	out=$(pgbench "host=$PHZ_HOST port=6543 user=postgres dbname=postgres sslmode=require" \
		-f /tmp/pvlab-hold.sql -c "$c" -j "$c" -n -t 1 2>&1)
	done_n=$(echo "$out" | grep -oE 'number of transactions actually processed: [0-9]+' | grep -oE '[0-9]+$')
	fail_n=$(echo "$out" | grep -c 'connection to server.*failed\|could not connect\|remaining connection slots\|no more connections\|server closed the connection\|connection reset\|terminating connection' || true)
	echo "  clients=$c actually_processed=${done_n:-?} connect_errors=$fail_n"
	echo "$c,processed=${done_n:-0} errors=$fail_n" >> "$OUT/ceiling.csv"
	# stop ramping once refusals appear
	[ "$fail_n" -gt 0 ] && break
done

echo "== ceiling done =="
