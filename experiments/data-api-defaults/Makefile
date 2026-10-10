ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

# Self-provisioning: DD01-DD04 share ONE Pro-org project created through
# POST /v1/projects, DD99 deletes it. No OpenTofu state.
#   SUPABASE_ACCESS_TOKEN   Management API token (never written to a file here)
#   PVLAB_ORG_PRO           slug of a Pro-plan organization
#   PVLAB_ORG_SLUGS         same slug (gates the `org` capability)
#   PVLAB_DD_PREFIX         project-name prefix (default pvlab-dd-)
# Include DD99 in ONLY or the project is left running; `make clean` removes
# leftovers by prefix.
ONLY ?= DD01,DD02,DD03,DD04,DD99

.PHONY: run clean list publish-evidence

run:
	@test -n "$(SUPABASE_ACCESS_TOKEN)" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$(PVLAB_ORG_PRO)" || (echo "export PVLAB_ORG_PRO (and PVLAB_ORG_SLUGS to the same slug)"; exit 1)
	@cd $(ROOT)/harness && bun run gen >/dev/null
	@mkdir -p evidence/$(TS)
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment data-api-defaults \
		--only $(ONLY) --destructive --out experiments/data-api-defaults/evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# List (no --delete) or delete (DELETE=1) projects left behind by a run that died.
clean:
	@test -n "$(SUPABASE_ACCESS_TOKEN)" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	cd $(ROOT)/experiments/data-api-defaults && bun lib/cleanup.ts $(if $(DELETE),--delete,)

# Redacted copy + facts table into out/<date>/ - what RUNLOG and docs cite.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
