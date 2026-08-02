#!/bin/bash
# ceiling.sh - find the pooler client ceiling on this compute tier, ON the runner.
#
# METHOD NOTE (run 6 correction): the first version used `-c N -j N`, i.e. one
# pgbench thread per client, on a 2-vCPU t3.micro. A failure at high N was then
# indistinguishable from the client exhausting itself, and it silently agreed
# with the published figure - a confirmation trap. This version pins a small
# thread count, ramps past the expected limit, and captures the server's own
# error text so a refusal ("max clients reached" / "too many clients") is
# distinguishable from a local resource failure.
#
# Env: DB_PASSWORD (required)
# Output: /home/ssm-user/suite-out/{ceiling.csv,ceiling-raw-<N>.txt}
set -uo pipefail
. /etc/pvlab/env

OUT=/home/ssm-user/suite-out
mkdir -p "$OUT"
export PGCONNECT_TIMEOUT=10 PGPASSWORD="${DB_PASSWORD:?DB_PASSWORD required}"

THREADS=${THREADS:-8}
HOLD=${HOLD:-20}
echo "select pg_sleep($HOLD);" > /tmp/pvlab-hold.sql

echo "clients,threads,processed,failed,server_refusal,local_error" > "$OUT/ceiling.csv"
echo "== pooler ceiling probe: 6543, transaction mode, -j $THREADS (not -j N) =="
echo "   ulimit -n on runner: $(ulimit -n)"

for c in 150 190 200 210 250; do
	raw="$OUT/ceiling-raw-$c.txt"
	pgbench "host=$PHZ_HOST port=6543 user=postgres dbname=postgres sslmode=require" \
		-f /tmp/pvlab-hold.sql -c "$c" -j "$THREADS" -n -t 1 > "$raw" 2>&1
	rc=$?

	processed=$(grep -oE 'number of transactions actually processed: [0-9]+' "$raw" | grep -oE '[0-9]+$')
	failed=$(grep -oE 'number of failed transactions: [0-9]+' "$raw" | grep -oE '[0-9]+$')
	# server-side refusal: pgbouncer/postgres saying no
	refusal=$(grep -ciE 'max clients reached|too many clients|remaining connection slots|sorry, too many' "$raw")
	# client-side exhaustion: thread/fd/memory problems on the runner itself
	localerr=$(grep -ciE 'could not create thread|cannot allocate|too many open files|resource temporarily unavailable' "$raw")

	echo "  clients=$c rc=$rc processed=${processed:-0} failed=${failed:-0} server_refusal=$refusal local_error=$localerr"
	[ "$refusal" -gt 0 ] && grep -m1 -iE 'max clients reached|too many clients|remaining connection slots|sorry, too many' "$raw" | sed 's/^/      server said: /'
	[ "$localerr" -gt 0 ] && grep -m1 -iE 'could not create thread|cannot allocate|too many open files|resource temporarily unavailable' "$raw" | sed 's/^/      client said: /'
	echo "$c,$THREADS,${processed:-0},${failed:-0},$refusal,$localerr" >> "$OUT/ceiling.csv"
done

echo "== interpretation =="
echo "  A ceiling claim is only supportable where server_refusal>0 and local_error=0."
echo "  Rows with local_error>0 measure the runner, not the pooler."
echo "== ceiling done =="
