ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

# No OpenTofu state. L01 and L02 read the Management API and deliberately
# exhaust the PAT's rate budget (both --destructive for that reason; nothing on
# any project changes). Run from source: harness/dist/pvlab is linux-x64 only.
#   SUPABASE_ACCESS_TOKEN   Management API token (never written to a file here)
#   PVLAB_REF               any project the token can read, for the
#                           project-scoped rows (a throwaway is fine)
# Do not run anything else with the same token while this runs (~20 min for L02).
ONLY ?= L02

.PHONY: probe publish-evidence

probe:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$(PVLAB_REF)" || (echo "export PVLAB_REF=<a project ref the token can read>"; exit 1)
	@cd $(ROOT) && bun harness/scripts/gen-registry.ts >/dev/null
	@mkdir -p evidence/$(TS)
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment rate-limits \
		--only $(ONLY) --destructive --out experiments/rate-limits/evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# Redacted copy + facts table into out/<date>/ - what RUNLOG and docs cite.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
