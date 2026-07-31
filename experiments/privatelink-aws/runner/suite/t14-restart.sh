#!/bin/bash
# t14-restart.sh - measure the endpoint's downtime window during a project
# restart, ON the runner. Fully automated: starts a psql probe loop, triggers
# the restart via the Management API, waits for recovery, reports the window.
# Measures the failover/interruption window.
#
# Env: DB_PASSWORD (required), SUPABASE_ACCESS_TOKEN (required)
# Output: /home/ssm-user/suite-out/t14-restart.log + t14-window.txt
set -uo pipefail
. /etc/pvlab/env

OUT=/home/ssm-user/suite-out
mkdir -p "$OUT"
LOG="$OUT/t14-restart.log"
: > "$LOG"
export PGCONNECT_TIMEOUT=4 PGPASSWORD="${DB_PASSWORD:?DB_PASSWORD required}"
[ -n "${SUPABASE_ACCESS_TOKEN:-}" ] || { echo "SUPABASE_ACCESS_TOKEN required"; exit 1; }

probe() {
	psql "host=$PHZ_HOST port=5432 user=postgres dbname=postgres sslmode=require" \
		-c 'select 1;' >/dev/null 2>&1
}

echo "$(date +%H:%M:%S) baseline probe..."
if probe; then echo "$(date +%H:%M:%S) baseline UP" | tee -a "$LOG"; else echo "$(date +%H:%M:%S) baseline DOWN - aborting" | tee -a "$LOG"; exit 1; fi

echo "$(date +%H:%M:%S) triggering project restart via Management API"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
	-H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
	"https://api.supabase.com/v1/projects/$REF/restart" --max-time 30)
echo "$(date +%H:%M:%S) restart API call: HTTP $code" | tee -a "$LOG"

down_since=""
up_after=""
end=$((SECONDS + 600))
while [ $SECONDS -lt $end ]; do
	if probe; then
		if [ -n "$down_since" ]; then
			up_after=$(date +%H:%M:%S)
			echo "$up_after RECOVERED" | tee -a "$LOG"
			break
		fi
		echo "$(date +%H:%M:%S) up" >> "$LOG"
	else
		[ -z "$down_since" ] && { down_since=$(date +%H:%M:%S); echo "$down_since DOWN" | tee -a "$LOG"; }
		echo "$(date +%H:%M:%S) down" >> "$LOG"
	fi
	sleep 2
done

if [ -n "$down_since" ] && [ -n "$up_after" ]; then
	ds=$(date -d "$down_since" +%s); ua=$(date -d "$up_after" +%s)
	window=$((ua - ds))
	echo "window_seconds=$window" | tee "$OUT/t14-window.txt"
	echo "$(date +%H:%M:%S) T14 PASS - endpoint down window during restart: ${window}s ($down_since -> $up_after)"
else
	echo "$(date +%H:%M:%S) T14 INCONCLUSIVE - down_since=${down_since:-never} up_after=${up_after:-never} (restart may not have happened, HTTP $code)"
fi
