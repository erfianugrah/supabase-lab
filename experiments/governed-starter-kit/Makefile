ROOT  := $(abspath ../..)
VARS  := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
# -json, not -raw: with no state, -raw prints its "No outputs found" warning to
# stdout, which would land in these variables instead of leaving them empty.
LIVE  := $(shell tofu output -json 2>/dev/null | jq -r '.live_ref.value // empty' 2>/dev/null)
READY := $(shell tofu output -json 2>/dev/null | jq -r '.ready_ref.value // empty' 2>/dev/null)
REGION := $(shell tofu output -json 2>/dev/null | jq -r '.region.value // empty' 2>/dev/null)
PW    := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS    := $(shell date +%Y%m%d-%H%M%S)

# PAT from the ENVIRONMENT, never secrets.tfvars - see pdf-corpus-graph/Makefile
# for why a placeholder in the var-file must not be quoted.
TOK := $(SUPABASE_ACCESS_TOKEN)
export TF_VAR_supabase_access_token = $(TOK)
export SUPABASE_ACCESS_TOKEN = $(TOK)

BASE := sql/00-baseline.sql
APP  := sql/10-app.sql sql/20-agent.sql

# Which project the web app points at. ready by default (seeded example app);
# APP_REF=$(LIVE) after a live build.
APP_REF ?= $(READY)

.PHONY: init fmt validate apply guard-tok wait-ready schema seed seed-ready pooler probe up destroy \
	app-env app-dev app-deploy app-delete

init:
	tofu init

fmt:
	tofu fmt -recursive $(ROOT)

validate:
	tofu validate

apply: guard-tok
	tofu plan $(VARS) -out=tfplan
	tofu apply tfplan
	@echo "live_ref  = $$(tofu output -raw live_ref)"
	@echo "ready_ref = $$(tofu output -raw ready_ref)"

guard-tok:
	@test -n "$(TOK)" || (echo "no SUPABASE_ACCESS_TOKEN in the environment - export a live PAT (the one in secrets.tfvars is a placeholder by design)"; exit 1)

# Per-service health, then a pause past the first-write window (AGENTS.md,
# "ACTIVE_HEALTHY is not readiness"). Both projects.
wait-ready: guard-tok
	@test -n "$(LIVE)" -a -n "$(READY)" || (echo "no refs - run 'make apply' first"; exit 1)
	@for ref in $(LIVE) $(READY); do \
		printf "waiting for $$ref"; \
		for i in $$(seq 1 60); do \
			s=$$(curl -s -H "Authorization: Bearer $(TOK)" \
				"https://api.supabase.com/v1/projects/$$ref/health?services=db&services=rest&services=auth" \
				| jq -r '[.[].status] | unique | join(",")' 2>/dev/null); \
			if [ "$$s" = "ACTIVE_HEALTHY" ]; then printf ' healthy\n'; break; fi; \
			printf '.'; sleep 10; \
			if [ $$i -eq 60 ]; then printf '\ntimed out\n'; exit 1; fi; \
		done; \
	done; sleep 20

# live: baseline only - the app schema is the coding agent's to write.
# ready: baseline + example app + agent schema.
schema: guard-tok
	bun scripts/kit.ts schema $(LIVE) $(BASE)
	bun scripts/kit.ts schema $(READY) $(BASE) $(APP)

seed: guard-tok
	bun scripts/kit.ts seed $(LIVE)
	$(MAKE) --no-print-directory seed-ready

seed-ready: guard-tok
	bun scripts/kit.ts seed $(READY) --app

# Array response, one entry per database - select the PRIMARY (see
# pdf-corpus-graph/Makefile).
pooler:
	@curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(READY)/config/database/pooler" \
		| jq -r '[.[] | select(.database_type=="PRIMARY")][0].db_host // empty'

# The RLS matrix runs against the ready project.
probe: guard-tok
	@test -n "$(READY)" || (echo "no ready_ref - run 'make apply' first"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(READY)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
	 DB_PASSWORD="$(PW)" PVLAB_REGION="$(REGION)" \
	 PVLAB_ENDPOINT_POOLER="$$($(MAKE) --no-print-directory pooler)" \
		$(ROOT)/harness/dist/pvlab --where local $(ONLY) \
		--experiment governed-starter-kit --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# --- web app (app/, Next.js on Workers via OpenNext) ---
app-env: guard-tok
	@test -n "$(APP_REF)" || (echo "no project ref - run 'make apply' first"; exit 1)
	bun scripts/kit.ts env $(APP_REF)

app-dev: app-env
	cd app && bun install && bun run dev

# Needs wrangler auth (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, or
# `wrangler login`). Deploys to workers.dev only - no custom domain to clean up.
app-deploy: app-env
	cd app && bun install && bun run deploy

app-delete:
	-cd app && wrangler delete starter-kit-app

# Zero to a seeded, tested pair of projects in one command. The app deploy is
# separate (make app-deploy) because it needs Cloudflare credentials.
up: guard-tok
	$(MAKE) init
	$(MAKE) apply
	$(MAKE) wait-ready
	$(MAKE) schema
	$(MAKE) seed
	$(MAKE) probe

destroy: guard-tok
	$(MAKE) --no-print-directory app-delete
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy
