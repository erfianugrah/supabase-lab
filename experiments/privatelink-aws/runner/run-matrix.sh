#!/bin/bash
# run-matrix.sh - PrivateLink e2e test matrix, runs ON the in-VPC runner.
# Config from /etc/pvlab.env (written by user_data). Expects:
#   export SUPABASE_ACCESS_TOKEN=...   (operator, in the SSM session)
# Prompts for the DB password; nothing secret is written to disk.
# Evidence log: /home/ssm-user/evidence-<ts>.log
#
# Usage: run-matrix.sh            - full matrix
#        run-matrix.sh restart-watch - T14 only: psql loop during a restart
set -uo pipefail

. /etc/pvlab/env

LOG=/home/ssm-user/evidence-$(date +%Y%m%d-%H%M%S).log
CA=/etc/pvlab/ca.crt
export PGCONNECT_TIMEOUT=8

say()  { echo "$*" | tee -a "$LOG"; }
rec()  { echo "$(date +%H:%M:%S) $1 $2 - $3" | tee -a "$LOG"; }
pass() { rec PASS "$1" "$2"; }
fail() { rec FAIL "$1" "$2"; }
info() { rec INFO "$1" "$2"; }
skip() { rec SKIP "$1" "$2"; }

if [ -z "${DB_PASSWORD:-}" ]; then
	read -rs -p "DB password: " DB_PASSWORD
	echo
fi
export PGPASSWORD="$DB_PASSWORD"

CONN_BASE="user=postgres dbname=postgres"

t02() { # direct 5432 through the endpoint (via PHZ name)
	if psql "host=$PHZ_HOST port=5432 $CONN_BASE sslmode=require" -c 'select version();' >>"$LOG" 2>&1; then
		pass T02 "5432 direct through endpoint (PHZ host)"
	else
		fail T02 "5432 direct through endpoint (PHZ host)"
	fi
}

t03() { # pooler 6543 through the endpoint - proves the second SG rule
	if psql "host=$PHZ_HOST port=6543 $CONN_BASE sslmode=require" -c 'select 1;' >>"$LOG" 2>&1; then
		pass T03 "6543 pooler through endpoint (second SG rule works)"
	else
		fail T03 "6543 pooler through endpoint"
	fi
}

t04() { # verify-full against the endpoint's own DNS name - expect FAIL by design
	if [ -z "$ENDPOINT_DNS" ]; then skip T04 "no ENDPOINT_DNS (phase1?)"; return; fi
	if [ ! -f "$CA" ]; then skip T04 "no CA cert at $CA"; return; fi
	if psql "host=$ENDPOINT_DNS port=5432 $CONN_BASE sslmode=verify-full sslrootcert=$CA" -c 'select 1;' >>"$LOG" 2>&1; then
		fail T04 "verify-full against .vpce DNS name SUCCEEDED - expected hostname mismatch"
	else
		pass T04 "verify-full against .vpce DNS name fails by design (hostname mismatch)"
	fi
}

t05() { # verify-full via the PHZ name - expect PASS
	if [ ! -f "$CA" ]; then skip T05 "no CA cert at $CA"; return; fi
	if psql "host=$PHZ_HOST port=5432 $CONN_BASE sslmode=verify-full sslrootcert=$CA" -c 'select 1;' >>"$LOG" 2>&1; then
		pass T05 "verify-full via Route53 PHZ name"
	else
		fail T05 "verify-full via Route53 PHZ name"
	fi
}

t06() { # verify-ca fallback
	if [ ! -f "$CA" ]; then skip T06 "no CA cert at $CA"; return; fi
	if psql "host=$PHZ_HOST port=5432 $CONN_BASE sslmode=verify-ca sslrootcert=$CA" -c 'select 1;' >>"$LOG" 2>&1; then
		pass T06 "verify-ca with project CA cert"
	else
		fail T06 "verify-ca with project CA cert"
	fi
}

t07() { # Supavisor: public path only - works via NAT, which is exactly why it is out of the design
	dig +short "$POOLER_HOST" | tee -a "$LOG"
	if psql "host=$POOLER_HOST port=6543 user=postgres.$REF dbname=postgres sslmode=require" -c 'select 1;' >>"$LOG" 2>&1; then
		info T07 "Supavisor reachable via NAT (public traversal) - not a private path, out of design"
	else
		info T07 "Supavisor NOT reachable from runner - check NAT/egress"
	fi
}

migsetup() {
	rm -rf /tmp/migtest && mkdir -p /tmp/migtest/supabase/migrations
	cd /tmp/migtest || exit 1
	supabase init --yes >>"$LOG" 2>&1
	echo 'create table if not exists lab_probe(id int);' > supabase/migrations/20000101000000_lab_probe.sql
}

t08() { # default link + db push: works, but via PUBLIC Supavisor - records the default's path
	migsetup
	if supabase link --project-ref "$REF" -p "$DB_PASSWORD" --yes >>"$LOG" 2>&1 \
		&& supabase db push -p "$DB_PASSWORD" --yes >>"$LOG" 2>&1; then
		info T08 "default link + db push succeeded - but which path? (default link targets Supavisor = public)"
	else
		info T08 "default link + db push FAILED - unexpected; capture output"
	fi
}

t09() { # link --skip-pooler + db push: the PrivateLink-correct path (via PHZ)
	migsetup
	if supabase link --project-ref "$REF" -p "$DB_PASSWORD" --skip-pooler --yes >>"$LOG" 2>&1 \
		&& supabase db push -p "$DB_PASSWORD" --yes >>"$LOG" 2>&1; then
		pass T09 "link --skip-pooler + db push over the endpoint"
	else
		fail T09 "link --skip-pooler + db push over the endpoint"
	fi
}

t10() { # db push --db-url: no link, no Management API on the DB path
	migsetup
	if supabase db push --db-url "postgres://postgres:$DB_PASSWORD@$PHZ_HOST:5432/postgres" --yes >>"$LOG" 2>&1; then
		pass T10 "db push --db-url (no link)"
	else
		fail T10 "db push --db-url (no link)"
	fi
}

t11() { # prepared statements on transaction mode (6543) vs direct (5432)
	if psql "host=$PHZ_HOST port=6543 $CONN_BASE sslmode=require" \
		-c 'prepare q as select 1;' -c 'execute q;' >>"$LOG" 2>&1; then
		info T11 "PREPARE/EXECUTE on 6543 SUCCEEDED - unexpected under transaction mode"
	else
		pass T11 "PREPARE/EXECUTE fails on 6543 transaction mode (as documented)"
	fi
	if psql "host=$PHZ_HOST port=5432 $CONN_BASE sslmode=require" \
		-c 'prepare q as select 1;' -c 'execute q;' >>"$LOG" 2>&1; then
		pass T11 "PREPARE/EXECUTE works on 5432 direct"
	else
		fail T11 "PREPARE/EXECUTE on 5432 direct should work"
	fi
}

t12() { # run AFTER `make restrict`: endpoint path must keep working
	if psql "host=$PHZ_HOST port=5432 $CONN_BASE sslmode=require" -c 'select 1;' >>"$LOG" 2>&1; then
		pass T12 "endpoint path survives public-access closure"
	else
		fail T12 "endpoint path broke after restrictions applied"
	fi
	# and does the PUBLIC pooler path still get in? unknown - record either way
	if psql "host=$POOLER_HOST port=6543 user=postgres.$REF dbname=postgres sslmode=require" -c 'select 1;' >>"$LOG" 2>&1; then
		info T12b "Supavisor public path STILL CONNECTS with restrictions on - scope finding, verify against docs"
	else
		info T12b "Supavisor public path blocked by restrictions"
	fi
}

t13() { # Data API stays public regardless of restrictions
	code=$(curl -s -o /dev/null -w '%{http_code}' "https://$REF.supabase.co/rest/v1/" --max-time 10)
	info T13 "Data API over public internet from runner: HTTP $code (reachable = expected)"
}

restart_watch() { # T14: operator triggers a restart in the dashboard while this loops
	say "restart-watch: trigger the restart in the dashboard now; logging psql select 1 every 2s"
	down_since=""
	while true; do
		if psql "host=$PHZ_HOST port=5432 $CONN_BASE sslmode=require" -c 'select 1;' >>"$LOG" 2>&1; then
			if [ -n "$down_since" ]; then
				rec PASS T14 "recovered; down window started $down_since ended $(date +%H:%M:%S)"
				break
			fi
			echo "$(date +%H:%M:%S) up" >>"$LOG"
		else
			[ -z "$down_since" ] && down_since=$(date +%H:%M:%S)
			echo "$(date +%H:%M:%S) DOWN" | tee -a "$LOG"
		fi
		sleep 2
	done
}

case "${1:-full}" in
	restart-watch) restart_watch ;;
	full)
		say "== pvlab matrix $(date -Is) ref=$REF =="
		t02; t03; t04; t05; t06; t07; t08; t09; t10; t11; t13
		say "T12 needs 'make restrict' applied first - run: run-matrix.sh t12"
		say "T14 is interactive - run: run-matrix.sh restart-watch"
		say "== done; log: $LOG =="
		;;
	t12) t12 ;;
	*) echo "unknown: $1" >&2; exit 2 ;;
esac
