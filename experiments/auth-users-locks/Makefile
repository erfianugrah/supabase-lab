ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
REF := $(shell tofu output -raw project_ref 2>/dev/null)
TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
PW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS := $(shell date +%Y%m%d-%H%M%S)

# Every module: lock modes on a FK to auth.users, the NOT VALID avoidance, and
# an idle-txn blocking a migration-shaped ALTER. All destructive (they create
# and drop tables and one probe user), all measured through the session pooler.
IDS ?= AL01,AL02,AL03

.PHONY: init fmt validate apply probe publish-evidence destroy

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

# Session pooler (IPv4) - AL* hold transactions open, which transaction mode
# would break by moving the backend between statements, so port 5432. Anon key
# for the sign-in observable, service_role for admin user creation, DB password
# for the pg connections, pooler host derived from the region output.
probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@pooler="aws-0-$$(tofu output -raw region).pooler.supabase.com"; \
	keys=$$(curl -s -H "Authorization: Bearer $(TOK)" "https://api.supabase.com/v1/projects/$(REF)/api-keys?reveal=true"); \
	anon=$$(echo "$$keys" | jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	svc=$$(echo "$$keys" | jq -r '.[] | select(.name=="service_role") | .api_key' | head -1); \
	test -n "$$anon" -a -n "$$svc" || (echo "could not fetch anon/service_role keys"; exit 1); \
	PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
		SUPABASE_ANON_KEY="$$anon" SUPABASE_SERVICE_ROLE_KEY="$$svc" \
		DB_PASSWORD="$(PW)" PVLAB_ENDPOINT_POOLER="$$pooler" \
		$(ROOT)/harness/dist/pvlab --where local --experiment auth-users-locks \
		--destructive --only "$(IDS)" --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# Redact a run artifact and publish it (plus facts.md) to the committed out/<date>/.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(ONLY),--only $(ONLY),)

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy
