ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
REF := $(shell tofu output -raw project_ref 2>/dev/null)
TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
DBPW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
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
	@echo "project_ref = $$(tofu output -raw project_ref)"

# T22/T23 only. Both are declared `where: "runner"` because in the PrivateLink
# experiment the private-path rows have to execute in-VPC; here there is no
# VPC, so the flag is the test's declared vantage, not a claim about this
# machine. Without `db` capability T22 self-skips its private-path rows and
# still answers the lever question, which is the whole point of this dir.
probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@anon=$$(curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/api-keys" \
		| jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	test -n "$$anon" || (echo "could not fetch the anon key"; exit 1); \
	PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" SUPABASE_ANON_KEY="$$anon" \
		$(ROOT)/harness/dist/pvlab --where runner --destructive --only T22,T23 \
		--out evidence/$(TS)
	@echo "== evidence/$(TS)/run-<stamp>.md =="

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy
