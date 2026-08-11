#!/usr/bin/env bash
# Rebuild the entire demo from nothing: a fresh project to a working
# pggraph.erfi.dev. This is the artifact that makes the throwaway project safe to
# destroy - if this script does not reproduce the current state, destruction is
# not actually reversible.
#
# Every step here exists because it was once done BY HAND and would have broken a
# clean rebuild if left that way:
#
#   - pgrouting/postgis install was ad-hoc psql in a shell, not in any file.
#     demo/db/04-api.sql calls pgr_* directly, so without it the API layer fails
#     with "function does not exist" on a fresh project.
#   - PostgREST schema exposure was a curl PATCH to the Management API, never
#     scripted. Without it every demo RPC returns PGRST106 "Invalid schema: demo".
#   - demo/.env carries the project ref and anon key INLINE, so it must be
#     regenerated per project rather than committed - the ref changes on rebuild.
#   - wrangler deploy needs CLOUDFLARE_ACCOUNT_ID, which is not in the config.
#
# Usage:  make seed            # assumes the project is already applied+ready
#         make up              # apply + wait-ready + seed, one command
#
# Env: SUPABASE_ACCESS_TOKEN (PAT) and CLOUDFLARE_ACCOUNT_ID must be set.
set -euo pipefail

EXP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$EXP_DIR/../.." && pwd)"
cd "$EXP_DIR" || exit 1

REF="$(tofu output -raw project_ref 2>/dev/null)"
PW="$(grep -E '^db_password' "$ROOT/secrets.tfvars" 2>/dev/null | cut -d'"' -f2)"
TOK="${SUPABASE_ACCESS_TOKEN:-}"
CF_ACC="${CLOUDFLARE_ACCOUNT_ID:-}"

for v in REF PW TOK CF_ACC; do
  if [ -z "${!v}" ]; then echo "seed: $v is empty" >&2; exit 1; fi
done

API="https://api.supabase.com/v1"
auth=(-H "Authorization: Bearer $TOK")

pgurl() {
  local pooler
  pooler="$(curl -s "${auth[@]}" "$API/projects/$REF/config/database/pooler" \
    | jq -r '[.[]|select(.database_type=="PRIMARY")][0].db_host // empty')"
  # PGOPTIONS does not survive the transaction pooler, so timeouts cannot go
  # through it. Large TOAST writes belong on 5432, but this script runs over the
  # pooler for parity with the probes.
  echo "postgresql://postgres.$REF:${PW}@${pooler}:6543/postgres?connect_timeout=15"
}
PG="$(pgurl)"

# NOTE on the corpus shell DDL below: do NOT inline it. The first version of
# this script inlined a made-up shape (label/norm, bigint ids, source/target)
# that diverged from sql/corpus-*.sql - the schema contract the pvlab probes
# insert against - and G04/G05 failed on the rebuilt project while G07 skipped
# itself. Apply the sql/ files, so the seed and the probes share one source.
#
# Every phase MUST fail the script, not log and continue. The first version used
# `set -u` only, so each broken phase logged an error and the next phase ran
# against the missing output - and the script still printed "seed complete" with
# an empty database and a broken deploy. With `set -e` the t() helper's nonzero
# return aborts here, at the step that actually failed.
t() { local s=$1; shift; local t0; t0=$(date +%s); "$@" || { echo "    FAILED: $s" >&2; exit 1; }; echo "    [$(($(date +%s)-t0))s] $s"; }

echo "== 1/7 extensions =="
# pgrouting cascades postgis. Both, plus vector, land in `public` on install and
# are relocated to `extensions` afterwards - except postgis, whose extrelocatable
# is f, and vector, which stays put because corpus.chunks has columns of that
# type. pg_trgm relocates cleanly. 04-api.sql installs pg_trgm itself.
# pg_trgm must be created before it can be relocated, and 01-schema.sql owns its
# creation with `if not exists` - so do not alter it here, or a fresh project
# fails on a relocation of a not-yet-created extension. Relocate only what this
# script itself creates (pgrouting). postgis cascades and is extrelocatable=f.
t "extensions" psql "$PG" -qAt -v ON_ERROR_STOP=1 -c "
create extension if not exists vector;
create extension if not exists pgrouting cascade;
alter extension pgrouting set schema extensions;"

