ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
TS := $(shell date +%Y%m%d-%H%M%S)

# A project ref is 20 lowercase letters (see platform-downtime Makefile for why
# the shape guard exists: tofu's "No outputs found" warning lands on stdout).
# Lazy (= not :=): after `make down`, parse-time evaluation would cache an
# empty ref for the whole `make up` run. Lazy re-reads per recipe line.
REF = $(shell tofu output -raw project_ref 2>/dev/null | tr -d '\n' | grep -Eo '^[a-z]{20}$$' || true)

FILE_TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TOK := $(if $(SUPABASE_ACCESS_TOKEN),$(SUPABASE_ACCESS_TOKEN),$(FILE_TOK))
PW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)

# MANDATORY. `--experiment` only LABELS the report; one registry carries every
# experiment's tests and planRun filters on where/capabilities/only/destructive.
# An unfiltered run pulls in other experiments' destructive modules.
ONLY ?= W01,W02,W03
RUNNER_FLAGS ?=

.PHONY: init validate apply keygen worker-deploy worker-outage worker-normal seed probe probe-destructive destroy up down battery

# Battery ids - every module in the experiment.
BATTERY := W01,W02,W03,W04,W05,W06,W07,W08,W09,W10,W11,W12,W13

# One-command lifecycle. `make down` tears everything down (worker + both
# projects); `make up` returns to an equivalent state: fresh projects, same
# persisted JWKS keypair (jwks/ survives locally), worker redeployed, probe
# table seeded. `make battery` is the unattended full run for CI/cron.
up: init validate apply keygen worker-deploy seed
	@echo "lab up: primary=$$(tofu output -raw project_ref) standby=$$(tofu output -raw standby_ref)"

down:
	-wrangler delete --name edge-resilience-drill 2>/dev/null || true
	tofu plan -destroy $(VARS) -var="supabase_access_token=$(TOK)" -out=tfplan-destroy
	tofu apply tfplan-destroy

battery: up
	$(ROOT)/.pi/probe-edge-resilience.sh $(BATTERY)

init:
	tofu init

validate:
	@ls *.tf >/dev/null || (echo "no .tf files - tofu validate returns Success on an EMPTY dir"; exit 1)
	tofu validate

apply:
	tofu plan $(VARS) -var="supabase_access_token=$(TOK)" -out=tfplan
	tofu apply tfplan
	@echo "project_ref = $$(tofu output -raw project_ref)"

# ES256 keypair for the lab-controlled JWT issuer. Public half lands in the
# worker's JWKS_JSON var; private half stays in jwks/private.json (gitignored).
keygen:
	@test -s jwks/private.json && echo "jwks/private.json exists - refusing to rotate" || bun scripts/keygen.ts

# Renders wrangler.jsonc (UPSTREAM is the tofu-created project) and deploys.
worker-deploy:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -s jwks/public.json || (echo "jwks/public.json missing - run 'make keygen' first"; exit 1)
	bun scripts/render-wrangler.ts "$(REF)"
	wrangler deploy --config wrangler.jsonc
	@echo "worker URL = $$(bun -e 'console.log(JSON.parse(require("fs").readFileSync("wrangler.jsonc","utf8")).vars.EDGE_URL)')"

# Outage simulation: redeploy the worker with OUTAGE=true so origin fetches go
# to an unroutable address and the cache has to serve stale.
worker-outage:
	wrangler deploy --config wrangler.jsonc --var "OUTAGE:true"
worker-normal:
	wrangler deploy --config wrangler.jsonc --var "OUTAGE:false"

# Probe table the JWT-skew module reads. Via the Management query endpoint so
# the PAT is the only credential needed.
seed:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	curl -sf -X POST -H "Authorization: Bearer $(TOK)" -H "Content-Type: application/json" \
		"https://api.supabase.com/v1/projects/$(REF)/database/query" \
		-d '{"query":"create table if not exists public.w_probe(id int primary key); insert into public.w_probe values (1) on conflict do nothing;"}'
	@echo " - w_probe seeded"

probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT - export SUPABASE_ACCESS_TOKEN or run 'make secrets-decrypt' at the root"; exit 1)
	@test -n "$(ONLY)" || (echo "refusing to run with an empty ONLY"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@pub=$$(curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/api-keys?reveal=true" \
		| jq -r '.[] | select(.type=="publishable") | .api_key' | head -1); \
	test -n "$$pub" || (echo "could not fetch the publishable key"; exit 1); \
	edge=$$(bun -e 'console.log(JSON.parse(require("fs").readFileSync("wrangler.jsonc","utf8")).vars.EDGE_URL)' 2>/dev/null || true); \
	PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" SUPABASE_ANON_KEY="$$pub" DB_PASSWORD="$(PW)" \
		PVLAB_ENDPOINT_EDGE_URL="$$edge" \
		PVLAB_ENDPOINT_JWKS_PRIV="$(CURDIR)/jwks/private.json" \
		$(ROOT)/harness/dist/pvlab --where local --experiment edge-resilience \
		--only $(ONLY) $(RUNNER_FLAGS) --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# W04 flips the edge worker's outage switch mid-run. Separate target so a bare
# `make probe` never mutates the worker by accident.
probe-destructive:
	@$(MAKE) probe RUNNER_FLAGS=--destructive ONLY=W04

destroy:
	tofu plan -destroy $(VARS) -var="supabase_access_token=$(TOK)" -out=tfplan-destroy
	tofu apply tfplan-destroy
