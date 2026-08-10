#!/usr/bin/env bash
# Run the experiment's suite against the LIVE throwaway project and drop the
# artifact somewhere the loop's sensors can read it.
#
# This file is deliberately OUTSIDE the loop's writeScope. It is the instrument
# the sensors measure with, and an agent that can edit its own instrument can
# satisfy every gate without doing the work. Same reasoning as keeping tests
# outside the fence in an ordinary loop; here the tests ARE the deliverable, so
# the fence moves to the runner instead.
#
# Artifacts go to /tmp, not to evidence/. evidence/ is inside the repo, so the
# scope guard would revert it every iteration and the sensors would read a
# stale or half-written file.
#
# Exits 0 whenever a run artifact was produced, INCLUDING when tests report
# `fail`. A measured fail is data in this repo, and a runner that refuses to
# finish on one would make the loop's cheapest path to green "delete the
# measurement". The per-test sensors and the `no-throw` guard are what
# discriminate; this script only proves the suite executed.
set -uo pipefail

EXP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$EXP_DIR/../.." && pwd)"
OUT="${PVLAB_OUT:-/tmp/pvlab-pdf-corpus-graph}"

cd "$EXP_DIR" || exit 1

REF="$(tofu output -raw project_ref 2>/dev/null)"
SIZE="$(tofu output -raw instance_size 2>/dev/null)"
REGION="$(tofu output -raw region 2>/dev/null)"
PW="$(grep -E '^db_password' "$ROOT/secrets.tfvars" 2>/dev/null | cut -d'"' -f2)"

if [ -z "$REF" ] || [ -z "$PW" ] || [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "live-suite: missing project ref, db password or PAT - is the project applied and the PAT exported?" >&2
  exit 1
fi

POOLER="$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$REF/config/database/pooler" \
  | jq -r '[.[] | select(.database_type=="PRIMARY")][0].db_host // empty')"

if [ -z "$POOLER" ]; then
  echo "live-suite: could not resolve pooler host for the project" >&2
  exit 1
fi

# Rebuild so the registry picks up any test file added this iteration. Without
# this the compiled binary carries the previous iteration's registry and a
# newly written test is invisible - which reads as "the agent did not write it".
( cd "$ROOT/harness" && bun run build ) >/dev/null 2>&1 || {
  echo "live-suite: harness build failed" >&2
  exit 1
}

rm -rf "$OUT"
mkdir -p "$OUT"

PVLAB_REF="$REF" \
DB_PASSWORD="$PW" \
PVLAB_ENDPOINT_POOLER="$POOLER" \
PVLAB_INSTANCE_SIZE="$SIZE" \
AWS_REGION="$REGION" \
  "$ROOT/harness/dist/pvlab" \
    --where local \
    --only "${PVLAB_ONLY:-G01,G02,G03,G04,G05,G06,G07}" \
    --experiment pdf-corpus-graph \
    --out "$OUT"

F="$(ls -t "$OUT"/run-*.json 2>/dev/null | head -1)"
if [ -z "$F" ]; then
  echo "live-suite: no run artifact produced" >&2
  exit 1
fi
echo "artifact: $F"
exit 0
