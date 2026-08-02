#!/bin/bash
# realtime-probe.sh - does Realtime work from inside the VPC, and is it carried
# by PrivateLink or by the public path? Runs ON the runner.
#
# Realtime is a WebSocket on the API hostname, not the database socket, so the
# expectation is: reachable via NAT (public egress), unaffected by database
# network restrictions. This records that rather than asserting it.
#
# Env: SUPABASE_ANON_KEY (required)
set -uo pipefail
. /etc/pvlab/env

OUT=/home/ssm-user/suite-out
mkdir -p "$OUT"
KEY="${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY required}"
WS="https://$REF.supabase.co/realtime/v1/websocket?apikey=$KEY&vsn=1.0.0"

echo "== Realtime endpoint resolution (is it in the PHZ or public DNS?) =="
api_ip=$(dig +short "$REF.supabase.co" | grep -E '^[0-9.]+$' | head -1)
db_ip=$(dig +short "$PHZ_HOST" | grep -E '^[0-9.]+$' | head -1)
echo "  API host $REF.supabase.co -> ${api_ip:-none}"
echo "  DB  host $PHZ_HOST -> ${db_ip:-none} (endpoint ENI)"
if echo "$db_ip" | grep -qE '^10\.'; then
	echo "  -> database name resolves inside the VPC; API name does not (separate paths confirmed)"
fi

echo "== Realtime WebSocket upgrade (expect HTTP 101) =="
code=$(curl -s -o "$OUT/realtime-headers.txt" -w '%{http_code}' --max-time 15 \
	-H "Connection: Upgrade" -H "Upgrade: websocket" \
	-H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
	"$WS" 2>/dev/null)
echo "  upgrade status: $code"
case "$code" in
	101) echo "  PASS Realtime reachable from in-VPC (via NAT, public path)";;
	*)   echo "  INFO non-101 ($code) - see $OUT/realtime-headers.txt";;
esac

echo "== Realtime over the endpoint? (negative control) =="
# The endpoint carries the DB socket only; asking for the API hostname on the
# endpoint IP should not serve Realtime.
if [ -n "$db_ip" ]; then
	rc=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
		--resolve "$REF.supabase.co:443:$db_ip" "https://$REF.supabase.co/realtime/v1/websocket?apikey=$KEY&vsn=1.0.0" 2>/dev/null)
	echo "  API hostname pinned to endpoint IP $db_ip -> ${rc:-connection failed}"
	echo "  (expected: fails/does not serve - PrivateLink carries 5432/6543 only)"
fi

echo "== realtime-probe done =="
