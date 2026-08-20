ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
REF := $(shell tofu output -raw project_ref 2>/dev/null)
# The PAT is NOT in secrets.tfvars - it lives in the operator's env as
# SUPABASE_ACCESS_TOKEN. Fall back to the file for other setups.
TOK := $(or $(SUPABASE_ACCESS_TOKEN),$(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2))
DBPW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS := $(shell date +%Y%m%d-%H%M%S)

.PHONY: init fmt validate apply probe probe-full diff destroy

init:
	tofu init

fmt:
	tofu fmt -recursive $(ROOT)

validate:
	tofu validate

apply:
	test -n "$(TOK)" || (echo "no PAT in env or secrets.tfvars"; exit 1)
	TF_VAR_supabase_access_token="$(TOK)" tofu plan $(VARS) -out=tfplan
	TF_VAR_supabase_access_token="$(TOK)" tofu apply tfplan
	@echo "project_ref = $$(tofu output -raw project_ref)"

# Read-only: R01, R03, R07. Needs no project for R01/R07, but harmless with one.
probe:
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" DB_PASSWORD="$(DBPW)" \
		$(ROOT)/harness/dist/pvlab --where local --only R01,R03,R07 --experiment residency-facts \
		--out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# Everything, including the mutating modules: R02 (smart-group rejection),
# R04 (function deploy), R05 (buckets/users), R06 (pooler SQL).
probe-full:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" DB_PASSWORD="$(DBPW)" \
		$(ROOT)/harness/dist/pvlab --where local --experiment residency-facts --destructive \
		--out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

diff:
	@cd $(ROOT)/harness && bun run build >/dev/null
	@ls -1 evidence/*/run-*.json 2>/dev/null | tail -2 | { \
		read prev; read cur; \
		test -n "$$cur" || (echo "need two runs under evidence/ - run 'make probe' twice"; exit 1); \
		echo "prev: $$prev"; echo "cur:  $$cur"; \
		$(ROOT)/harness/dist/pvlab --diff "$$prev,$$cur" --out evidence/diff-$(TS); }

destroy:
	TF_VAR_supabase_access_token="$(TOK)" tofu plan -destroy $(VARS) -out=tfplan-destroy
	TF_VAR_supabase_access_token="$(TOK)" tofu apply tfplan-destroy
