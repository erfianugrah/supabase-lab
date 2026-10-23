ROOT := $(abspath ../..)
include $(ROOT)/harness/pvlab.mk
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
HUB := $(shell tofu output -raw hub_ref 2>/dev/null)
SPOKE := $(shell tofu output -raw spoke_ref 2>/dev/null)
TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS := $(shell date +%Y%m%d-%H%M%S)

.PHONY: init fmt validate apply probe destroy fanout fanout-clean publish-evidence

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
probe: export SUPABASE_ACCESS_TOKEN := $(TOK)
probe:
	@test -n "$(HUB)" || (echo "no hub_ref output - run 'make apply' first"; exit 1)
	@test -n "$(SPOKE)" || (echo "no spoke_ref output - run 'make apply' first"; exit 1)
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@$(HARNESS_BUILD)
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(HUB)" PVLAB_PEER_SPOKE="$(SPOKE)" \
		$(HARNESS_RUN) --where local --destructive --only X01,X02 --experiment cross-project-auth \
		--out evidence/$(TS)
	@echo "== evidence/$(TS)/REPORT.md =="

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy

# X04-X07 + X99: the fan-out modules self-provision their own two Pro-org
# projects through POST /v1/projects (no OpenTofu state) and X99 deletes them.
#   SUPABASE_ACCESS_TOKEN   Management API token (exported by the caller)
#   PVLAB_ORG_PRO           slug of a Pro-plan organization
#   PVLAB_XF_PREFIX         project-name prefix (default pvlab-xf-)
#   PVLAB_REFS_FILE         optional: append each created ref here (keep it outside git)
# Include X99 in XF_ONLY or the projects are left running; `make fanout-clean`
# lists leftovers by prefix, `make fanout-clean DELETE=1` deletes them.
XF_ONLY ?= X04,X05,X06,X07,X99

fanout:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$$PVLAB_ORG_PRO" || (echo "export PVLAB_ORG_PRO"; exit 1)
	@cd $(ROOT)/harness && bun run gen >/dev/null
	@mkdir -p evidence/$(TS)
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment cross-project-auth \
		--only $(XF_ONLY) --destructive --out experiments/cross-project-auth/evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

fanout-clean:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	cd $(ROOT)/experiments/cross-project-auth && bun lib/fanout-cleanup.ts $(if $(DELETE),--delete,)

# Redacted copy + facts table into out/<date>/ - what RUNLOG cites.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
