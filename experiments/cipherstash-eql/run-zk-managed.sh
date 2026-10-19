#!/usr/bin/env bash
# ZK01-ZK07: CipherStash with real ZeroKMS keys (CLI device session in
# ~/.cipherstash, region ap-southeast-2) against one managed Pro-org micro
# project in ap-southeast-1, created here and deleted on exit unless KEEP=1.
#
#   SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<org slug> [CS_FED_CRN=crn:...] \
#     [KEEP=1] [PHASES=ZK01,ZK02,...] ./run-zk-managed.sh
#
# Needs: `stash auth login` done on this machine, IPv6 to the direct database
# host, bun. Secrets stay in the environment (curl -H @-, PGPASSWORD, jq env.*),
# never in argv; nothing written to out/ carries the project ref.
set -euo pipefail

: "${SUPABASE_ACCESS_TOKEN:?}" "${PVLAB_ORG_PRO:?}"
REGION=${REGION:-ap-southeast-1}
EQL_VERSION=${EQL_VERSION:-eql-3.0.6}
HERE=$(cd "$(dirname "$0")" && pwd)
OUTDIR=${OUTDIR:-$HERE/out/$(date +%F)-zk}
mkdir -p "$OUTDIR"
API=https://api.supabase.com/v1
BODY=$(mktemp)

mgmt() { # METHOD PATH (body from $BODY for POST/PATCH)
  local m=$1 p=$2
  if [[ $m == POST || $m == PATCH ]]; then
    printf 'Authorization: Bearer %s\n' "$SUPABASE_ACCESS_TOKEN" |
      curl -s -X "$m" -H @- -H 'Content-Type: application/json' --data-binary @"$BODY" "$API$p"
  else
    printf 'Authorization: Bearer %s\n' "$SUPABASE_ACCESS_TOKEN" | curl -s -X "$m" -H @- "$API$p"
  fi
}

DB_PASS="$(openssl rand -hex 16)Aa1!"; export DB_PASS
NAME="ce-zk-$(date +%s)"; export NAME REGION PVLAB_ORG_PRO
jq -n '{organization_slug: env.PVLAB_ORG_PRO, name: env.NAME, db_pass: env.DB_PASS, region: env.REGION}' > "$BODY"
REF=$(mgmt POST /projects | jq -r '.ref // .id // empty')
[[ -n $REF ]] || { echo "project create failed"; rm -f "$BODY"; exit 1; }
cleanup() {
  rm -f "$BODY"
  if [[ ${KEEP:-} == 1 ]]; then echo "KEEP=1: project left running ($NAME)"; return; fi
  printf 'Authorization: Bearer %s\n' "$SUPABASE_ACCESS_TOKEN" |
    curl -s -o /dev/null -w "delete project: %{http_code}\n" -X DELETE -H @- "$API/projects/$REF"
}
trap cleanup EXIT
echo "created $NAME"

# Readiness: per-service health, then the direct host's AAAA from a public
# resolver, then a connection by address (AGENTS.md "Provisioning").
t0=$(date +%s)
for _ in $(seq 1 120); do
  h=$(mgmt GET "/projects/$REF/health?services=auth&services=rest&services=db" | jq -r '[.[] | .status] | unique | join(",")' 2>/dev/null || true)
  [[ $h == ACTIVE_HEALTHY ]] && break; sleep 10
done
DBHOST="db.$REF.supabase.co"; ADDR=""
for _ in $(seq 1 60); do ADDR=$(dig +short AAAA "$DBHOST" @1.1.1.1 | tail -1); [[ -n $ADDR ]] && break; sleep 10; done
[[ -n $ADDR ]] || { echo "no AAAA for the direct host"; exit 1; }
export PGPASSWORD=$DB_PASS PGSSLMODE=require
psql_pg() { psql "host=$DBHOST hostaddr=$ADDR port=5432 user=postgres dbname=postgres" -v ON_ERROR_STOP=1 "$@"; }
for _ in $(seq 1 60); do psql_pg -Atc 'select 1' >/dev/null 2>&1 && break; sleep 5; done
psql_pg -Atc 'select 1' >/dev/null || { echo "direct connection failed"; exit 1; }
echo "ready after $(( $(date +%s) - t0 )) s"

