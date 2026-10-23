ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

# Self-provisioning: PT01-PT06 share ONE Pro-org Micro project created
# through POST /v1/projects, PT99 deletes it. No OpenTofu state.
#   SUPABASE_ACCESS_TOKEN   Management API token (never written to a file here)
#   PVLAB_ORG_PRO           slug of a Pro-plan organization
#   PVLAB_PT_PREFIX         project-name prefix (default pvlab-pt-)
# Include PT99 in ONLY or the project is left running; `make clean` lists
# leftovers by prefix, `make clean DELETE=1` deletes them.
# Runs from source with bun: harness/dist/pvlab is a linux-x64 build.
ONLY ?= PT01,PT02,PT03,PT04,PT05,PT06,PT99

.PHONY: run clean publish-evidence

run:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$(PVLAB_ORG_PRO)" || (echo "export PVLAB_ORG_PRO"; exit 1)
	@cd $(ROOT)/harness && bun run gen >/dev/null
	@mkdir -p evidence/$(TS)
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment partitioned-tenancy \
		--only $(ONLY) --destructive --out experiments/partitioned-tenancy/evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

clean:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	cd $(ROOT)/experiments/partitioned-tenancy && bun lib/cleanup.ts $(if $(DELETE),--delete,)

# Redacted copy + facts table into out/<date>/ - what RUNLOG and docs cite.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
