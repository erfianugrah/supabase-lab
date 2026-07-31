#!/bin/bash
# render-report.sh <evidence-dir> - aggregate suite artifacts into REPORT.md.
# Pure jq/awk over the pulled artifacts; no runner access needed.
set -uo pipefail
EVID=${1:?usage: render-report.sh <evidence-dir>}
cd "$EVID"

REF=$(grep -hoE 'ref=[a-z0-9]+' evidence-*.log 2>/dev/null | head -1 | cut -d= -f2)
[ -z "$REF" ] && REF=$(ls suite-out 2>/dev/null >/dev/null && basename "$(pwd)")

{
echo "# PrivateLink lab evidence - $EVID"
echo
echo "Project ref: \`${REF:-unknown}\` | Region: ap-southeast-1 | Compute: micro | Runner: in-VPC t3.micro"
echo

echo "## Correctness matrix (run-matrix.sh)"
echo
echo '_Interactive run-matrix runs; TLS rows (T04-T06) here predate the CA extraction - the TLS section below is authoritative._'
echo
echo '| Test | Result | Detail |'
echo '|---|---|---|'
grep -hE '(PASS|FAIL|SKIP|INFO)' evidence-*.log 2>/dev/null \
	| awk '{printf "| %s | %s | %s |\n", $3, $2, substr($0, index($0, " - ")+3)}' | sort -u
echo

echo "## TLS through the endpoint (tls-tests.sh)"
echo
echo '```'
grep -E 'PASS|FAIL|subject=|DNS:' tls-tests.out 2>/dev/null | grep -v 'command\|status' || echo '(no TLS results)'
echo '```'
echo

echo "## Connect latency - cold psql connects (ms)"
echo
echo '| Path | min | p50 | p95 | p99 | max | fails |'
echo '|---|---|---|---|---|---|---|'
if [ -f suite-out/connect-summary.csv ]; then
	tail -n +2 suite-out/connect-summary.csv | awk -F, '{printf "| %s | %s | %s | %s | %s | %s | %s |\n", $1,$2,$3,$4,$5,$6,$7}'
fi
echo

echo "## pgbench select-only (4 clients)"
echo
echo '| Path | TPS | avg latency (ms) |'
echo '|---|---|---|'
for f in suite-out/pgbench-*.json; do
	[ -f "$f" ] && jq -r '"| \(.path) | \(.tps) | \(.avg_latency_ms) |"' "$f"
done
echo

echo "## Data API over public HTTP (gocurl, from in-VPC runner)"
echo
if [ -f suite-out/http-dataapi-cold.json ]; then
	echo "Cold request phase breakdown:"
	echo '```'
	jq -r '"dns=\(.dns_lookup)ms tcp=\(.tcp_connection)ms tls=\(.tls_handshake)ms ttfb=\(.server_processing)ms transfer=\(.content_transfer)ms total=\(.total)ms status=\(.status_code)"' suite-out/http-dataapi-cold.json
	echo '```'
fi
if [ -f suite-out/http-dataapi-warm.json ]; then
	echo "Warm serial (n=120, c=1):"
	echo '```'
	jq -r '"min=\(.min_latency)ms p50=\(.p50)ms p95=\(.p95)ms p99=\(.p99)ms rps=\(.requests_per_second)"' suite-out/http-dataapi-warm.json
	echo '```'
fi
echo

echo "## Pooler client ceiling (6543, transaction mode)"
echo
echo '| Concurrent clients | Result |'
echo '|---|---|'
if [ -f suite-out/ceiling.csv ]; then
	tail -n +2 suite-out/ceiling.csv | awk -F, '{printf "| %s | %s |\n", $1, $2}'
fi
echo

echo "## T14 - endpoint downtime during project restart"
echo
if [ -f suite-out/t14-window.txt ]; then
	w=$(cut -d= -f2 suite-out/t14-window.txt)
	echo "**Down window: ${w}s** (Management API-triggered restart, probed every 2s via psql over the endpoint)"
else
	echo '(inconclusive or not run - see t14-restart.out)'
fi
echo
grep -E 'DOWN|RECOVERED|HTTP' suite-out/t14-restart.log 2>/dev/null | head -5 | sed 's/^/> /'
} > REPORT.md

echo "REPORT.md rendered in $(pwd)"
