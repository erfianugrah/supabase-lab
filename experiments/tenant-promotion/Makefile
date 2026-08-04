ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
SHARED := $(shell tofu output -raw shared_ref 2>/dev/null)
DEDICATED := $(shell tofu output -raw dedicated_ref 2>/dev/null)
TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS := $(shell date +%Y%m%d-%H%M%S)

.PHONY: init fmt validate apply probe destroy

init:
	tofu init

fmt:
	tofu fmt -recursive $(ROOT)

validate:
	tofu validate

apply:
	tofu plan $(VARS) -out=tfplan
	tofu apply tfplan
	@echo "shared_ref    = $$(tofu output -raw shared_ref)"
	@echo "dedicated_ref = $$(tofu output -raw dedicated_ref)"

# P01-P04, all `where: "local"`: the questions are what the auth tier and the
# Management API accept over the public API, so there is no runner and no VPC
# here - the PAT and two project refs are the entire input.
#
# All destructive: every test writes schema, auth rows, or both, on both
# projects. Without --destructive the suite plans zero tests.
probe:
	@test -n "$(SHARED)" || (echo "no shared_ref output - run 'make apply' first"; exit 1)
	@test -n "$(DEDICATED)" || (echo "no dedicated_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(SHARED)" PVLAB_PEER_DEDICATED="$(DEDICATED)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
		$(ROOT)/harness/dist/pvlab --where local --destructive --only P01,P02,P03,P04 \
		--experiment tenant-promotion --out evidence/$(TS)
	@echo "== evidence/$(TS)/REPORT.md =="

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy