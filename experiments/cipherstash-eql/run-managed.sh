#!/usr/bin/env bash
# The same EQL checks against a managed Supabase project: creates one Pro-org
# micro project (ce-managed-<epoch>, ap-southeast-1), installs EQL from its
# release SQL as `postgres` over the direct (IPv6) connection, exposes schema
# `app` to the Data API, creates two Auth users, runs the vendor test and
# probe/supabase_probe.rs, and deletes the project on exit.
#
#   SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<org slug> \
#     STACK_SRC=<cipherstash/stack checkout> ./run-managed.sh
#
# Secrets stay in the environment (curl -H @-, PGPASSWORD, jq env.*), never
# in argv. Nothing written to out/ carries the project ref.
set -euo pipefail

: "${SUPABASE_ACCESS_TOKEN:?}" "${PVLAB_ORG_PRO:?}" "${STACK_SRC:?}"
REGION=${REGION:-ap-southeast-1}
EQL_VERSION=${EQL_VERSION:-eql-3.0.6}
HERE=$(cd "$(dirname "$0")" && pwd)
OUTDIR=${OUTDIR:-$HERE/out/$(date +%F)-managed}
mkdir -p "$OUTDIR"
API=https://api.supabase.com/v1

mgmt() { # METHOD PATH [json body on stdin when METHOD is POST/PATCH]
  local m=$1 p=$2
  if [[ $m == POST || $m == PATCH ]]; then
    printf 'Authorization: Bearer %s\n' "$SUPABASE_ACCESS_TOKEN" |
      curl -s -X "$m" -H @- -H 'Content-Type: application/json' --data-binary @"$BODY" "$API$p"
  else
    printf 'Authorization: Bearer %s\n' "$SUPABASE_ACCESS_TOKEN" | curl -s -X "$m" -H @- "$API$p"
  fi
}
BODY=$(mktemp); trap 'rm -f "$BODY"' EXIT

DB_PASS="$(openssl rand -hex 16)Aa1!"; export DB_PASS
NAME="ce-managed-$(date +%s)"; export NAME REGION PVLAB_ORG_PRO
jq -n '{organization_slug: env.PVLAB_ORG_PRO, name: env.NAME, db_pass: env.DB_PASS, region: env.REGION}' > "$BODY"
REF=$(mgmt POST /projects | jq -r '.ref // .id // empty')
[[ -n $REF ]] || { echo "project create failed"; exit 1; }
cleanup() {
  rm -f "$BODY"
  printf 'Authorization: Bearer %s\n' "$SUPABASE_ACCESS_TOKEN" |
    curl -s -o /dev/null -w "delete project: %{http_code}\n" -X DELETE -H @- "$API/projects/$REF"
}
trap cleanup EXIT
echo "created $NAME"

# The aggregate status is not readiness (AGENTS.md "Provisioning"): poll the
# per-service health, then the direct host's AAAA record through a public
# resolver (asking the local one early can cache the NXDOMAIN), and connect
# by address so the probe's "new connection" is a new backend, not a pooler slot.
t0=$(date +%s)
for _ in $(seq 1 120); do
  h=$(mgmt GET "/projects/$REF/health?services=auth&services=rest&services=db" | jq -r '[.[] | .status] | unique | join(",")' 2>/dev/null || true)
  [[ $h == ACTIVE_HEALTHY ]] && break; sleep 10
done
echo "health=$h after $(( $(date +%s) - t0 )) s"
DBHOST="db.$REF.supabase.co"; ADDR=""
for _ in $(seq 1 60); do
  ADDR=$(dig +short AAAA "$DBHOST" @1.1.1.1 | tail -1)
  [[ -n $ADDR ]] && break; sleep 10
done
[[ -n $ADDR ]] || { echo "no AAAA for the direct host after 10 min"; exit 1; }
echo "AAAA after $(( $(date +%s) - t0 )) s"
export PGPASSWORD=$DB_PASS PGSSLMODE=require
psql_pg() { psql "host=$DBHOST hostaddr=$ADDR port=5432 user=postgres dbname=postgres" -v ON_ERROR_STOP=1 "$@"; }
for _ in $(seq 1 60); do psql_pg -Atc 'select 1' >/dev/null 2>&1 && break; sleep 5; done
psql_pg -Atc 'select 1' >/dev/null || { echo "direct connection failed"; exit 1; }

