ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

# Self-provisioning: every module creates its own au-* project (and, for
# AU01/AU03, a Cloudflare Worker) and deletes both in `finally`. No OpenTofu
# state. Needs: SUPABASE_ACCESS_TOKEN, PVLAB_ORG_PRO (and PVLAB_ORG_FREE for
# AU01's Free-org quota row), wrangler logged in to the Cloudflare account that
# hosts workers.dev, docker with the images named in the module headers
# (mcr.microsoft.com/playwright for AU02, oven/bun for AU04), openssl.
ONLY ?= AU01,AU02,AU03,AU04

.PHONY: probe sweep publish-evidence

probe:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "SUPABASE_ACCESS_TOKEN not set"; exit 1)
	@test -n "$$PVLAB_ORG_PRO" || (echo "PVLAB_ORG_PRO not set"; exit 1)
	@cd $(ROOT) && bun harness/scripts/gen-registry.ts >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_ORG_SLUGS="$$PVLAB_ORG_PRO" AWS_REGION=ap-southeast-1 \
		bun $(ROOT)/harness/src/run.ts --where local --experiment auth-providers \
		--only $(ONLY) --destructive --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# Confirm nothing this experiment creates is left behind.
sweep:
	@curl -s -H "Authorization: Bearer $$SUPABASE_ACCESS_TOKEN" https://api.supabase.com/v1/projects \
		| jq -r '.[] | select(.name | startswith("au-")) | .name' ; echo "(empty above = clean)"
	@wrangler delete --help >/dev/null 2>&1 && echo "workers named au-iss-* must be removed in the Cloudflare dashboard or with: wrangler delete --name <name> --force"

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
