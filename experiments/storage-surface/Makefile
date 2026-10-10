# storage-surface: self-provisioning, no OpenTofu state. Each module creates a
# throwaway Pro-org project named ss-<tag>-<epoch> and deletes it in
# `finally`. Needs SUPABASE_ACCESS_TOKEN and PVLAB_ORG_PRO in the environment.
#
#   make probe                 # SS01 + SS02, one run each
#   make probe MODS=SS02       # one module
#   make sweep                 # list ss- projects left behind
#   make aws-control           # optional: dot-segment and double-slash keys against Amazon S3 (needs AWS credentials)
#
# Runs from source (bun harness/src/run.ts): the AWS SDK v3 lives in canary/
# (own package.json), so it is not part of the compiled registry.
ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
MODS ?= SS01,SS02

.PHONY: probe sweep publish-evidence aws-control

probe:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "SUPABASE_ACCESS_TOKEN not set"; exit 1)
	@test -n "$$PVLAB_ORG_PRO" || (echo "PVLAB_ORG_PRO not set (slug of a Pro org)"; exit 1)
	@cd $(ROOT)/harness && bun scripts/gen-registry.ts >/dev/null
	@mkdir -p evidence/$(TS)
	@cd $(ROOT) && bun harness/src/run.ts --where local --experiment storage-surface \
		--only $(MODS) --destructive --out experiments/storage-surface/evidence/$(TS)
	@echo "== evidence/$(TS) =="

# Orphan check: any project left behind by a crashed run carries this prefix.
sweep:
	@curl -s -H "Authorization: Bearer $$SUPABASE_ACCESS_TOKEN" https://api.supabase.com/v1/projects \
		| jq -r '.[] | select(.name | startswith("ss-")) | .name'

# Redacted copy + facts into out/<date>/ (what the RUNLOG cites).
#   make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .)

aws-control:
	@cd canary && bun install >/dev/null && bun aws-control.ts ap-southeast-1
