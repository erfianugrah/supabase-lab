# compute-disk: self-provisioning (no OpenTofu state). Each module creates and
# deletes its own project through the Management API. Added 2026-11-04 with
# D13 (the older modules run through the local probe script; see RUNLOG.md).
#
#   PVLAB_ORG_PRO=<org slug> SUPABASE_ACCESS_TOKEN=<pat> make probe ONLY=D13
#   PVLAB_ORG_PRO=<org slug> SUPABASE_ACCESS_TOKEN=<pat> make probe-bg ONLY=D13
#   PVLAB_D13_ORG_ROLE=team PVLAB_ORG_TEAM=<org slug> ... make probe-bg   (Team org)
#
# D13 runs about five hours (it waits out the disk cooldown); probe-bg detaches
# it with a log. `make sweep` deletes projects left by a run that died.
ROOT := $(abspath ../..)
include $(ROOT)/harness/pvlab.mk
TS := $(shell date +%Y%m%d-%H%M%S)
ONLY ?= D13
# Prefix of the project names D13 creates; `sweep` deletes by it.
PREFIX ?= d13-iops-

.PHONY: test probe probe-bg sweep publish-evidence

test:
	@cd $(ROOT) && bun test experiments/compute-disk

probe:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$(PVLAB_ORG_PRO)$(PVLAB_ORG_TEAM)" || (echo "export PVLAB_ORG_PRO (or PVLAB_ORG_TEAM with PVLAB_D13_ORG_ROLE=team)"; exit 1)
	@$(HARNESS_BUILD)
	@mkdir -p evidence/$(TS)
	@PVLAB_D13_PREFIX="$(PREFIX)" $(HARNESS_RUN) --where local --experiment compute-disk \
		--only $(ONLY) --destructive --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

probe-bg:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$(PVLAB_ORG_PRO)$(PVLAB_ORG_TEAM)" || (echo "export PVLAB_ORG_PRO (or PVLAB_ORG_TEAM with PVLAB_D13_ORG_ROLE=team)"; exit 1)
	@$(HARNESS_BUILD)
	@mkdir -p evidence/$(TS)
	@$(HARNESS_DETACH) nohup sh -c 'PVLAB_D13_PREFIX="$(PREFIX)" $(HARNESS_RUN) --where local --experiment compute-disk --only $(ONLY) --destructive --out evidence/$(TS)' > evidence/$(TS)/run.log 2>&1 < /dev/null &
	@echo "== detached; log: evidence/$(TS)/run.log =="

# Delete any project left behind by a run that died before its teardown.
sweep:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@printf 'Authorization: Bearer %s\n' "$$SUPABASE_ACCESS_TOKEN" | curl -s -H @- https://api.supabase.com/v1/projects \
		| jq -r '.[] | select(.name | startswith("$(PREFIX)")) | .id' \
		| while read -r ref; do echo "deleting $$ref"; printf 'Authorization: Bearer %s\n' "$$SUPABASE_ACCESS_TOKEN" | curl -s -o /dev/null -w "%{http_code}\n" -X DELETE -H @- https://api.supabase.com/v1/projects/$$ref; done

publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(ONLY),--only $(ONLY),)
