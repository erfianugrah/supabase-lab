# Self-provisioning: each module creates and deletes its own throwaway
# project via the Management API. No OpenTofu state.
#
#   make run   needs SUPABASE_ACCESS_TOKEN, PVLAB_ORG_FREE (FE01) and
#              PVLAB_ORG_PRO (FE02) in the environment; PVLAB_ORG_FREE2 is
#              the fallback when the first free org already holds 2 active
#              projects. Both modules are destructive (they create/delete).
ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
OUT := evidence/$(TS)

.PHONY: list run run-free publish-evidence

list:
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment free-email-templates --list

run:
	mkdir -p $(OUT)
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment free-email-templates \
		--only FE01,FE02 --destructive --out experiments/free-email-templates/$(OUT)

run-free:
	mkdir -p $(OUT)
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment free-email-templates \
		--only FE01 --destructive --out experiments/free-email-templates/$(OUT)

publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(ONLY),--only $(ONLY),)
