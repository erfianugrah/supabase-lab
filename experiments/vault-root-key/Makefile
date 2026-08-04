ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
SRC := $(shell tofu output -raw source_ref 2>/dev/null)
DST := $(shell tofu output -raw target_ref 2>/dev/null)
TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
PW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS := $(shell date +%Y%m%d-%H%M%S)

.PHONY: init fmt validate apply probe probe-deleted-source destroy

init:
	tofu init

fmt:
	tofu fmt -recursive $(ROOT)

validate:
	tofu validate

apply:
	tofu plan $(VARS) -out=tfplan
	tofu apply tfplan
	@echo "source_ref = $$(tofu output -raw source_ref)"
	@echo "target_ref = $$(tofu output -raw target_ref)"

# V01-V03. All three write to the projects (vault secrets on both, and V03
# rewrites the target's root key), so --destructive is not optional: without
# it the suite plans zero tests. Ordering is load-bearing and the planner
# preserves it - V02 establishes "cannot decrypt without the key" BEFORE V03
# applies one.
probe:
	@test -n "$(SRC)" || (echo "no source_ref output - run 'make apply' first"; exit 1)
	@test -n "$(DST)" || (echo "no target_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@test -n "$(PW)" || (echo "no db_password in $(ROOT)/secrets.tfvars"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(SRC)" PVLAB_PEER_TARGET="$(DST)" SUPABASE_ACCESS_TOKEN="$(TOK)" DB_PASSWORD="$(PW)" \
		$(ROOT)/harness/dist/pvlab --where local --destructive --only V01,V02,V03 --experiment vault-root-key \
		--out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# V04 needs the source project GONE, so it cannot share a pass with the rest.
# The deletion goes through tofu -target rather than a DELETE call, so state
# stays truthful and 'make destroy' afterwards is still a clean no-drift run.
# The ref is captured BEFORE the destroy - afterwards the output is empty, and
# probing an empty ref would return a meaningless 404.
probe-deleted-source:
	@test -n "$(SRC)" || (echo "no source_ref output - nothing to delete"; exit 1)
	@echo "capturing dead ref: $(SRC)"
	tofu plan -destroy $(VARS) -target='supabase_project.source' -out=tfplan-destroy-source
	tofu apply tfplan-destroy-source
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)-deleted
	@PVLAB_REF="$(DST)" PVLAB_DEAD_REF="$(SRC)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
		$(ROOT)/harness/dist/pvlab --where local --destructive --only V04 --experiment vault-root-key \
		--out evidence/$(TS)-deleted
	@echo "== evidence/$(TS)-deleted/ =="

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy
