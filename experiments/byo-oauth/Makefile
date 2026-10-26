ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

# No OpenTofu state. O03 creates and deletes its own Pro-org project through
# POST /v1/projects. O01's lifecycle rows need the manual drill (RUNLOG.md).
#   SUPABASE_ACCESS_TOKEN   Management API token (never written to a file here)
#   PVLAB_ORG_PRO           slug of a Pro-plan organization (O03)
ONLY ?= O03

.PHONY: probe publish-evidence

probe:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$$PVLAB_ORG_PRO" || (echo "export PVLAB_ORG_PRO"; exit 1)
	@cd $(ROOT) && bun harness/scripts/gen-registry.ts >/dev/null
	@mkdir -p evidence/$(TS)
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment byo-oauth \
		--only $(ONLY) --destructive --out experiments/byo-oauth/evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# Redacted copy + facts table into out/<date>/ - what RUNLOG and docs cite.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
