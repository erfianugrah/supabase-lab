ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
REF  := $(shell tofu output -raw project_ref 2>/dev/null)
PW   := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS   := $(shell date +%Y%m%d-%H%M%S)

# PAT from the environment, never secrets.tfvars (see root AGENTS.md).
TOK := $(SUPABASE_ACCESS_TOKEN)
export TF_VAR_supabase_access_token = $(TOK)

.PHONY: init fmt validate apply wait-ready pooler pgurl test destroy up

init:
	tofu init

fmt:
	tofu fmt -recursive $(ROOT)

validate:
	tofu validate

apply: guard-tok
	tofu plan $(VARS) -out=tfplan
	tofu apply tfplan

guard-tok:
	@test -n "$(TOK)" || (echo "no SUPABASE_ACCESS_TOKEN in env"; exit 1)

wait-ready: guard-tok
	@test -n "$(REF)" || (echo "no project_ref - run 'make apply' first"; exit 1)
	@echo "waiting for db ACTIVE_HEALTHY..."
	@until $$($(MAKE) --no-print-directory health | grep -q ACTIVE_HEALTHY); do sleep 15; done; echo "healthy"
	@sleep 15

health:
	@curl -s -H "Authorization: Bearer $(TOK)" \
	  "https://api.supabase.com/v1/projects/$(REF)/health?services=db" \
	  | jq -r '.[0].status // empty'

pooler:
	@curl -s -H "Authorization: Bearer $(TOK)" \
	  "https://api.supabase.com/v1/projects/$(REF)/config/database/pooler" \
	  | jq -r '[.[] | select(.database_type=="PRIMARY")][0].db_host // empty'

# Session mode (5432), NOT transaction mode (6543): the test matrix relies on
# SET ROLE + request.jwt.claims, which are session-scoped GUCs and would not
# survive a Supavisor transaction-mode backend handoff.
pgurl:
	@echo "postgresql://postgres.$(REF):$(PW)@$$($(MAKE) --no-print-directory pooler):5432/postgres?connect_timeout=15"

test: guard-tok
	@mkdir -p evidence/$(TS)
	@PGCONNECT_TIMEOUT=15 PGSSLMODE=require psql "$$($(MAKE) --no-print-directory pgurl)" \
	  -v ON_ERROR_STOP=1 -f sql/rls-cost.sql -o evidence/$(TS)/rls-cost.out \
	  || (sleep 20; PGCONNECT_TIMEOUT=15 PGSSLMODE=require psql "$$($(MAKE) --no-print-directory pgurl)" \
	  -v ON_ERROR_STOP=1 -f sql/rls-cost.sql -o evidence/$(TS)/rls-cost.out)
	@tail -5 evidence/$(TS)/rls-cost.out; echo "full: evidence/$(TS)/rls-cost.out"

destroy:
	tofu plan $(VARS) -destroy -out=tfplan-destroy
	tofu apply tfplan-destroy

# Zero to a completed run in one command.
up: init apply wait-ready test