# EQL from the release SQL, then the ZK schema and grants
sql="$OUTDIR/cipherstash-encrypt-$EQL_VERSION.sql"
[[ -s $sql ]] || curl -sfLo "$sql" "https://github.com/cipherstash/stack/releases/download/$EQL_VERSION/cipherstash-encrypt.sql"
set +e
psql_pg -q -f "$sql" > "$OUTDIR/install-raw.txt" 2>&1; echo "psql_exit=$?" > "$OUTDIR/install-exit.txt"
set -e
grep -E 'EQL:|ERROR' "$OUTDIR/install-raw.txt" | sed -E 's#^psql:[^:]*/#psql:#' > "$OUTDIR/install-notices.txt" || true
rm -f "$OUTDIR/install-raw.txt" "$sql"
psql_pg -q -f "$HERE/zk/schema.sql" > "$OUTDIR/schema.txt" 2>&1
{
  echo "target=managed $REGION, Pro org, micro"
  echo "eql_version=$(psql_pg -Atc 'select eql_v3.version()')"
  echo "pg=$(psql_pg -Atc 'show server_version')"
  cat "$OUTDIR/install-exit.txt"
  echo "stack=$(jq -r .version "$HERE/zk/node_modules/@cipherstash/stack/package.json")"
  echo "stack_supabase=$(jq -r .version "$HERE/zk/node_modules/@cipherstash/stack-supabase/package.json")"
  echo "protect_ffi=$(jq -r .version "$HERE/zk/node_modules/@cipherstash/protect-ffi/package.json")"
  echo "supabase_js=$(jq -r .version "$HERE/zk/node_modules/@supabase/supabase-js/package.json")"
  echo "zerokms_region=ap-southeast-2 (CLI device session)"
} > "$OUTDIR/install.txt"
sleep 3

# Keys and two Auth users (admin API, retried: the first Auth write on a fresh project can 500)
KEYS=$(mgmt GET "/projects/$REF/api-keys?reveal=true")
ANON=$(jq -r '[.[] | select(.name == "anon")][0].api_key' <<<"$KEYS")
SERVICE=$(jq -r '[.[] | select(.name == "service_role")][0].api_key' <<<"$KEYS")
[[ $ANON == ey* && $SERVICE == ey* ]] || { echo "legacy JWT keys not found"; exit 1; }
mkuser() { # email password
  export EMAIL=$1 UPASS=$2
  jq -n '{email: env.EMAIL, password: env.UPASS, email_confirm: true}' > "$BODY"
  for _ in 1 2 3 4 5 6; do
    code=$(printf 'Authorization: Bearer %s\napikey: %s\n' "$SERVICE" "$SERVICE" |
      curl -s -o /dev/null -w '%{http_code}' -H @- -H 'Content-Type: application/json' --data-binary @"$BODY" "https://$REF.supabase.co/auth/v1/admin/users")
    [[ $code == 200 || $code == 201 ]] && return 0; sleep 10
  done
  echo "user create failed ($code)"; return 1
}
UA_EMAIL="zk-a-$(date +%s)@example.com"; UA_PASS="$(openssl rand -hex 12)Aa1!"
UB_EMAIL="zk-b-$(date +%s)@example.com"; UB_PASS="$(openssl rand -hex 12)Aa1!"
mkuser "$UA_EMAIL" "$UA_PASS"; mkuser "$UB_EMAIL" "$UB_PASS"
export UA_EMAIL UA_PASS UB_EMAIL UB_PASS

# The probe: CipherStash traffic through its in-process CONNECT proxy, Supabase direct
PROXY_PORT=${PROXY_PORT:-18999}
# node-postgres reads PGSSLMODE=require as verify-full and has no Supabase CA:
# unset it for the probe and keep TLS without verification in the URL.
( cd "$HERE/zk" && unset PGSSLMODE && DO_NOT_TRACK=1 SUPABASE_URL="https://$REF.supabase.co" SUPABASE_ANON_KEY="$ANON" \
    DATABASE_URL="postgres://postgres:$(jq -rn 'env.DB_PASS | @uri')@[$ADDR]:5432/postgres?sslmode=no-verify" \
    REF="$REF" PROXY_PORT="$PROXY_PORT" HTTPS_PROXY="http://127.0.0.1:$PROXY_PORT" \
    NO_PROXY=".supabase.co,supabase.co,api.supabase.com,localhost,127.0.0.1" \
    OUT="$OUTDIR/zk-managed.json" timeout 1800 bun probe.ts ) > "$OUTDIR/zk-managed.log" 2>&1 || echo "probe exit $?"

# no project ref or local checkout path in anything written to out/
grep -rl "$REF" "$OUTDIR" 2>/dev/null | while read -r f; do sed -i '' "s/$REF/<ref>/g" "$f"; done
LAB=$(cd "$HERE/../.." && pwd)
grep -rl "$LAB/" "$OUTDIR" 2>/dev/null | while read -r f; do sed -i '' "s#$LAB/#<lab>/#g" "$f"; done
[[ ${KEEP:-} == 1 ]] && echo "ref for follow-up: $REF"
echo "== $OUTDIR =="