echo "== 2/7 corpus schema + seed =="
# The corpus tables are defined by the pvlab probes, not by demo/db. Creating the
# shell here keeps the demo self-contained: the seed restores into it, and
# G03/G05 would rebuild the rest if run.
# All five corpus tables, not just documents: the RLS step (05-security.sql)
# references entities/edges/chunks/chunks_halfvec, and the probes expect them.
# Minimal shells here; the probes rebuild the heavy synthetic content if run.
t "corpus schema" bash -c "psql '$PG' -qAt -v ON_ERROR_STOP=1 -f '$EXP_DIR/sql/corpus-documents.sql' && psql '$PG' -qAt -v ON_ERROR_STOP=1 -f '$EXP_DIR/sql/corpus-entities-edges.sql' && psql '$PG' -qAt -v ON_ERROR_STOP=1 -f '$EXP_DIR/sql/corpus-chunks.sql'"
t "seed restore" bash -c "zcat '$EXP_DIR/demo/seed/corpus-documents.sql.gz' | psql '$PG' -q -v ON_ERROR_STOP=1"

echo "== 3/7 demo schema =="
t "demo schema+extract fns" bash -c "psql '$PG' -qAt -v ON_ERROR_STOP=1 -f '$EXP_DIR/demo/db/01-schema.sql' && psql '$PG' -qAt -v ON_ERROR_STOP=1 -f '$EXP_DIR/demo/db/02-extract.sql' && psql '$PG' -qAt -v ON_ERROR_STOP=1 -f '$EXP_DIR/demo/db/03-extract-setbased.sql'"

echo "== 4/7 citation extraction (the slow step) =="
# Measured at 6m11s for the seven documents on medium compute.
t "extract+edges" psql "$PG" -qAt -v ON_ERROR_STOP=1 -c "
select demo.extract_document_fast(slug) from corpus.documents;
select demo.build_edges(400);
select demo.refresh_counters();"

echo "== 5/7 API layer + security =="
t "api" psql "$PG" -qAt -v ON_ERROR_STOP=1 -f "$EXP_DIR/demo/db/04-api.sql"
t "security (RLS etc.)" psql "$PG" -qAt -v ON_ERROR_STOP=1 -f "$EXP_DIR/db/05-security.sql"

echo "== 6/7 expose demo to PostgREST =="
t "postgrest schema" curl -s -X PATCH "$API/projects/$REF/postgrest" "${auth[@]}" \
  -H 'Content-Type: application/json' \
  -d '{"db_schema":"public, graphql_public, demo","db_extra_search_path":"public, extensions, demo"}'
# PostgREST caches its schema; force a reload or the new schema 404s for a while.
# A NOTIFY is advisory and async - it does not guarantee the schema cache has
# reloaded, and the first run through this returned PGRST202 "not found in the
# schema cache" for functions that existed. Poll the actual API until a known
# function answers, rather than assuming a sleep is enough.
t "schema cache reload" psql "$PG" -qAt -c "notify pgrst, 'reload schema'"
echo -n "    waiting for PostgREST to see demo.stats"
ANON_TMP="$(curl -s "${auth[@]}" "$API/projects/$REF/api-keys" | jq -r '.[]|select(.name=="anon")|.api_key')"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://$REF.supabase.co/rest/v1/rpc/stats" \
    -H "apikey: $ANON_TMP" -H 'Content-Type: application/json' -H 'Content-Profile: demo' -d '{}')
  if [ "$code" = "200" ]; then echo " ok"; break; fi
  echo -n "."; sleep 2
done

echo "== 7/7 build + deploy UI =="
# .env is generated, not committed: the project ref and anon key change on rebuild.
ANON="$(curl -s "${auth[@]}" "$API/projects/$REF/api-keys" | jq -r '.[]|select(.name=="anon")|.api_key')"
printf 'PUBLIC_SUPABASE_URL=https://%s.supabase.co\nPUBLIC_SUPABASE_ANON_KEY=%s\n' "$REF" "$ANON" > "$EXP_DIR/demo/.env"
t "bun install" bash -c "cd '$EXP_DIR/demo' && bun install >/dev/null 2>&1"
t "build" bash -c "cd '$EXP_DIR/demo' && bun run build >/dev/null"
t "wrangler deploy" bash -c "cd '$EXP_DIR/demo' && CLOUDFLARE_ACCOUNT_ID='$CF_ACC' wrangler deploy 2>&1 | grep -E 'Deployed|error' | head -3"

echo
echo "seed complete:"
psql "$PG" -qAt -c "select jsonb_pretty(demo.stats())" 2>/dev/null | head -20
echo "verify: curl -s -o /dev/null -w '%{http_code}\n' https://pggraph.erfi.dev/"
