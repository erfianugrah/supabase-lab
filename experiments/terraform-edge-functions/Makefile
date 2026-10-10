ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
RUNNER ?= bun $(ROOT)/harness/src/run.ts

# Self-provisioning: TF01 creates one throwaway Pro-org project named
# tf-*, drives tofu against it, and deletes it. No tofu state of its own
# lives here; tf/ is the module the test copies to a scratch dir.
#
#   SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<pro-org-slug> make probe
#
# PVLAB_REF=<ref> reuses an existing project instead (kept, only lab-prefixed
# functions and secrets are removed).
.PHONY: gen probe unit lock

gen:
	@cd $(ROOT)/harness && bun run gen >/dev/null

probe: gen
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "SUPABASE_ACCESS_TOKEN not set"; exit 1)
	@mkdir -p evidence/$(TS)
	@$(RUNNER) --where local --experiment terraform-edge-functions \
		--only TF01 --destructive --out evidence/$(TS)
	@echo "== evidence/$(TS) =="

# Refresh the committed provider lock file for every platform the lab uses.
lock:
	@cd tf && tofu providers lock -platform=darwin_arm64 -platform=darwin_amd64 -platform=linux_amd64 -platform=linux_arm64

# Redact and publish a run artifact to out/<date>/ (committed) with its facts
# rendering. RUN=evidence/<ts>/run-<stamp>.json
.PHONY: publish-evidence
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .)
