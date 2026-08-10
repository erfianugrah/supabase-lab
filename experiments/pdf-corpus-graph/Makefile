ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
REF  := $(shell tofu output -raw project_ref 2>/dev/null)
SIZE := $(shell tofu output -raw instance_size 2>/dev/null)
REGION := $(shell tofu output -raw region 2>/dev/null)
PW   := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS   := $(shell date +%Y%m%d-%H%M%S)

# The PAT comes from the ENVIRONMENT, not from secrets.tfvars.
#
# AGENTS.md requires the committed ciphertext to decrypt to placeholders rather
# than to a token someone later has to discover is dead, and it does: the token
# line decrypts to a bare, UNQUOTED `REPLACE_ME`. That is not merely a dead
# value - it is invalid HCL, so tofu rejects the whole var-file with "Variables
# not allowed" and every other value in it (org id, db password) becomes
# unreadable too. The local gitignored copy therefore comments that line out
# entirely rather than quoting it, because a quoted placeholder would parse and
# then WIN: environment variables are the lowest-precedence source in tofu, so a
# present-but-fake -var-file entry silently beats TF_VAR_ and the run fails
# authentication instead of failing to configure.
#
# Supplying it as TF_VAR_ rather than -var keeps the live credential out of the
# process list, and out of any file that only a .gitignore line protects.
TOK := $(SUPABASE_ACCESS_TOKEN)
export TF_VAR_supabase_access_token = $(TOK)

.PHONY: init fmt validate apply wait-ready pooler schema corpus deploy-fn probe diff destroy

init:
	tofu init

fmt:
	tofu fmt -recursive $(ROOT)

validate:
	tofu validate

apply: guard-tok
	tofu plan $(VARS) -out=tfplan
	tofu apply tfplan
	@echo "project_ref = $$(tofu output -raw project_ref)"

guard-tok:
	@test -n "$(TOK)" || (echo "no SUPABASE_ACCESS_TOKEN in the environment - export a live PAT (the one in secrets.tfvars is a placeholder by design)"; exit 1)

# ACTIVE_HEALTHY on the aggregate status is not readiness, and neither is the
# first per-service health poll - AGENTS.md records two of two fresh projects
# answering healthy and then failing the first write. Poll per service, then
# sleep past the window rather than treating the first failure as a finding.
wait-ready: guard-tok
	@test -n "$(REF)" || (echo "no project_ref - run 'make apply' first"; exit 1)
	@printf 'waiting for services'
	@for i in $$(seq 1 60); do \
		s=$$(curl -s -H "Authorization: Bearer $(TOK)" \
			"https://api.supabase.com/v1/projects/$(REF)/health?services=db&services=rest&services=auth" \
			| jq -r '[.[].status] | unique | join(",")' 2>/dev/null); \
		if [ "$$s" = "ACTIVE_HEALTHY" ]; then printf ' healthy\n'; sleep 20; exit 0; fi; \
		printf '.'; sleep 10; \
	done; printf '\ntimed out\n'; exit 1

# Derived, not hardcoded. Other experiments here pin "aws-0-<region>" and newer
# projects are provisioned behind aws-1; asking the API costs one call and
# removes a class of failure that presents as an unreachable database.
#
# The response is an ARRAY, one entry per database, not an object: a project
# with read replicas returns the primary alongside them. Selecting on
# database_type is what makes this correct on a project that later grows a
# replica - `.connection_string` on the array yields a jq type error, and
# `.[0]` would silently pick whichever the API happened to order first.
pooler:
	@curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/config/database/pooler" \
		| jq -r '[.[] | select(.database_type=="PRIMARY")][0].db_host // empty'

schema:
	@psql "$$($(MAKE) --no-print-directory pgurl)" -v ON_ERROR_STOP=1 -f sql/schema.sql

pgurl:
	@echo "postgresql://postgres.$(REF):$(PW)@$$($(MAKE) --no-print-directory pooler):6543/postgres?connect_timeout=15"

probe: guard-tok
	@test -n "$(REF)" || (echo "no project_ref - run 'make apply' first"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
	 DB_PASSWORD="$(PW)" PVLAB_REGION="$(REGION)" \
	 PVLAB_ENDPOINT_POOLER="$$($(MAKE) --no-print-directory pooler)" \
	 PVLAB_INSTANCE_SIZE="$(SIZE)" \
		$(ROOT)/harness/dist/pvlab --where local $(ONLY) \
		--experiment pdf-corpus-graph --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

diff:
	@cd $(ROOT)/harness && bun run build >/dev/null
	@ls -1 evidence/*/run-*.json 2>/dev/null | tail -2 | { \
		read prev; read cur; \
		test -n "$$cur" || (echo "need two runs under evidence/ - run 'make probe' twice"; exit 1); \
		$(ROOT)/harness/dist/pvlab --diff "$$prev,$$cur" --out evidence/diff-$(TS); }

destroy: guard-tok
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy
