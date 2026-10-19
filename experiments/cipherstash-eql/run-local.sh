#!/usr/bin/env bash
# Local rig for the EQL probes: supabase/postgres (the image's postgres role
# is not a superuser) + PostgREST v14.17 (the self-hosted compose pin until it
# moved to v14.18), EQL
# installed from its release SQL as `postgres`, then the vendor's own offline
# test and probe/supabase_probe.rs run from a cipherstash/stack checkout.
#
#   STACK_SRC=<path to cipherstash/stack checkout> ./run-local.sh
#
# Nothing here needs a CipherStash account: the ciphertext comes from
# FakeDataKeySource (keys in process memory). Leaves containers running for
# inspection; `./run-local.sh down` removes them.
set -euo pipefail

PG_IMAGE=${PG_IMAGE:-supabase/postgres:17.11.0.004}
PGRST_IMAGE=${PGRST_IMAGE:-postgrest/postgrest:v14.17}
EQL_VERSION=${EQL_VERSION:-eql-3.0.6}
NET=eql-probe-net
HERE=$(cd "$(dirname "$0")" && pwd)
OUTDIR=${OUTDIR:-$HERE/out/$(date +%F)}
PGPASS=probe
JWT_SECRET=$(openssl rand -hex 32)

if [[ ${1:-} == down ]]; then
  docker rm -f eql-probe eql-pgrst >/dev/null 2>&1 || true
  docker network rm $NET >/dev/null 2>&1 || true
  exit 0
fi
: "${STACK_SRC:?set STACK_SRC to a cipherstash/stack checkout}"
mkdir -p "$OUTDIR"

docker network inspect $NET >/dev/null 2>&1 || docker network create $NET >/dev/null
docker inspect eql-probe >/dev/null 2>&1 || docker run -d --name eql-probe --network $NET \
  -e POSTGRES_PASSWORD=$PGPASS -p 54329:5432 "$PG_IMAGE" >/dev/null
docker network connect $NET eql-probe 2>/dev/null || true
for _ in $(seq 1 60); do docker exec eql-probe pg_isready -h localhost -U postgres >/dev/null 2>&1 && break; sleep 2; done

export PGPASSWORD=$PGPASS
psql_pg() { psql -h localhost -p 54329 -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
psql -h localhost -p 54329 -U supabase_admin -d postgres -qc "ALTER ROLE authenticator PASSWORD '$PGPASS'"
# The bare image's auth.uid() reads only request.jwt.claim.sub, which PostgREST
# 14 no longer sets; GoTrue's migrations (managed, and the compose stack)
# replace it with this one, which also reads request.jwt.claims.
psql -h localhost -p 54329 -U supabase_admin -d postgres -qc "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$"

# Install EQL as postgres (non-superuser). Record the installer's notices.
sql="$OUTDIR/cipherstash-encrypt-$EQL_VERSION.sql"
[[ -s $sql ]] || curl -sfLo "$sql" "https://github.com/cipherstash/stack/releases/download/$EQL_VERSION/cipherstash-encrypt.sql"
installed=$(psql_pg -Atc "select eql_v3.version()" 2>/dev/null || true)
if [[ -z $installed ]]; then
  set +e
  psql_pg -q -f "$sql" > "$OUTDIR/install-raw.txt" 2>&1
  echo "psql_exit=$?" > "$OUTDIR/install-exit.txt"
  set -e
  grep -E 'EQL:|ERROR' "$OUTDIR/install-raw.txt" | sed -E 's#^psql:[^:]*/#psql:#' > "$OUTDIR/install-notices.txt" || true
  rm -f "$OUTDIR/install-raw.txt"
fi
{
  echo "eql_version=$(psql_pg -Atc 'select eql_v3.version()')"
  echo "install_role=$(psql_pg -Atc "select current_user || ' superuser=' || rolsuper from pg_roles where rolname = current_user")"
  echo "sql_sha256=$(shasum -a 256 "$sql" | cut -d' ' -f1)"
  echo "pg=$(psql_pg -Atc 'show server_version')"
  echo "pg_image=$PG_IMAGE"
  echo "eql_domain_count=$(psql_pg -Atc "select count(*) from pg_type where typnamespace = 'public'::regnamespace and typname like 'eql_v3_%' and typtype = 'd'")"
  echo "eql_domain_families=$(psql_pg -Atc "select string_agg(distinct regexp_replace(typname, '^eql_v3_([a-z0-9]+?)(_.*)?\$', '\\1'), ',') from pg_type where typnamespace = 'public'::regnamespace and typname like 'eql_v3_%' and typtype = 'd'")"
  echo "eql_schema_acl=$(psql_pg -Atc "select string_agg(nspname || ':' || coalesce(nspacl::text, 'null'), ' ' order by nspname) from pg_namespace where nspname in ('eql_v3', 'eql_v3_internal')")"
  echo "pgcrypto_schema=$(psql_pg -Atc "select extnamespace::regnamespace from pg_extension where extname = 'pgcrypto'")"
  cat "$OUTDIR/install-exit.txt" 2>/dev/null || true
} > "$OUTDIR/install.txt"
rm -f "$sql"

# The exposed schema has to exist before PostgREST starts, or it sits in reconnect backoff.
psql_pg -qc "CREATE SCHEMA IF NOT EXISTS app"
docker inspect eql-pgrst >/dev/null 2>&1 && docker rm -f eql-pgrst >/dev/null
docker run -d --name eql-pgrst --network $NET -p 54330:3000 \
  -e PGRST_DB_URI="postgres://authenticator:$PGPASS@eql-probe:5432/postgres" \
  -e PGRST_DB_SCHEMAS=app -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$JWT_SECRET" "$PGRST_IMAGE" >/dev/null
for _ in $(seq 1 30); do curl -sf localhost:54330/ >/dev/null 2>&1 && break; sleep 1; done
curl -sf localhost:54330/ >/dev/null || { echo 'PostgREST not ready'; docker logs eql-pgrst | tail -5; exit 1; }

mkjwt() {
  bun -e '
    const [secret, sub] = process.argv.slice(1);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const h = b64({ alg: "HS256", typ: "JWT" });
    const p = b64({ sub, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
    const s = require("crypto").createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
    console.log(`${h}.${p}.${s}`);' "$JWT_SECRET" "$1"
}
UID_A=$(uuidgen | tr A-Z a-z); UID_B=$(uuidgen | tr A-Z a-z)

T="$STACK_SRC/packages/eql/tests/encryption"
cp "$HERE/probe/supabase_probe.rs" "$T/tests/supabase_probe.rs"
export EQL_TEST_DATABASE_URL="postgres://postgres:$PGPASS@localhost:54329/postgres"
( cd "$T" && cargo test --release -q --test text_eq -- --include-ignored ) > "$OUTDIR/vendor-text_eq.txt" 2>&1
( cd "$T" && PGRST_URL=http://localhost:54330 UID_A=$UID_A UID_B=$UID_B \
    JWT_A=$(mkjwt "$UID_A") JWT_B=$(mkjwt "$UID_B") OUT="$OUTDIR/ce-local.json" \
    cargo test --release -q --test supabase_probe -- --include-ignored --nocapture ) > "$OUTDIR/ce-local.log" 2>&1
docker logs eql-pgrst > "$OUTDIR/pgrst.log" 2>&1
echo "stack_commit=$(basename "$STACK_SRC")" >> "$OUTDIR/install.txt"
echo "pgrst=$PGRST_IMAGE" >> "$OUTDIR/install.txt"
echo "== $OUTDIR =="
