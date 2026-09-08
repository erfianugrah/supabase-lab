ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
TS := $(shell date +%Y%m%d-%H%M%S)

# A project ref is 20 lowercase letters; lazy so a destroy/apply cycle re-reads
# it per recipe line rather than caching an empty string at parse time.
REF = $(shell tofu output -raw $(REF_OUTPUT) 2>/dev/null | tr -d '\n' | grep -Eo '^[a-z]{20}$$' || true)

# ORG=team points the whole battery at the Team-plan project; anything else
# (the default) uses the Pro-plan one. One flag rather than two applies.
ORG ?= pro
REF_OUTPUT := $(if $(filter team,$(ORG)),team_project_ref,project_ref)

FILE_TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TOK := $(if $(SUPABASE_ACCESS_TOKEN),$(SUPABASE_ACCESS_TOKEN),$(FILE_TOK))
PW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
REGION := $(shell grep -E '^region' experiment.tfvars 2>/dev/null | cut -d'"' -f2)

ONLY ?= A00,A01,A02,A03,A04,A05,A06,A07,A08,A09,A10,A11,A12
RUNNER_FLAGS ?= --destructive

.PHONY: init validate apply probe publish-evidence destroy up down

up: init validate apply
	@echo "lab up: project=$$(tofu output -raw project_ref)"

down: destroy

init:
	tofu init

validate:
	@ls *.tf >/dev/null || (echo "no .tf files - tofu validate returns Success on an EMPTY dir"; exit 1)
	tofu validate

apply:
	tofu plan $(VARS) -var="supabase_access_token=$(TOK)" $(if $(PVLAB_ORG_TEAM),-var="team_org_id=$(PVLAB_ORG_TEAM)",) -out=tfplan
	tofu apply tfplan
	@echo "project_ref = $$(tofu output -raw project_ref)"

# Every module runs from this machine: the whole experiment is the Management
# API, the auth endpoints and the log stream. No runner, no VPC.
#
# PVLAB_ORG_PRO/TEAM/FREE gate A07 (entitlements per plan). They come from
# .pi/probe-audit-integrity.sh, which is gitignored - an org slug is an account
# identifier and the identifiers test scans tracked source for exactly that.
probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT - export SUPABASE_ACCESS_TOKEN or run 'make secrets-decrypt' at the root"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)-$(ORG)
	@keys=$$(curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/api-keys?reveal=true"); \
	anon=$$(echo "$$keys" | jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	test -n "$$anon" || (echo "could not fetch the anon key"; exit 1); \
	PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" SUPABASE_ANON_KEY="$$anon" \
		PVLAB_DB_PASSWORD="$(PW)" AWS_REGION="$(REGION)" \
		$(ROOT)/harness/dist/pvlab --where local --experiment audit-integrity \
		--only "$(ONLY)" $(RUNNER_FLAGS) --out evidence/$(TS)-$(ORG)
	@echo "== evidence/$(TS)-$(ORG)/ =="

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)

destroy:
	tofu plan -destroy $(VARS) -var="supabase_access_token=$(TOK)" $(if $(PVLAB_ORG_TEAM),-var="team_org_id=$(PVLAB_ORG_TEAM)",) -out=tfplan-destroy
	tofu apply tfplan-destroy
