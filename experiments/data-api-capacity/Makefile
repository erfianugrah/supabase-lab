ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

# Self-provisioning: DC01-DC03 share ONE Pro-org project (Small, resized to
# Large by DC01c) created through POST /v1/projects; DC99 deletes it. No
# OpenTofu state. About 45 minutes end to end.
#   SUPABASE_ACCESS_TOKEN   Management API token (environment only)
#   PVLAB_ORG_PRO           slug of a Pro-plan organization
#   PVLAB_DC_PREFIX         project-name prefix (default pvlab-dc-)
# Include DC99 in ONLY or the project is left running; `make clean` lists
# leftovers by prefix and `make clean DELETE=1` removes them.
# Runs from source with bun: harness/dist/pvlab is a linux-x64 build.
ONLY ?= DC01,DC02,DC03,DC99

.PHONY: run clean publish-evidence

run:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$(PVLAB_ORG_PRO)" || (echo "export PVLAB_ORG_PRO"; exit 1)
	@cd $(ROOT)/harness && bun run gen >/dev/null
	@mkdir -p evidence/$(TS)
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment data-api-capacity \
		--only $(ONLY) --destructive --out experiments/data-api-capacity/evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

clean:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	cd $(ROOT)/experiments/data-api-capacity && bun lib/cleanup.ts $(if $(DELETE),--delete,)

# Redacted copy + facts table into out/<date>/ - what RUNLOG and docs cite.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
