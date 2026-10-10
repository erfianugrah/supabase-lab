# orioledb: self-provisioning. The run creates one OrioleDB project, one heap
# control and three extra OrioleDB projects (feature battery, two conversion
# probes) through the Management API and deletes them in OR99 (and from a
# beforeExit / SIGINT hook). No OpenTofu state.
#
# Needs in the environment (nothing is written to disk by this Makefile):
#   SUPABASE_ACCESS_TOKEN  a PAT that can create projects in the org
#   PVLAB_ORG_PRO          slug of a Pro (or higher) organization
# Optional: PVLAB_ORG_TEAM, PVLAB_ORG_FREE (OR01c reads their entitlements),
# OR_NAME_PREFIX (project name prefix, default pvlab-orioledb), OR_REGION
# (default ap-southeast-1), OR_SIZE (default small), and the per-module knobs
# documented at the top of each tests/*.ts (OR_SIZES, OR_REPS, OR_PB_*, ...).
#
# Needs `pgbench` on PATH (OR05). Cost: five small-compute projects for the
# length of the run, plus the PITR add-on on two of them for a few minutes
# (OR09).
ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
ONLY ?= OR01,OR02,OR03,OR04,OR05,OR06,OR07,OR08,OR09,OR10,OR99

.PHONY: all probe facts publish-evidence

all: probe

# Destructive on the projects it creates only. OR08 wedges two of them on purpose.
probe:
	@mkdir -p evidence/$(TS)
	@cd $(ROOT)/harness && bun scripts/gen-registry.ts >/dev/null
	bun $(ROOT)/harness/src/run.ts --where local --experiment orioledb \
		--only $(ONLY) --destructive --out evidence/$(TS) | tee evidence/$(TS)/console.log
	@echo "== evidence/$(TS)/ =="

# Render the newest run's measurements as markdown (quote from this, do not retype).
facts:
	@bun $(ROOT)/harness/src/run.ts --facts $$(ls -t evidence/*/run-*.json | head -1)

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .)