# Install EQL as postgres.
sql="$OUTDIR/cipherstash-encrypt-$EQL_VERSION.sql"
[[ -s $sql ]] || curl -sfLo "$sql" "https://github.com/cipherstash/stack/releases/download/$EQL_VERSION/cipherstash-encrypt.sql"
set +e
psql_pg -q -f "$sql" > "$OUTDIR/install-raw.txt" 2>&1
echo "psql_exit=$?" > "$OUTDIR/install-exit.txt"
set -e
grep -E 'EQL:|ERROR' "$OUTDIR/install-raw.txt" | sed -E 's#^psql:[^:]*/#psql:#' > "$OUTDIR/install-notices.txt" || true
rm -f "$OUTDIR/install-raw.txt" "$sql"
{
  echo "target=managed $REGION, Pro org, micro"
  echo "eql_version=$(psql_pg -Atc 'select eql_v3.version()')"
  echo "install_role=$(psql_pg -Atc "select current_user || ' superuser=' || rolsuper from pg_roles where rolname = current_user")"
  echo "pg=$(psql_pg -Atc 'show server_version')"
  echo "pg_build=$(psql_pg -Atc 'select version()' | cut -d' ' -f1-2)"
  echo "eql_domain_count=$(psql_pg -Atc "select count(*) from pg_type where typnamespace = 'public'::regnamespace and typname like 'eql_v3_%' and typtype = 'd'")"
  echo "eql_schema_acl=$(psql_pg -Atc "select string_agg(nspname || ':' || coalesce(nspacl::text, 'null'), ' ' order by nspname) from pg_namespace where nspname in ('eql_v3', 'eql_v3_internal')")"
  echo "pgcrypto_schema=$(psql_pg -Atc "select extnamespace::regnamespace from pg_extension where extname = 'pgcrypto'")"
  echo "auth_uid_reads_claims=$(psql_pg -Atc "select pg_get_functiondef('auth.uid'::regproc) like '%request.jwt.claims%'")"
  cat "$OUTDIR/install-exit.txt"
} > "$OUTDIR/install.txt"

# Expose schema app to the Data API (it has to exist first).
psql_pg -qc "CREATE SCHEMA IF NOT EXISTS app"
jq -n '{db_schema: "public,graphql_public,app"}' > "$BODY"
mgmt PATCH "/projects/$REF/postgrest" | jq -c '{db_schema}' > "$OUTDIR/postgrest-config.json"

# Keys and two users.
KEYS=$(mgmt GET "/projects/$REF/api-keys?reveal=true")
ANON=$(jq -r '[.[] | select(.name == "anon")][0].api_key' <<<"$KEYS")
SERVICE=$(jq -r '[.[] | select(.name == "service_role")][0].api_key' <<<"$KEYS")
[[ $ANON == ey* && $SERVICE == ey* ]] || { echo "legacy JWT keys not found"; exit 1; }
export APIKEY=$ANON SERVICE
mkuser() { # email -> "uid token"
  export EMAIL=$1 UPASS; UPASS="$(openssl rand -hex 12)Aa1!"
  jq -n '{email: env.EMAIL, password: env.UPASS, email_confirm: true}' > "$BODY"
  # The first Auth write on a fresh project can 500 (AGENTS.md); retry.
  for _ in 1 2 3 4 5 6; do
    code=$(printf 'Authorization: Bearer %s\napikey: %s\n' "$SERVICE" "$SERVICE" |
      curl -s -o /dev/null -w '%{http_code}' -H @- -H 'Content-Type: application/json' --data-binary @"$BODY" "https://$REF.supabase.co/auth/v1/admin/users")
    [[ $code == 200 || $code == 201 ]] && break; sleep 10
  done
  jq -n '{email: env.EMAIL, password: env.UPASS}' > "$BODY"
  printf 'apikey: %s\n' "$ANON" |
    curl -s -H @- -H 'Content-Type: application/json' --data-binary @"$BODY" "https://$REF.supabase.co/auth/v1/token?grant_type=password" |
    jq -r '"\(.user.id) \(.access_token)"'
}
read -r UID_A JWT_A < <(mkuser "ce-a-$(date +%s)@example.com")
read -r UID_B JWT_B < <(mkuser "ce-b-$(date +%s)@example.com")
export UID_A UID_B JWT_A JWT_B
[[ -n $JWT_A && $JWT_A != null && -n $JWT_B && $JWT_B != null ]] || { echo "user tokens missing"; exit 1; }

T="$STACK_SRC/packages/eql/tests/encryption"
cp "$HERE/probe/supabase_probe.rs" "$T/tests/supabase_probe.rs"
export EQL_TEST_DATABASE_URL="postgres://postgres:$(jq -rn 'env.DB_PASS | @uri')@[$ADDR]:5432/postgres"
( cd "$T" && cargo test --release -q --test text_eq -- --include-ignored ) > "$OUTDIR/vendor-text_eq.txt" 2>&1 || true
( cd "$T" && PGRST_URL="https://$REF.supabase.co/rest/v1" OUT="$OUTDIR/ce-managed.json" \
    cargo test --release -q --test supabase_probe -- --include-ignored --nocapture ) > "$OUTDIR/ce-managed.log" 2>&1 || true
echo "stack_commit=$(basename "$STACK_SRC")" >> "$OUTDIR/install.txt"
# Belt and braces: no project ref in anything written to out/.
if grep -rl "$REF" "$OUTDIR" >/dev/null 2>&1; then
  grep -rl "$REF" "$OUTDIR" | while read -r f; do sed -i '' "s/$REF/<ref>/g" "$f"; done
fi
echo "== $OUTDIR =="
