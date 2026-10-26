# realtime-surface: self-provisioning modules (RT01-RT05). Each module creates a
# throwaway project on the Pro org, runs, and deletes it. No OpenTofu state.
#
#   make install                      # supabase-js at the old version RT04 receives on
#   make list
#   SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<slug> make run            # RT01-RT04 (RT05 is the long burst battery, about 70 min)
#   SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<slug> make run ONLY=RT03  # one module
#   ... make run ONLY=RT05 RT05_LEVELS=100,500 RT05_REPS=1             # a shorter burst battery
#
# Reuse a project while iterating (never deleted): PVLAB_PEER_RT=<ref>, with
# PVLAB_RT_DBPASS=<its db password> for the modules that open a pooler session.
# The registry is generated (the source-scan path does not stamp the experiment
# name that --experiment filters on).

ROOT := $(abspath ../..)
ONLY ?= RT01,RT02,RT03,RT04
export RT05_LEVELS RT05_REPS RT05_POOLS RT05_KINDS RT05_CONNECT_RATE RT05_SETTLE_MS RT05_COMPUTE RT05_BOUNDS RT05_BC_LEVELS
TS := $(shell date +%Y%m%d-%H%M%S)

.PHONY: install list run facts

install:
	bun install

list:
	cd $(ROOT) && bun harness/scripts/gen-registry.ts >/dev/null && bun harness/src/run.ts --experiment realtime-surface --where local --list

run:
	cd $(ROOT) && bun harness/scripts/gen-registry.ts >/dev/null && \
	bun harness/src/run.ts --experiment realtime-surface --where local --only $(ONLY) --destructive \
	  --out experiments/realtime-surface/evidence/$(TS)

.PHONY: publish-evidence

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)

# usage: make facts RUN=evidence/<ts>/run-<stamp>.json [ONLY=RT01]
facts:
	cd $(ROOT) && bun harness/src/run.ts --facts experiments/realtime-surface/$(RUN) --only $(ONLY)
