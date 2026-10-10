# restore-paths: self-provisioning, no OpenTofu state. Each module creates a
# throwaway project named rp-* on the org it needs and deletes it in
# `finally`. Needs SUPABASE_ACCESS_TOKEN in the environment and the org slugs:
#   PVLAB_ORG_PRO   (RP01, RP02)
#   PVLAB_ORG_FREE  (RP03; Free orgs allow 2 active projects)
#
# Runs from source with bun: `harness/dist/pvlab` is built for linux-x64 and
# will not start on a Mac.
ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
OUT ?= evidence/$(TS)
RUN := cd $(ROOT) && bun harness/src/run.ts --tests experiments/restore-paths/tests --where local --experiment restore-paths --destructive

.PHONY: gen surface pitr pause all

# The registry is generated and gitignored; regenerate after adding a module.
gen:
	cd $(ROOT)/harness && bun run gen

# RP01: Pro surface (pause, restore, clone, backups/restore, restore-pitr without PITR). Minutes, no add-on.
surface: gen
	$(RUN) --only RP01 --out experiments/restore-paths/$(OUT)

# RP02: PITR restore (pitr_7 on a Small project for roughly 30-60 minutes).
pitr: gen
	$(RUN) --only RP02 --out experiments/restore-paths/$(OUT)

# RP03: Free-plan pause/unpause, two cycles.
pause: gen
	$(RUN) --only RP03 --out experiments/restore-paths/$(OUT)

all: surface pitr pause
