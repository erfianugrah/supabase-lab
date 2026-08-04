ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
HUB := $(shell tofu output -raw hub_ref 2>/dev/null)
SPOKE := $(shell tofu output -raw spoke_ref 2>/dev/null)
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
	@echo "hub_ref   = $$(tofu output -raw hub_ref)"
	@echo "spoke_ref = $$(tofu output -raw spoke_ref)"

# R01-R03, all `where: "local"`: the questions are what the auth tier and the
# Management API accept over the public API, so there is no runner and no VPC
# here - the PAT and two project refs are the entire input.
#
# All destructive: every test writes auth config, signing keys, and users on
# both projects. Without --destructive the suite plans zero tests.
probe:
	@test -n "$(HUB)" || (echo "no hub_ref output - run 'make apply' first"; exit 1)
	@test -n "$(SPOKE)" || (echo "no spoke_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(HUB)" PVLAB_PEER_SPOKE="$(SPOKE)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
		$(ROOT)/harness/dist/pvlab --where local --destructive --only R01,R02,R03 \
		--experiment key-rotation --out evidence/$(TS)
	@echo "== evidence/$(TS)/REPORT.md =="

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy
