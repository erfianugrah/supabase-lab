# edge-runtime-auth: self-provisioning (each module creates and deletes its own
# Pro-org project via the Management API), so there is no OpenTofu state.
#
#   sx SUPABASE_ACCESS_TOKEN -- make probe PVLAB_ORG_PRO=<pro org slug>
#
# ER_PROJECT_PREFIX tags the throwaway projects by name (default "er-").
ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
ONLY ?= ER01,ER02
export ER_PROJECT_PREFIX ?= er-

.PHONY: unit probe publish-evidence

# Pure logic under the modules (expectation table, percentile). No network.
unit:
	@cd $(ROOT) && bun test experiments/edge-runtime-auth

# Needs SUPABASE_ACCESS_TOKEN and PVLAB_ORG_PRO in the environment, and Docker
# for the workerd leg of ER01. With CLOUDFLARE_WORKERS_TOKEN (Workers Scripts
# edit), CLOUDFLARE_ACCOUNT_ID and `wrangler` on PATH, ER01 also deploys the
# Worker to workers.dev and deletes it again. Modules are destructive by
# construction (they create and delete a project). Wall clock measured on
# 2026-10-10 with both running concurrently (workerd leg only): ER01 6m15s,
# ER02 13m10s. ER01 with the Cloudflare leg: see RUNLOG.md.
probe:
	@test -n "$(PVLAB_ORG_PRO)" || (echo "PVLAB_ORG_PRO required"; exit 1)
	@mkdir -p evidence/$(TS)
	@PVLAB_ORG_PRO="$(PVLAB_ORG_PRO)" bun $(ROOT)/harness/src/run.ts --where local \
		--tests $(CURDIR)/tests --experiment edge-runtime-auth \
		--only $(ONLY) --destructive --out evidence/$(TS)
	@echo "== evidence/$(TS) =="

# Redact and publish a run artifact to out/<date>/ (committed) with its facts.
# RUN=evidence/<ts>/run-<stamp>.json; ONLY narrows the ids.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(ONLY),--only $(ONLY),)
