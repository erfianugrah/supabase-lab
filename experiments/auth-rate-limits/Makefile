ROOT := $(abspath ../..)
include $(ROOT)/harness/pvlab.mk
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
REF := $(shell tofu output -raw project_ref 2>/dev/null)
TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS := $(shell date +%Y%m%d-%H%M%S)

# AR04 is read-only (config + one SQL row); the rest burst endpoints, create
# users and PATCH auth config (restored in finally), so they are destructive.
READONLY := AR04
DESTRUCTIVE := AR01,AR02,AR03

.PHONY: init fmt validate apply probe probe-destructive publish-evidence destroy

init:
	tofu init

fmt:
	tofu fmt -recursive $(ROOT)

validate:
	@ls *.tf >/dev/null || (echo "no .tf files - tofu validate returns Success on an EMPTY dir"; exit 1)
	tofu validate

apply:
	tofu plan $(VARS) -out=tfplan
	tofu apply tfplan
	@echo "project_ref = $$(tofu output -raw project_ref)"

# Fetches anon + service_role + publishable + secret keys: AR01/AR02 need the
# anon key for the public endpoints, AR02 needs the sb_secret_ key for
# forwarding, AR03 needs service_role for admin-create.
KEYS = keys=$$(printf 'Authorization: Bearer %s\n' "$$SUPABASE_ACCESS_TOKEN" | curl -s -H @- "https://api.supabase.com/v1/projects/$(REF)/api-keys?reveal=true"); \
	anon=$$(echo "$$keys" | jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	svc=$$(echo "$$keys" | jq -r '.[] | select(.name=="service_role") | .api_key' | head -1)

probe: export SUPABASE_ACCESS_TOKEN := $(TOK)
probe:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@$(HARNESS_BUILD)
	@mkdir -p evidence/$(TS)
	@$(KEYS); \
	PVLAB_REF="$(REF)" SUPABASE_ANON_KEY="$$anon" SUPABASE_SERVICE_ROLE_KEY="$$svc" \
		$(HARNESS_RUN) --where local --experiment auth-rate-limits \
		--only $(READONLY) --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# The bursts, admin-creates and config PATCHes. ONLY=AR01 narrows it.
ONLY ?= $(DESTRUCTIVE)
probe-destructive: export SUPABASE_ACCESS_TOKEN := $(TOK)
probe-destructive:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "no PAT in $(ROOT)/secrets.tfvars"; exit 1)
	@$(HARNESS_BUILD)
	@mkdir -p evidence/$(TS)
	@$(KEYS); \
	test -n "$$anon" -a -n "$$svc" || (echo "could not fetch anon/service_role keys"; exit 1); \
	PVLAB_REF="$(REF)" SUPABASE_ANON_KEY="$$anon" SUPABASE_SERVICE_ROLE_KEY="$$svc" \
		$(HARNESS_RUN) --where local --experiment auth-rate-limits \
		--destructive --only $(ONLY) --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(ONLY),--only $(ONLY),)

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy

# Self-provisioned AR05/AR06 (no tofu state): a Pro-org project created through
# POST /v1/projects, deleted by AR99. Environment only, never argv:
#   SUPABASE_ACCESS_TOKEN   Management API token
#   PVLAB_ORG_PRO           slug of a Pro-plan organization
# PVLAB_AR_REF reuses a project across invocations (AR06 bucket run, then one
# AR05 run per size); `make clean DELETE=1` removes leftovers by name prefix.
SELF ?= AR06,AR99
.PHONY: run-self clean
run-self:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$$PVLAB_ORG_PRO$$PVLAB_AR_REF" || (echo "export PVLAB_ORG_PRO (or PVLAB_AR_REF)"; exit 1)
	@cd $(ROOT)/harness && bun run gen >/dev/null
	@mkdir -p evidence/$(TS)
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment auth-rate-limits \
		--only $(SELF) --destructive --out experiments/auth-rate-limits/evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

clean:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	bun lib/cleanup.ts $(if $(DELETE),--delete,)
