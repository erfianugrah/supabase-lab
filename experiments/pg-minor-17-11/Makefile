# pg-minor-17-11: supabase/postgres 17.6 vs 17.11 and 15.14 vs 15.19 in local
# Docker. No managed project, no PAT, no OpenTofu state. Each module creates its
# own throwaway container pair (old image, then the new image on the same data
# directory) and removes it before returning. `make all` is the reproducible
# path: run every module, publish the artifact.
#
# Knobs (env): PGM_PAIRS (default 17,15), PGM_PORT (default 45461, loopback only).
# One pair only:  make probe PGM_PAIRS=17
ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
LOCAL_ENV := .env
ONLY ?= PG00,PG01,PG02,PG03,PG04,PG05

.PHONY: all probe facts publish-evidence clean

$(LOCAL_ENV):
	@echo "PVLAB_LOCAL_DB_PASSWORD=$$(openssl rand -hex 16)" > $(LOCAL_ENV)
	@echo "$(LOCAL_ENV) written (gitignored)"

probe: $(LOCAL_ENV)
	@mkdir -p evidence/$(TS)
	@cd $(ROOT)/harness && bun scripts/gen-registry.ts >/dev/null
	@set -a; . ./$(LOCAL_ENV); set +a; \
	bun $(ROOT)/harness/src/run.ts --where local --experiment pg-minor-17-11 \
		--only $(ONLY) --destructive --out evidence/$(TS) | tee evidence/$(TS)/console.log
	@echo "== evidence/$(TS)/ =="

# Render the newest run's measurements as markdown (quote from this, do not retype).
facts:
	@bun $(ROOT)/harness/src/run.ts --facts $$(ls -t evidence/*/run-*.json | head -1)

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .)

all: probe
	@$(MAKE) --no-print-directory publish-evidence RUN=$$(ls -t evidence/*/run-*.json | head -1)

# Modules clean up after themselves; this removes anything a killed run left.
clean:
	-docker rm -f -v pvlab-pgminor-srv pvlab-pgminor-data
	@rm -f $(LOCAL_ENV)
