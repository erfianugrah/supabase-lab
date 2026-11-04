ROOT := $(abspath ../..)
include $(ROOT)/harness/pvlab.mk
TS := $(shell date +%Y%m%d-%H%M%S)

# Self-provisioning, no OpenTofu state. One process = one fresh paid-org Micro
# in ap-northeast-1 (PVLAB_EB_REGION): EB01 creates it and deploys two
# functions, EB02/EB03 load one function each, EB99 deletes the project.
# About 30 minutes with the default steps (run 1).
#   make run          foreground
#   make run-bg       detached, log in evidence/run-<ts>.log
# Environment (never argv):
#   SUPABASE_ACCESS_TOKEN     Management API token
#   PVLAB_ORG_PRO             slug of a paid-plan organization (Team on 2026-11-04)
# Leftovers by name prefix: `make sweep` lists, `make sweep DELETE=1` deletes.
IDS ?= EB01,EB02,EB03,EB99
PREFIX ?= ef-burst-
export PVLAB_EB_PREFIX := $(PREFIX)
# Bun's fetch queues requests above 256 in flight (bun docs, "Simultaneous
# connection limit"); the generator's own cap (PVLAB_EB_CAP, 450) has to be
# the binding one or a queued request's send time is wrong.
BUN_CONFIG_MAX_HTTP_REQUESTS ?= 512
export BUN_CONFIG_MAX_HTTP_REQUESTS

.PHONY: test run run-bg sweep publish-evidence

test:
	@cd $(ROOT) && bun test experiments/edge-burst

run:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$$PVLAB_ORG_PRO" || (echo "export PVLAB_ORG_PRO"; exit 1)
	@$(HARNESS_BUILD)
	@mkdir -p evidence/$(TS)
	cd $(ROOT) && PVLAB_EB_RAW_DIR=$(abspath evidence/$(TS)) $(HARNESS_RUN) --where local --experiment edge-burst \
		--only $(IDS) --destructive --out experiments/edge-burst/evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

run-bg:
	@mkdir -p evidence
	@log=evidence/run-$(TS).log; \
	$(HARNESS_DETACH) nohup sh -c '$(MAKE) run IDS="$(IDS)"; echo "=== make exit $$? $$(date +%T)"' > $$log 2>&1 < /dev/null & \
	echo "running detached; log: $$log"

sweep:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@bun lib/sweep.ts $(if $(DELETE),--delete,)

# Redacted copy + facts table into out/<date>/ - what RUNLOG and docs cite.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
