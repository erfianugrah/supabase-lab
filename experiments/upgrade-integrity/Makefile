ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

# Self-provisioning: UI01-UI06 share ONE Pro-org project created on Postgres 15
# (postgres_engine "15" on POST /v1/projects), Micro, ap-southeast-1, upgraded
# in place by UI03; UI99 deletes it. No OpenTofu state. About 30-40 minutes.
#   SUPABASE_ACCESS_TOKEN   Management API token (environment only)
#   PVLAB_ORG_PRO           slug of a Pro-plan organization
#   PVLAB_UI_WARMUP_S       cron warm-up before the baseline (default 180)
#   PVLAB_UI_SETTLE_S       wait after the upgrade before UI06 reads (default 180)
#   PVLAB_UI_KEEP=1         leave the project running (UI99 skips)
# Include UI99 in ONLY or the project is left running; `make clean` lists
# leftovers by prefix and `make clean DELETE=1` removes them.
# Runs from source with bun: harness/dist/pvlab is a linux-x64 build.
ONLY ?= UI01,UI02,UI03,UI04,UI05,UI06,UI99

.PHONY: run clean publish-evidence

run:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$(PVLAB_ORG_PRO)" || (echo "export PVLAB_ORG_PRO"; exit 1)
	@cd $(ROOT)/harness && bun run gen >/dev/null
	@mkdir -p evidence/$(TS)
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment upgrade-integrity \
		--only $(ONLY) --destructive --out experiments/upgrade-integrity/evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

clean:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	cd $(ROOT)/experiments/upgrade-integrity && bun lib/cleanup.ts $(if $(DELETE),--delete,)

# Redacted copy + facts table into out/<date>/ - what RUNLOG and docs cite.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
