ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
SHARED := $(shell tofu output -raw shared_ref 2>/dev/null)
SRCA := $(shell tofu output -raw src_a_ref 2>/dev/null)
SRCB := $(shell tofu output -raw src_b_ref 2>/dev/null)
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
	@echo "shared_ref = $$(tofu output -raw shared_ref)"
	@echo "src_a_ref  = $$(tofu output -raw src_a_ref)"
	@echo "src_b_ref  = $$(tofu output -raw src_b_ref)"

# C01-C05, all `where: "local"`: the questions are what the auth tier and the
# SQL surface accept over the public API, so there is no runner and no VPC -
# the PAT and three project refs are the whole input.
#
# All destructive: every test writes schema, users, or both, on all three
# projects. Without --destructive the suite plans zero tests.
probe:
	@test -n "$(SHARED)" || (echo "no shared_ref output - run 'make apply' first"; exit 1)
	@test -n "$(SRCA)" || (echo "no src_a_ref output - run 'make apply' first"; exit 1)
	@test -n "$(SRCB)" || (echo "no src_b_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(SHARED)" PVLAB_PEER_SRC_A="$(SRCA)" PVLAB_PEER_SRC_B="$(SRCB)" \
		SUPABASE_ACCESS_TOKEN="$(TOK)" \
		$(ROOT)/harness/dist/pvlab --where local --destructive --only C01,C02,C03,C04,C05 \
		--experiment tenant-consolidation --out evidence/$(TS)
	@echo "== evidence/$(TS)/REPORT.md =="

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy
