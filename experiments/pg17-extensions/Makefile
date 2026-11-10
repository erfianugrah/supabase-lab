ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

# Self-provisioning, no OpenTofu state. PX01 creates a Postgres 15 project
# (postgres_engine "15") and a Postgres 17 project at the default compute size, ap-southeast-1, in
# the org of role PVLAB_PX_ORG_ROLE (team), and deletes both in `finally`.
# 3 minutes on 2026-11-10.
#   SUPABASE_ACCESS_TOKEN   Management API token (environment only)
#   PVLAB_ORG_TEAM          slug of a Team-plan organization
#   PVLAB_PX_ROWS           rows per hypertable (default 300000)
#   PVLAB_PX_KEEP=1         leave both projects running
ONLY ?= PX01

.PHONY: run publish-evidence

run:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$(PVLAB_ORG_TEAM)" || (echo "export PVLAB_ORG_TEAM"; exit 1)
	@cd $(ROOT)/harness && bun run gen >/dev/null
	@mkdir -p evidence/$(TS)
	cd $(ROOT) && bun harness/src/run.ts --where local --tests experiments/pg17-extensions/tests \
		--experiment pg17-extensions --only $(ONLY) --destructive --out experiments/pg17-extensions/evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .)
