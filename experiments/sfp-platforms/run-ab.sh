#!/usr/bin/env bash
# A/B the sfp-platforms battery across two orgs (platform vs control) and
# emit a side-by-side status diff. Artifacts land in evidence/<ts>/{platform,control}/
# so a run is committable.
#
# The two orgs may live under different accounts (and different control
# planes), so each arm takes its own token and optional overrides:
#   SUPABASE_ACCESS_TOKEN_PLATFORM / SUPABASE_ACCESS_TOKEN_CONTROL
#     (fall back to SUPABASE_ACCESS_TOKEN)
#   SUPABASE_MGMT_BASE_URL_PLATFORM / SUPABASE_MGMT_BASE_URL_CONTROL
#   SUPABASE_API_HOST_SUFFIX_PLATFORM / SUPABASE_API_HOST_SUFFIX_CONTROL
#     (unset -> harness defaults)
#
# Usage:
#   SUPABASE_ACCESS_TOKEN_PLATFORM=... SUPABASE_ACCESS_TOKEN_CONTROL=... \
#     ./run-ab.sh <platform-org-slug> <control-org-slug> [S01,S04,...]
set -euo pipefail
PLATFORM="${1:?platform org slug}"
CONTROL="${2:?control org slug}"
IDS="${3:-S01,S03,S04,S05,S06,S07,S08,S09,S10,S11,S12,S13,S14,S15}"
TOK_P="${SUPABASE_ACCESS_TOKEN_PLATFORM:-${SUPABASE_ACCESS_TOKEN:?no platform token}}"
TOK_C="${SUPABASE_ACCESS_TOKEN_CONTROL:-${SUPABASE_ACCESS_TOKEN:?no control token}}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$(cd "$(dirname "$0")" && pwd)/evidence/$TS"
mkdir -p "$OUT/platform" "$OUT/control"

(cd "$ROOT/harness" && bun run build >/dev/null)

run_arm() {
  local arm="$1" slug="$2" tok="$3" base="$4" suffix="$5"
  echo "== arm: $arm (org: $slug) =="
  # env(1) because an expanded NAME=value word is an argument, not an
  # assignment, when it comes out of ${var:+...}.
  env SUPABASE_ACCESS_TOKEN="$tok" PVLAB_ORG_SLUGS="$slug" \
    ${base:+SUPABASE_MGMT_BASE_URL="$base"} \
    ${suffix:+SUPABASE_API_HOST_SUFFIX="$suffix"} \
    "$ROOT/harness/dist/pvlab" --where local --experiment sfp-platforms \
    --only "$IDS" --destructive --out "$OUT/$arm" 2>&1 | tail -5
}

run_arm platform "$PLATFORM" "$TOK_P" \
  "${SUPABASE_MGMT_BASE_URL_PLATFORM:-}" "${SUPABASE_API_HOST_SUFFIX_PLATFORM:-}"
run_arm control "$CONTROL" "$TOK_C" \
  "${SUPABASE_MGMT_BASE_URL_CONTROL:-}" "${SUPABASE_API_HOST_SUFFIX_CONTROL:-}"

PA=$(ls -t "$OUT"/platform/run-*.json | head -1)
CA=$(ls -t "$OUT"/control/run-*.json | head -1)
echo "== diff (id / platform-status / control-status) =="
{
  echo -e "id\tplatform\tcontrol"
  jq -rs '
    (.[0].results | map({key: .id, value: .status}) | from_entries) as $p |
    (.[1].results | map({key: .id, value: .status}) | from_entries) as $c |
    ([($p | keys[]), ($c | keys[])] | unique[]) as $id |
    "\($id)\t\($p[$id] // "-")\t\($c[$id] // "-")"
  ' "$PA" "$CA"
} | tee "$OUT/AB-DIFF.tsv" | column -t
echo "artifacts: $PA / $CA"
