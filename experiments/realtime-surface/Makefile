# realtime-surface: self-provisioning modules (RT01-RT04). Each module creates a
# throwaway project on the Pro org, runs, and deletes it. No OpenTofu state.
#
#   make install                      # supabase-js at the old version RT04 receives on
#   make list
#   SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<slug> make run            # all four
#   SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<slug> make run ONLY=RT03  # one module
#
# Reuse a project while iterating (never deleted): PVLAB_PEER_RT=<ref>, with
# PVLAB_RT_DBPASS=<its db password> for the modules that open a pooler session.
# The registry is generated (the source-scan path does not stamp the experiment
# name that --experiment filters on).

ROOT := $(abspath ../..)
ONLY ?= RT01,RT02,RT03,RT04
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

# usage: make facts RUN=evidence/<ts>/run-<stamp>.json [ONLY=RT01]
facts:
	cd $(ROOT) && bun harness/src/run.ts --facts experiments/realtime-surface/$(RUN) --only $(ONLY)
