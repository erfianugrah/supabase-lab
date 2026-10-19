#!/usr/bin/env bash
# ZK06b/ZK07b against the project a KEEP=1 run of run-zk-managed.sh left up,
# then deletes it (unless KEEP=1 again). Creates two fresh Auth users.
#
#   SUPABASE_ACCESS_TOKEN=... ZK_REF=<project ref> CS_FED_CRN=crn:... ./run-zk-followup.sh
#
# For ZK07b the project must be registered as an OIDC provider in the
# CipherStash workspace (issuer https://<ref>.supabase.co/auth/v1); without it
# federation fails with "No OIDC provider found for issuer".
set -euo pipefail
: "${SUPABASE_ACCESS_TOKEN:?}" "${ZK_REF:?}" "${CS_FED_CRN:?}"
HERE=$(cd "$(dirname "$0")" && pwd)
OUTDIR=${OUTDIR:-$HERE/out/$(date +%F)-zk}
mkdir -p "$OUTDIR"
API=https://api.supabase.com/v1
BODY=$(mktemp); trap 'rm -f "$BODY"' EXIT
REF=$ZK_REF
KEYS=$(printf 'Authorization: Bearer %s\n' "$SUPABASE_ACCESS_TOKEN" | curl -s -H @- "$API/projects/$REF/api-keys?reveal=true")
ANON=$(jq -r '[.[] | select(.name == "anon")][0].api_key' <<<"$KEYS")
SERVICE=$(jq -r '[.[] | select(.name == "service_role")][0].api_key' <<<"$KEYS")
[[ $ANON == ey* && $SERVICE == ey* ]] || { echo "keys not found"; exit 1; }
mkuser() {
  export EMAIL=$1 UPASS=$2
  jq -n '{email: env.EMAIL, password: env.UPASS, email_confirm: true}' > "$BODY"
  printf 'Authorization: Bearer %s\napikey: %s\n' "$SERVICE" "$SERVICE" |
    curl -s -o /dev/null -w '%{http_code}' -H @- -H 'Content-Type: application/json' --data-binary @"$BODY" "https://$REF.supabase.co/auth/v1/admin/users"
}
UA_EMAIL="zkf-a-$(date +%s)@example.com"; UA_PASS="$(openssl rand -hex 12)Aa1!"
UB_EMAIL="zkf-b-$(date +%s)@example.com"; UB_PASS="$(openssl rand -hex 12)Aa1!"
echo "users: $(mkuser "$UA_EMAIL" "$UA_PASS") $(mkuser "$UB_EMAIL" "$UB_PASS")"
export UA_EMAIL UA_PASS UB_EMAIL UB_PASS
( cd "$HERE/zk" && DO_NOT_TRACK=1 SUPABASE_URL="https://$REF.supabase.co" SUPABASE_ANON_KEY="$ANON" REF="$REF" \
    OUT="$OUTDIR/zk-followup.json" timeout 600 bun followup.ts ) > "$OUTDIR/zk-followup.log" 2>&1 || echo "followup exit $?"
grep -rl "$REF" "$OUTDIR" 2>/dev/null | while read -r f; do sed -i '' "s/$REF/<ref>/g" "$f"; done
LAB=$(cd "$HERE/../.." && pwd)
grep -rl "$LAB/" "$OUTDIR" 2>/dev/null | while read -r f; do sed -i '' "s#$LAB/#<lab>/#g" "$f"; done
if [[ ${KEEP:-} != 1 ]]; then
  printf 'Authorization: Bearer %s\n' "$SUPABASE_ACCESS_TOKEN" |
    curl -s -o /dev/null -w "delete project: %{http_code}\n" -X DELETE -H @- "$API/projects/$REF"
fi
echo "== $OUTDIR =="
