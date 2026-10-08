# redundant-writes: three throwaway Postgres containers (PG 15, PG 17, and the
# supabase CLI's Postgres image), no managed project, no PAT, no tofu state -
# purely local, like checkpointer-reset. `make all` is the reproducible path:
# bring the rig up, run every module, publish the artifact, tear down.
#
# Knobs (env): RW_SIZES (default 10000,100000,1000000), RW_REPS (default 3),
# RW_TARGETS (default pg15,pg17,supabase). A smoke run:
#   make all RW_SIZES=1000 RW_REPS=1
ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
DATE := $(shell date +%Y-%m-%d)

LOCAL_ENV := .env
COMPOSE := docker compose --env-file $(LOCAL_ENV) -f compose.yml
ONLY ?= RW01,RW02,RW03,RW04,RW05,RW06

.PHONY: all local-up probe facts publish-evidence local-logs local-down

$(LOCAL_ENV):
	@echo "PVLAB_LOCAL_DB_PASSWORD=$$(openssl rand -hex 16)" > $(LOCAL_ENV)
	@echo "$(LOCAL_ENV) written (gitignored)"

local-up: $(LOCAL_ENV)
	$(COMPOSE) up -d --wait
	@echo "pg15: 127.0.0.1:45441  pg17: 127.0.0.1:45442  supabase: 127.0.0.1:45443"

# Destructive on the rig only: RW04 restarts and SIGKILLs the containers and
# drops the Docker VM's page cache for its cold-cache timings.
probe: $(LOCAL_ENV)
	@mkdir -p evidence/$(TS)
	@cd $(ROOT)/harness && bun scripts/gen-registry.ts >/dev/null
	@set -a; . ./$(LOCAL_ENV); set +a; \
	bun $(ROOT)/harness/src/run.ts --where local --experiment redundant-writes \
		--only $(ONLY) --destructive --out evidence/$(TS) | tee evidence/$(TS)/console.log
	@echo "== evidence/$(TS)/ =="

# Render the newest run's measurements as markdown (quote from this, do not retype).
facts:
	@bun $(ROOT)/harness/src/run.ts --facts $$(ls -t evidence/*/run-*.json | head -1)

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .)

all: local-up probe
	@$(MAKE) --no-print-directory publish-evidence RUN=$$(ls -t evidence/*/run-*.json | head -1)
	@$(MAKE) --no-print-directory local-down

local-logs:
	$(COMPOSE) logs --tail 80

local-down:
	-$(COMPOSE) down -v
	@rm -f $(LOCAL_ENV)
