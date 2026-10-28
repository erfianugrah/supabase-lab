ROOT := $(abspath ../..)
include $(ROOT)/harness/pvlab.mk
TS := $(shell date +%Y%m%d-%H%M%S)
LABEL ?= a

# Self-provisioning, no OpenTofu state. One process = one fresh Pro-org Micro:
#   make run LABEL=a   CB01-CB05 on it, then CB99 deletes it (about 40 minutes)
# Run two at once (LABEL=a, LABEL=b) for n=2 on separate projects.
# Environment (never argv):
#   SUPABASE_ACCESS_TOKEN     Management API token
#   PVLAB_ORG_PRO             slug of a Pro-plan organization
# Leftovers by name prefix: `make clean` lists, `make clean DELETE=1` deletes.
IDS ?= CB01,CB02,CB03,CB04,CB05,CB99

.PHONY: run clean publish-evidence

run:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$$PVLAB_ORG_PRO" || (echo "export PVLAB_ORG_PRO"; exit 1)
	@$(HARNESS_BUILD)
	@mkdir -p evidence/$(TS)-$(LABEL)
	cd $(ROOT) && $(HARNESS_RUN) --where local --experiment cron-behaviour \
		--only $(IDS) --destructive --out experiments/cron-behaviour/evidence/$(TS)-$(LABEL)
	@echo "== evidence/$(TS)-$(LABEL)/ =="

clean:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	cd $(ROOT)/experiments/cron-behaviour && bun lib/cleanup.ts $(if $(DELETE),--delete,)

# Redacted copy + facts table into out/<date>/ - what RUNLOG and docs cite.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
