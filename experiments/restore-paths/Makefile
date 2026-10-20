# restore-paths: self-provisioning, no OpenTofu state. Each module creates a
# throwaway project named rp-* on the org it needs and deletes it in
# `finally`. Needs SUPABASE_ACCESS_TOKEN in the environment and the org slugs:
#   PVLAB_ORG_PRO   (RP01, RP02, RP05)
#   PVLAB_ORG_FREE  (RP03; Free orgs allow 2 active projects)
#   PVLAB_ORG_TEAM  (RP04; RP04_ORG_ROLE=pro runs it on the Pro org instead)
#
# Runs from source with bun: `harness/dist/pvlab` is built for linux-x64 and
# will not start on a Mac.
ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
OUT ?= evidence/$(TS)
PVLAB := cd $(ROOT) && bun harness/src/run.ts --tests experiments/restore-paths/tests --where local --experiment restore-paths --destructive

.PHONY: gen surface pitr pause daily rollback all

# The registry is generated and gitignored; regenerate after adding a module.
gen:
	cd $(ROOT)/harness && bun run gen

# RP01: Pro surface (pause, restore, clone, backups/restore, restore-pitr without PITR). Minutes, no add-on.
surface: gen
	$(PVLAB) --only RP01 --out experiments/restore-paths/$(OUT)

# RP02: PITR restore (pitr_7 on a Small project for roughly 30-60 minutes).
pitr: gen
	$(PVLAB) --only RP02 --out experiments/restore-paths/$(OUT)

# RP03: Free-plan pause/unpause, two cycles.
pause: gen
	$(PVLAB) --only RP03 --out experiments/restore-paths/$(OUT)

# RP04: daily-backup restore without PITR on a Team-org Micro project. ~4 minutes while backups/restore refuses, up to ~30 if it runs.
daily: gen
	$(PVLAB) --only RP04 --out experiments/restore-paths/$(OUT)

# RP05: what DELETE database/migrations?gte= does to schema, data and history. ~1-2 minutes with the preview branch.
rollback: gen
	$(PVLAB) --only RP05 --out experiments/restore-paths/$(OUT)

all: surface pitr pause daily rollback

.PHONY: publish-evidence

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
