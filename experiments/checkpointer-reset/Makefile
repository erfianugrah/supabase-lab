# checkpointer-reset: two throwaway Postgres 17 containers, no managed
# project, no PAT, no tofu state - purely local, like identity-transfer's
# `local-up` tier (experiments/identity-transfer/local/). Unlike that
# experiment this one has no managed-platform half at all, so the local rig
# lives at the experiment root rather than under a `local/` subdirectory.
#
# docker.exe is the only Docker CLI on PATH in this WSL distro (Docker
# Desktop on the Windows side, no native `docker` binary here) - every
# target below calls it explicitly.
ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

LOCAL_ENV := .env
COMPOSE := docker.exe compose --env-file $(LOCAL_ENV) -f compose.yml
ONLY ?= CR01

.PHONY: local-up local-probe local-logs local-down

# The rig's one secret (a throwaway Postgres password, shared by both
# containers) lives only in .env (gitignored) and dies with `make
# local-down`. Nothing here is a real credential.
$(LOCAL_ENV):
	@echo "PVLAB_LOCAL_DB_PASSWORD=$$(openssl rand -hex 16)" > $(LOCAL_ENV)
	@echo "$(LOCAL_ENV) written (gitignored)"

local-up: $(LOCAL_ENV)
	$(COMPOSE) up -d --wait
	@echo "supabase_db: 127.0.0.1:45432  vanilla_db: 127.0.0.1:45433"

local-probe: $(LOCAL_ENV)
	@mkdir -p evidence/$(TS)
	@set -a; . ./$(LOCAL_ENV); set +a; \
	bun $(ROOT)/harness/src/run.ts --where local --experiment checkpointer-reset \
		--only $(ONLY) --destructive --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

local-logs:
	$(COMPOSE) logs --tail 80 supabase_db vanilla_db

local-down:
	-$(COMPOSE) down -v
	@rm -f $(LOCAL_ENV)
