ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
TS := $(shell date +%Y%m%d-%H%M%S)

# A project ref is 20 lowercase letters; lazy so `make down` then `make up`
# re-reads it per recipe line (the edge-resilience Makefile explains why).
REF = $(shell tofu output -raw project_ref 2>/dev/null | tr -d '\n' | grep -Eo '^[a-z]{20}$$' || true)

FILE_TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TOK := $(if $(SUPABASE_ACCESS_TOKEN),$(SUPABASE_ACCESS_TOKEN),$(FILE_TOK))
PW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
# The harness labels the artifact with AWS_REGION and falls back to
# ap-southeast-1 when unset; export the project's real region.
REGION := $(shell grep -E '^region' experiment.tfvars 2>/dev/null | cut -d'"' -f2)
ISSUER := $(shell cat .issuer-url 2>/dev/null)

ONLY ?= IT01
RUNNER_FLAGS ?= --destructive

.PHONY: init validate apply issuer-deploy issuer-delete probe publish-evidence destroy up down local-up local-probe local-logs local-down

up: init validate apply issuer-deploy
	@echo "lab up: project=$$(tofu output -raw project_ref) issuer=$(shell cat .issuer-url 2>/dev/null)"

down: issuer-delete destroy

init:
	tofu init

validate:
	@ls *.tf >/dev/null || (echo "no .tf files - tofu validate returns Success on an EMPTY dir"; exit 1)
	tofu validate

apply:
	tofu plan $(VARS) -var="supabase_access_token=$(TOK)" -out=tfplan
	tofu apply tfplan
	@echo "project_ref = $$(tofu output -raw project_ref)"

# The lab-controlled issuer. Its URL is what `external_keycloak_url` gets
# pointed at; wrangler prints it on deploy and it is kept in .issuer-url
# (gitignored) so `make probe` can export it as PVLAB_ENDPOINT_ISSUER.
issuer-deploy:
	@out=$$(wrangler deploy --config wrangler.jsonc 2>&1); echo "$$out" | tail -3; \
	url=$$(echo "$$out" | grep -oE 'https://identity-transfer-issuer\.[a-z0-9.-]+\.workers\.dev' | head -1); \
	test -n "$$url" || (echo "issuer URL not found in deploy output"; exit 1); \
	echo "$$url" > .issuer-url; echo "issuer URL = $$url"

issuer-delete:
	-wrangler delete --name identity-transfer-issuer --force 2>/dev/null || true
	@rm -f .issuer-url

probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT - export SUPABASE_ACCESS_TOKEN or run 'make secrets-decrypt' at the root"; exit 1)
	@test -n "$(ISSUER)" || (echo "no .issuer-url - run 'make issuer-deploy' first"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@pub=$$(curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/api-keys?reveal=true" \
		| jq -r '.[] | select(.type=="publishable") | .api_key' | head -1); \
	test -n "$$pub" || (echo "could not fetch the publishable key"; exit 1); \
	PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" SUPABASE_ANON_KEY="$$pub" DB_PASSWORD="$(PW)" \
		AWS_REGION="$(REGION)" PVLAB_ENDPOINT_ISSUER="$(ISSUER)" \
		$(ROOT)/harness/dist/pvlab --where local --experiment identity-transfer \
		--only $(ONLY) $(RUNNER_FLAGS) --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)

destroy:
	tofu plan -destroy $(VARS) -var="supabase_access_token=$(TOK)" -out=tfplan-destroy
	tofu apply tfplan-destroy

# ---------------------------------------------------------------------------
# Local rig (ITL1-ITL3). A throwaway GoTrue at a pinned version for the
# questions that are about the Auth server's own code rather than the managed
# platform's config surface - no PAT, no cloud, no credentials. See
# local/compose.yml. The managed modules (IT01-IT03) are unaffected.
# ---------------------------------------------------------------------------
LOCAL_ENV := local/.env
COMPOSE := docker compose --env-file $(LOCAL_ENV) -f local/compose.yml
LOCAL_ONLY ?= ITL1,ITL2,ITL3

# The rig's three secrets are generated per rig, live only in local/.env
# (gitignored) and die with `make local-down`. Nothing here is shared with a
# real project.
$(LOCAL_ENV):
	@mkdir -p local
	@{ \
	  echo "PVLAB_LOCAL_DB_PASSWORD=$$(openssl rand -hex 16)"; \
	  echo "PVLAB_LOCAL_JWT_SECRET=$$(openssl rand -hex 32)"; \
	  echo "PVLAB_LOCAL_HOOK_SECRET=v1,whsec_$$(openssl rand -base64 32)"; \
	} > $(LOCAL_ENV)
	@echo "$(LOCAL_ENV) written (gitignored)"

local-up: $(LOCAL_ENV)
	$(COMPOSE) up -d --wait
	@for i in $$(seq 1 40); do \
	  code=$$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9999/health || true); \
	  [ "$$code" = "200" ] && { echo "gotrue healthy: $$(curl -s http://127.0.0.1:9999/health)"; break; }; \
	  sleep 2; \
	done
	@curl -s -o /dev/null -w 'issuer discovery: HTTP %{http_code}\n' http://127.0.0.1:8080/.well-known/openid-configuration

local-probe: $(LOCAL_ENV)
	@mkdir -p evidence/$(TS)
	@set -a; . ./$(LOCAL_ENV); set +a; \
	PVLAB_ENDPOINT_LOCAL_AUTH=http://127.0.0.1:9999 \
	PVLAB_LOCAL_DB_PORT=5433 \
	bun $(ROOT)/harness/src/run.ts --where local --experiment identity-transfer \
		--only $(LOCAL_ONLY) --destructive --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

local-logs:
	$(COMPOSE) logs --tail 80 auth issuer

local-down:
	-$(COMPOSE) down -v
	@rm -f $(LOCAL_ENV)
