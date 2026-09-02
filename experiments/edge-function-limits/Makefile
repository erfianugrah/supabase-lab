ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
REF := $(shell tofu output -raw project_ref 2>/dev/null)
TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
ORG := $(shell grep -E '^supabase_org_id' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS := $(shell date +%Y%m%d-%H%M%S)
# Read-only modules need no project: EF01 reads the published OpenAPI document,
# EF02 reads organization entitlements. Everything else deploys into the lab
# project and is destructive by construction.
READONLY := EF01,EF02
DESTRUCTIVE := EF03,EF04,EF05,EF06,EF07,EF08,EF09,EF10,EF11

.PHONY: init fmt validate apply probe probe-destructive unit destroy

init:
	tofu init

fmt:
	tofu fmt -recursive $(ROOT)

validate:
	tofu validate

apply:
	tofu plan $(VARS) -out=tfplan
	tofu apply tfplan
	@echo "project_ref = $$(tofu output -raw project_ref)"

# Pure logic under the modules (docs table, spec reader, triage classifier).
# No network, no credential.
unit:
	@cd $(ROOT) && bun test experiments/edge-function-limits

# EF01 + EF02 run without a project. PVLAB_ORG_SLUGS may carry several slugs
# (ideally one per plan) so the plan table gets one row per plan:
#   make probe ORGS=slug-free,slug-pro,slug-team
ORGS ?= $(ORG)
probe:
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" PVLAB_ORG_SLUGS="$(ORGS)" \
		$(ROOT)/harness/dist/pvlab --where local --experiment edge-function-limits \
		--only $(READONLY) --out evidence/$(TS)
	@echo "== evidence/$(TS) =="

# EF03-EF11 deploy functions and secrets into the lab project and delete them
# afterwards. ONLY=EF04 narrows the run. BUILD=0 RUNNER="bun $(ROOT)/harness/
# src/run.ts" runs from source without recompiling dist/pvlab (Linux refuses
# to overwrite a running executable while another battery uses it).
ONLY ?= $(DESTRUCTIVE)
RUNNER ?= $(ROOT)/harness/dist/pvlab
BUILD ?= 1
probe-destructive:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars"; exit 1)
	@if [ "$(BUILD)" = "1" ]; then cd $(ROOT)/harness && bun run build >/dev/null; else cd $(ROOT)/harness && bun run gen >/dev/null; fi
	@mkdir -p evidence/$(TS)
	@keys=$$(curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/api-keys"); \
	anon=$$(echo "$$keys" | jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" SUPABASE_ANON_KEY="$$anon" \
		PVLAB_ORG_SLUGS="$(ORGS)" \
		$(RUNNER) --where local --experiment edge-function-limits \
		--destructive --only $(ONLY) --out evidence/$(TS)
	@echo "== evidence/$(TS) =="

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy
