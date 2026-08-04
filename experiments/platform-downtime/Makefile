ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
TS := $(shell date +%Y%m%d-%H%M%S)

# A project ref is 20 lowercase letters. Filtering on that SHAPE is what makes
# the `test -n` guard below actually fire: with no state, `tofu output -raw`
# prints its "No outputs found" warning to STDOUT, which is not empty, so a
# bare $(shell ...) satisfies the guard and the run dies later with
# `/bin/sh: line 1: output: command not found`.
REF := $(shell tofu output -raw project_ref 2>/dev/null | tr -d '\n' | grep -Eo '^[a-z]{20}$$' || true)

# The committed secrets deliberately carry a placeholder for the token, so the
# environment wins when it has one. A REPLACE_ME reaching the API is a 401 that
# looks like an auth bug rather than a missing credential - catch it here.
FILE_TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TOK := $(if $(SUPABASE_ACCESS_TOKEN),$(SUPABASE_ACCESS_TOKEN),$(FILE_TOK))
PW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)

# MANDATORY. `--experiment` only LABELS the report; one registry carries every
# experiment's tests and planRun filters on where/capabilities/only/destructive.
# Measured on this tree: with (pat, anon-key, db, org) and --destructive, an
# unfiltered run is `F01 F02 F03 F04 F05 C05* D01* D02* V04*` - C05 and V04
# belong to other experiments and are destructive.
ONLY ?= D01,D02
RUNNER_FLAGS ?=

.PHONY: init fmt validate apply probe probe-destructive destroy

init:
	tofu init

fmt:
	tofu fmt -recursive $(ROOT)

validate:
	@ls *.tf >/dev/null || (echo "no .tf files - tofu validate returns Success on an EMPTY dir"; exit 1)
	tofu validate

apply:
	tofu plan $(VARS) -var="supabase_access_token=$(TOK)" -out=tfplan
	tofu apply tfplan
	@echo "project_ref = $$(tofu output -raw project_ref)"

probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT - export SUPABASE_ACCESS_TOKEN or run 'make secrets-decrypt' at the root"; exit 1)
	@case "$(TOK)" in *REPLACE_ME*) echo "PAT is the committed placeholder - export SUPABASE_ACCESS_TOKEN"; exit 1;; esac
	@test -n "$(ONLY)" || (echo "refusing to run with an empty ONLY - see the comment above"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@anon=$$(curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/api-keys" \
		| jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	test -n "$$anon" || (echo "could not fetch the anon key"; exit 1); \
	PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" SUPABASE_ANON_KEY="$$anon" DB_PASSWORD="$(PW)" \
		$(ROOT)/harness/dist/pvlab --where local --experiment platform-downtime \
		--only $(ONLY) $(RUNNER_FLAGS) --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# Every module here restarts or restricts the project. Separate target so a
# bare `make probe` can never take it down by accident.
probe-destructive:
	@$(MAKE) probe RUNNER_FLAGS=--destructive

destroy:
	tofu plan -destroy $(VARS) -var="supabase_access_token=$(TOK)" -out=tfplan-destroy
	tofu apply tfplan-destroy
