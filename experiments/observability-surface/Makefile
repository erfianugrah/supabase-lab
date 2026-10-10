ROOT := $(abspath ../..)
STAMP ?= $(shell date -u +%Y%m%d-%H%M%S)
IDS ?= OB01,OB05
OUT := $(CURDIR)/evidence/$(STAMP)

# Self-provisioning: every module creates its own `ob-surface-` projects on the
# Pro org (PVLAB_ORG_PRO) and deletes them in `finally`. No OpenTofu state.
# Environment (never written down in this repo):
#   SUPABASE_ACCESS_TOKEN   Management API PAT
#   PVLAB_ORG_PRO           slug of a Pro-plan organization
#   CLOUDFLARE_EMAIL / CLOUDFLARE_API_KEY / CLOUDFLARE_ACCOUNT_ID   OB04 only
#                           (the sink Worker; a zone-DNS-only API token is refused
#                           by the Workers endpoints)
# Inject them per command, e.g.
#   sx SUPABASE_ACCESS_TOKEN CLOUDFLARE_EMAIL CLOUDFLARE_API_KEY CLOUDFLARE_ACCOUNT_ID -- \
#     env PVLAB_ORG_PRO=<slug> make probe IDS=OB04

.PHONY: install gen probe probe-ob02 probe-ob03 list cleanup

install:
	cd apps && bun install

gen:
	cd $(ROOT) && bun harness/scripts/gen-registry.ts >/dev/null

# Any subset of OB01..OB05. OB02 runs eleven projects at once for ~35 min,
# OB03 one project for ~50 min (OB03_MINUTES shortens the canary).
probe: gen
	@mkdir -p $(OUT)
	cd $(ROOT) && OB_STAMP=$(STAMP) bun harness/src/run.ts \
	  --tests experiments/observability-surface/tests --where local \
	  --experiment observability-surface --only $(IDS) --destructive --out $(OUT)/$(IDS)

list: gen
	cd $(ROOT) && bun harness/src/run.ts --tests experiments/observability-surface/tests --where local --list | grep OB

# Safety net after a killed run: delete every project whose name starts with
# ob-surface- (a name filter, so unrelated projects are untouched) and list what
# is left.
cleanup:
	@curl -s https://api.supabase.com/v1/projects -H "Authorization: Bearer $$SUPABASE_ACCESS_TOKEN" \
	  | jq -r '.[] | select(.name | startswith("ob-surface-")) | .id' \
	  | while read r; do echo "deleting $$r"; \
	      curl -s -o /dev/null -w "%{http_code}\n" -X DELETE https://api.supabase.com/v1/projects/$$r -H "Authorization: Bearer $$SUPABASE_ACCESS_TOKEN"; done
	@curl -s https://api.supabase.com/v1/projects -H "Authorization: Bearer $$SUPABASE_ACCESS_TOKEN" \
	  | jq -r '[.[] | select(.name | startswith("ob-surface-"))] | length | "ob-surface- projects left: \(.)"'
