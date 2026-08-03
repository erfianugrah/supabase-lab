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

# X01/X02 only. Both are `where: "local"` - the question is what the auth tier
# accepts over the public API, so there is no runner and no VPC here; the PAT
# and two project refs are the entire input.
#
# Both are `destructive` because they write auth config, schema and users, so
# --destructive is not optional: without it the suite plans zero tests.
probe:
	@test -n "$(HUB)" || (echo "no hub_ref output - run 'make apply' first"; exit 1)
	@test -n "$(SPOKE)" || (echo "no spoke_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(HUB)" XPROJ_SPOKE_REF="$(SPOKE)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
		$(ROOT)/harness/dist/pvlab --where local --destructive --only X01,X02 --experiment cross-project-auth \
		--out evidence/$(TS)
	@echo "== evidence/$(TS)/REPORT.md =="

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy
