#!/bin/bash
# bench-latency.sh - latency + throughput measurements, runs ON the runner.
# Latency and throughput per connection path - numbers, not doc claims.
#
# Env: DB_PASSWORD (required), SUPABASE_ANON_KEY (optional - 200s on PostgREST)
# Output: /home/ssm-user/suite-out/{connect-*.csv,pgbench-*.json,http-*.json}
set -uo pipefail
. /etc/pvlab/env

OUT=/home/ssm-user/suite-out
mkdir -p "$OUT"
# suite-out persists on the runner across runs - clear stale artifacts so the
# report never mixes runs
rm -f "$OUT"/connect-*.csv "$OUT"/pgbench-*.json "$OUT"/http-*.json "$OUT"/ceiling.csv
export PGCONNECT_TIMEOUT=8 PGPASSWORD="${DB_PASSWORD:?DB_PASSWORD required}"

N_CONNECT=${N_CONNECT:-30}
PGBENCH_SECS=${PGBENCH_SECS:-15}

# Public direct IP: the runner's resolver maps db.<ref>.supabase.co to the PHZ,
# so resolve the public address via an external resolver and pin hostaddr.
PUBLIC_DB_IP=$(dig +short @8.8.8.8 "db.$REF.supabase.co" | grep -E '^[0-9.]+$' | head -1)
echo "public db IP: $PUBLIC_DB_IP"

# path definitions: name|conninfo
# public-direct only exists if the public hostname has an A record - Supabase's
# direct endpoint is IPv6-only, so on an IPv4-only runner the path is a
# documented SKIP, not 30 fake failures.
paths() {
	cat <<EOF
private-5432|host=$PHZ_HOST port=5432 user=postgres dbname=postgres sslmode=require
private-6543|host=$PHZ_HOST port=6543 user=postgres dbname=postgres sslmode=require
public-supavisor-6543|host=$POOLER_HOST port=6543 user=postgres.$REF dbname=postgres sslmode=require
EOF
	if [ -n "$PUBLIC_DB_IP" ]; then
		echo "public-direct-5432|host=db.$REF.supabase.co hostaddr=$PUBLIC_DB_IP port=5432 user=postgres dbname=postgres sslmode=require"
	fi
}

PUBLIC_DIRECT_SKIP=""
if [ -z "$PUBLIC_DB_IP" ]; then
	PUBLIC_DIRECT_SKIP="public-direct-5432: SKIP - db.$REF.supabase.co has no public A record (IPv6-only direct endpoint; runner is IPv4-only)"
fi

percentiles() { # csv-file -> min p50 p95 p99 max fails
	awk -F, '{if($2==0){a[n++]=$1}else{f++}} END{
		if(n==0){print "0 0 0 0 0 " (f+0); exit}
		# insertion sort
		for(i=1;i<n;i++)for(j=i;j>0&&a[j-1]>a[j];j--){t=a[j];a[j]=a[j-1];a[j-1]=t}
		p50=a[int(n*0.50)]; p95=a[int(n*0.95)]; p99=a[int(n*0.99)]
		print a[0], p50, p95, p99, a[n-1], (f+0)
	}' "$1"
}

echo "== connect latency: $N_CONNECT cold psql connects per path =="
echo "path,min,p50,p95,p99,max,fails" > "$OUT/connect-summary.csv"
if [ -n "$PUBLIC_DIRECT_SKIP" ]; then
	echo "  $PUBLIC_DIRECT_SKIP"
	echo "public-direct-5432,-,-,-,-,-,skip-no-public-ipv4" >> "$OUT/connect-summary.csv"
fi
paths | while IFS='|' read -r name conn; do
	f="$OUT/connect-$name.csv"
	: > "$f"
	for i in $(seq 1 "$N_CONNECT"); do
		s=$(date +%s%N)
		psql "$conn" -c 'select 1;' >/dev/null 2>&1
		rc=$?
		e=$(date +%s%N)
		echo "$(( (e-s)/1000000 )),$rc" >> "$f"
	done
	read -r mn p50 p95 p99 mx fails <<< "$(percentiles "$f")"
	echo "$name,$mn,$p50,$p95,$p99,$mx,$fails" >> "$OUT/connect-summary.csv"
	echo "  $name: min=${mn}ms p50=${p50}ms p95=${p95}ms p99=${p99}ms max=${mx}ms fails=$fails"
done

echo "== pgbench select-only: ${PGBENCH_SECS}s, 4 clients, per path =="
echo 'select 1;' > /tmp/pvlab-bench.sql
paths | while IFS='|' read -r name conn; do
	# pgbench accepts a conninfo string in place of dbname
	out=$(pgbench "$conn" -f /tmp/pvlab-bench.sql \
		-c 4 -j 2 -T "$PGBENCH_SECS" 2>&1)
	tps=$(echo "$out" | grep -oE 'tps = [0-9.]+' | cut -d' ' -f3)
	lat=$(echo "$out" | grep -oE 'latency average = [0-9.]+' | cut -d' ' -f4)
	jq -n --arg path "$name" --arg tps "${tps:-0}" --arg lat_ms "${lat:-0}" \
		'{path:$path, tps:($tps|tonumber), avg_latency_ms:($lat_ms|tonumber)}' \
		> "$OUT/pgbench-$name.json"
	echo "  $name: tps=${tps:-FAIL} avg_latency=${lat:-n/a}ms"
done

echo "== gocurl: Data API (public HTTP by design) =="
# PostgREST root (/) requires service_role on the current platform (verified:
# anon gets 401 "Only the service_role API key can be used for this
# endpoint"). An anon probe needs a real table. pvlab_probe is created in
# public by postgres: default privileges grant anon SELECT, RLS stays off
# (SQL-created tables do not get RLS automatically).
DATAAPI_PATH="rest/v1/"
if psql "host=$PHZ_HOST port=5432 user=postgres dbname=postgres sslmode=require" -qAtc \
	'create table if not exists public.pvlab_probe(id int primary key); insert into public.pvlab_probe values (1) on conflict do nothing;' >/dev/null 2>&1; then
	DATAAPI_PATH="rest/v1/pvlab_probe?select=id"
fi
if command -v gocurl >/dev/null; then
	hdr=()
	if [ -n "${SUPABASE_ANON_KEY:-}" ]; then
		hdr=(-H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY")
	fi
	# cold single request: phase breakdown
	gocurl -o json "${hdr[@]}" "https://$REF.supabase.co/$DATAAPI_PATH" > "$OUT/http-dataapi-cold.json" 2>/dev/null
	# warm serial: server+RTT floor
	gocurl -o json -n 120 -c 1 --warmup 20 "${hdr[@]}" "https://$REF.supabase.co/$DATAAPI_PATH" \
		> "$OUT/http-dataapi-warm.json" 2>/dev/null
	jq -r '"  cold: dns=\(.dns_lookup)ms tcp=\(.tcp_connection)ms tls=\(.tls_handshake)ms ttfb=\(.server_processing)ms total=\(.total)ms status=\(.status_code)"' \
		"$OUT/http-dataapi-cold.json" 2>/dev/null || echo "  cold: (parse failed)"
	jq -r '"  warm: min=\(.min_latency)ms p50=\(.p50)ms p95=\(.p95)ms p99=\(.p99)ms rps=\(.requests_per_second)"' \
		"$OUT/http-dataapi-warm.json" 2>/dev/null || echo "  warm: (parse failed)"
else
	echo "  gocurl not installed - skipping HTTP probes"
fi

echo "== bench-latency done; artifacts in $OUT =="
