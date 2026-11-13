ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

# Self-provisioning: HG01 creates one hg-* Pro-org Micro project and deletes it
# in `finally`. No OpenTofu state. Needs SUPABASE_ACCESS_TOKEN and PVLAB_ORG_PRO.
ONLY ?= HG01

.PHONY: probe sweep publish-evidence

probe:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "SUPABASE_ACCESS_TOKEN not set"; exit 1)
	@test -n "$$PVLAB_ORG_PRO" || (echo "PVLAB_ORG_PRO not set"; exit 1)
	@cd $(ROOT) && bun harness/scripts/gen-registry.ts >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_ORG_SLUGS="$$PVLAB_ORG_PRO" AWS_REGION=ap-southeast-1 \
		bun $(ROOT)/harness/src/run.ts --where local --experiment hook-gated-signup \
		--only $(ONLY) --destructive --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# Confirm nothing this experiment creates is left behind.
sweep:
	@printf 'Authorization: Bearer %s\n' "$$SUPABASE_ACCESS_TOKEN" | curl -s -H @- https://api.supabase.com/v1/projects \
		| jq -r '.[] | select(.name | startswith("hg-")) | .name' ; echo "(empty above = clean)"

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
