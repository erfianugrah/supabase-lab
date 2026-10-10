ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

# Self-provisioning: every module creates its own parent project in the Pro org
# and deletes it (and its branch) in `finally`. No OpenTofu state.
#
#   SUPABASE_ACCESS_TOKEN   personal access token (inject per command, never print)
#   PVLAB_ORG_PRO           slug of a Pro-plan organization
#
# MANDATORY --only: one registry carries every experiment's tests, and a
# destructive run without it reaches other experiments' destructive modules.
ONLY ?= BN01,BN02,BN03

.PHONY: gen probe publish-evidence

# Registers all experiments' tests (writes harness/src/tests.generated.ts, gitignored).
gen:
	cd $(ROOT)/harness && bun run gen

probe: gen
	@test -n "$$PVLAB_ORG_PRO" || (echo "set PVLAB_ORG_PRO to a Pro org slug"; exit 1)
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "set SUPABASE_ACCESS_TOKEN (e.g. sx SUPABASE_ACCESS_TOKEN -- make probe)"; exit 1)
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment branching-nogit \
		--only $(ONLY) --destructive --out experiments/branching-nogit/evidence/$(TS)

# RUN=evidence/<ts>/run-<stamp>.json ; writes the redacted copy to out/<date>/
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	cd $(ROOT) && bun harness/scripts/publish-evidence.ts experiments/branching-nogit/$(RUN) experiments/branching-nogit
