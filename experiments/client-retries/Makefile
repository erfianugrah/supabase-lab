# client-retries: self-provisioning, no OpenTofu state.
#
#   SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<pro-org-slug> make probe ONLY=CR01
#
# The harness binary (`dist/pvlab`) is a linux-x64 build, so this runs the
# runner from source. gen-registry only refreshes the (gitignored) static
# registry the runner prefers over a directory scan.
#
# CR04's long hang (5+ minutes per runtime) is opt-in: PVLAB_CR_LONG=1.
# PVLAB_CR_PREFIX renames the throwaway projects (default "cr-retries-").
ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
ONLY ?= CR01,CR02,CR03

.PHONY: probe unit publish-evidence

probe:
	@test -n "$(SUPABASE_ACCESS_TOKEN)" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@mkdir -p evidence/$(TS)
	cd $(ROOT) && bun harness/scripts/gen-registry.ts > /dev/null
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment client-retries \
	  --only $(ONLY) --destructive --out experiments/client-retries/evidence/$(TS) 2>&1 \
	  | tee $(CURDIR)/evidence/$(TS)/console.log

publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)

# The proxy's own tests (no network beyond loopback).
unit:
	cd $(ROOT) && bun test experiments/client-retries
