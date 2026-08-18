ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
REF := $(shell tofu output -raw project_ref 2>/dev/null)
TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
ORG := $(shell grep -E '^supabase_org_id' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS := $(shell date +%Y%m%d-%H%M%S)

.PHONY: init fmt validate apply probe probe-destructive destroy

init:
	tofu init

fmt:
	tofu fmt -recursive $(ROOT)

validate:
	tofu validate

apply:
	tofu plan $(VARS) -out=tfplan
	tofu apply tfplan
	@echo "project_ref = $$(tofu output -raw project_ref)"

# Read-only battery (I01-I08, I10). I09 (rate ceiling) is destructive and
# only runs under probe-destructive. I10 additionally needs
# PVLAB_PLATFORM_JWT (a dashboard user token - the platform API rejects
# PATs); without it I10 self-skips with a reason.
probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@keys=$$(curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/api-keys"); \
	anon=$$(echo "$$keys" | jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	svc=$$(echo "$$keys" | jq -r '.[] | select(.name=="service_role") | .api_key' | head -1); \
	test -n "$$anon" -a -n "$$svc" || (echo "could not fetch project api keys"; exit 1); \
	PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
		SUPABASE_ANON_KEY="$$anon" SUPABASE_SERVICE_ROLE_KEY="$$svc" \
		PVLAB_ORG_SLUGS="$(ORG)" \
		$(ROOT)/harness/dist/pvlab --where local --experiment image-transformations \
		--only I01,I02,I03,I04,I05,I06,I07,I08,I10 \
		--out evidence/$(TS)
	@echo "== evidence/$(TS) =="

probe-destructive:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@keys=$$(curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/api-keys"); \
	anon=$$(echo "$$keys" | jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	svc=$$(echo "$$keys" | jq -r '.[] | select(.name=="service_role") | .api_key' | head -1); \
	PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
		SUPABASE_ANON_KEY="$$anon" SUPABASE_SERVICE_ROLE_KEY="$$svc" \
		PVLAB_ORG_SLUGS="$(ORG)" \
		$(ROOT)/harness/dist/pvlab --where local --experiment image-transformations \
		--destructive --only I09 \
		--out evidence/$(TS)
	@echo "== evidence/$(TS) =="

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy
