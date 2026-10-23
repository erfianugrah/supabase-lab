ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

# Self-provisioning: AV01-AV03 share ONE Pro-org project created through
# POST /v1/projects (data-api-defaults/lib/project.ts), AV99 deletes it.
# No OpenTofu state. audit.sql is fetched at run time pinned by commit and
# checked by SHA-256 (lib/audit.ts); nothing of it is vendored here.
#   SUPABASE_ACCESS_TOKEN   Management API token (never written to a file here)
#   PVLAB_ORG_PRO           slug of a Pro-plan organization
#   PVLAB_ORG_SLUGS         same slug (gates the `org` capability)
# Include AV99 in ONLY or the project is left running; `make clean` lists
# leftovers by the pvlab-av- prefix, DELETE=1 deletes them.
ONLY ?= AV01,AV02,AV03,AV99
export PVLAB_DD_PREFIX := pvlab-av-

.PHONY: run clean unit publish-evidence

run:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$(PVLAB_ORG_PRO)" || (echo "export PVLAB_ORG_PRO (and PVLAB_ORG_SLUGS to the same slug)"; exit 1)
	@cd $(ROOT)/harness && bun run gen >/dev/null
	@mkdir -p evidence/$(TS)
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment advisor-coverage \
		--only $(ONLY) --destructive --out experiments/advisor-coverage/evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

unit:
	cd $(ROOT) && bun test experiments/advisor-coverage

# List (no --delete) or delete (DELETE=1) projects left behind by a run that died.
clean:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	cd $(ROOT)/experiments/data-api-defaults && bun lib/cleanup.ts $(if $(DELETE),--delete,)

# Redacted copy + facts table into out/<date>/ - what RUNLOG and docs cite.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
