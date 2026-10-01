ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
TS := $(shell date +%Y%m%d-%H%M%S)

# A project ref is 20 lowercase letters. Filtering on that SHAPE is what makes
# the `test -n` guard below actually fire: with no state, `tofu output -raw`
# prints its "No outputs found" warning to STDOUT, which is not empty.
REF := $(shell tofu output -raw project_ref 2>/dev/null | tr -d '\n' | grep -Eo '^[a-z]{20}$$' || true)
REGION := $(shell tofu output -raw region 2>/dev/null | tr -d '\n' | grep -Eo '^[a-z0-9-]+$$' || echo ap-southeast-2)

# The committed secrets carry a placeholder token; the environment wins.
FILE_TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TOK := $(if $(SUPABASE_ACCESS_TOKEN),$(SUPABASE_ACCESS_TOKEN),$(FILE_TOK))
PW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)

# MANDATORY. One registry carries every experiment's tests; without --only a
# destructive run reaches other experiments' destructive modules.
ONLY ?= MS01
RUNNER_FLAGS ?=
# Which experiment label to run under. `pooler-semantics` reuses this project
# for S01/S02 (that experiment has no tofu of its own); the endpoint variables
# below are what its modules read.
EXPERIMENT ?= medium-serverless

# Connection surface, read off the live project by `make pooler-config` and
# passed in rather than constructed. POOLER_TXN is the DEDICATED pooler
# (db.<ref>.supabase.co:6543, user `postgres`); SHARED_TXN / POOLER_SESSION
# are Supavisor (aws-<n>-<region>.pooler.supabase.com, user postgres.<ref>).
POOLER ?= $(shell curl -s -H "Authorization: Bearer $(TOK)" "https://api.supabase.com/v1/projects/$(REF)/config/database/pooler" 2>/dev/null | jq -r '[.[] | select(.database_type=="PRIMARY")][0].db_host // empty')
POOLER_USER ?= postgres.$(REF)
POOLER_SESSION ?= $(POOLER):5432
SHARED_TXN ?= $(POOLER):6543
POOLER_TXN ?= db.$(REF).supabase.co:6543
POOLER_TXN_USER ?= postgres

.PHONY: init fmt validate apply pooler-config bench-init probe probe-destructive probe-bg publish-evidence destroy

init:
	tofu init

fmt:
	tofu fmt -recursive $(ROOT)

validate:
	@ls *.tf >/dev/null || (echo "no .tf files - tofu validate returns Success on an EMPTY dir"; exit 1)
	tofu validate

# Recipe lines silenced (@): make would otherwise echo the command line, PAT
# included, into whatever the run is logged to.
apply:
	@tofu plan $(VARS) -var="supabase_access_token=$(TOK)" -out=tfplan
	@tofu apply tfplan
	@echo "project_ref = $$(tofu output -raw project_ref)"

pooler-config:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@echo "== /v1/projects/$(REF)/config/database/pooler =="
	@curl -s -H "Authorization: Bearer $(TOK)" "https://api.supabase.com/v1/projects/$(REF)/config/database/pooler" | jq 'map(del(.connection_string, .connectionString))'
	@echo "== /v1/projects/$(REF)/config/database/pgbouncer =="
	@curl -s -H "Authorization: Bearer $(TOK)" "https://api.supabase.com/v1/projects/$(REF)/config/database/pgbouncer" | jq 'del(.connection_string)'
	@echo "== addons =="
	@curl -s -H "Authorization: Bearer $(TOK)" "https://api.supabase.com/v1/projects/$(REF)/billing/addons" | jq '{selected: [.selected_addons[] | {type, variant: .variant.id}], available: [.available_addons[] | .type]}'

# One-time; DROPS pgbench_* in the project. Runs on the direct host, which
# needs the IPv4 add-on from this vantage (MS02 puts it on).
BENCH_SCALE ?= 10
bench-init:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@PGSSLMODE=require PGCONNECT_TIMEOUT=10 pgbench -i -s $(BENCH_SCALE) "postgres://postgres:$(PW)@db.$(REF).supabase.co:5432/postgres"

probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT - export SUPABASE_ACCESS_TOKEN"; exit 1)
	@case "$(TOK)" in *REPLACE_ME*) echo "PAT is the committed placeholder - export SUPABASE_ACCESS_TOKEN"; exit 1;; esac
	@test -n "$(ONLY)" || (echo "refusing to run with an empty ONLY - see the comment above"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@keys=$$(curl -s -H "Authorization: Bearer $(TOK)" "https://api.supabase.com/v1/projects/$(REF)/api-keys?reveal=true"); \
	anon=$$(echo "$$keys" | jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	svc=$$(echo "$$keys" | jq -r '.[] | select(.name=="service_role") | .api_key' | head -1); \
	test -n "$$anon" || (echo "could not fetch the anon key"; exit 1); \
	PVLAB_REF="$(REF)" AWS_REGION="$(REGION)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
		SUPABASE_ANON_KEY="$$anon" SUPABASE_SERVICE_ROLE_KEY="$$svc" DB_PASSWORD="$(PW)" \
		PVLAB_ENDPOINT_POOLER="$(POOLER)" PVLAB_ENDPOINT_POOLER_SESSION="$(POOLER_SESSION)" \
		PVLAB_ENDPOINT_POOLER_TXN="$(POOLER_TXN)" PVLAB_ENDPOINT_POOLER_TXN_USER="$(POOLER_TXN_USER)" \
		PVLAB_ENDPOINT_SHARED_TXN="$(SHARED_TXN)" PVLAB_ENDPOINT_POOLER_USER="$(POOLER_USER)" \
		PVLAB_SBPERF="$${PVLAB_SBPERF:-$$(command -v pg-analyser || true)}" \
		$(ROOT)/harness/dist/pvlab --where local --experiment $(EXPERIMENT) \
		--only $(ONLY) $(RUNNER_FLAGS) --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

probe-destructive:
	@$(MAKE) probe RUNNER_FLAGS=--destructive

# Detached, with a log: the long modules (replica, resize, ramp) outlive a
# foreground shell comfortably.
probe-bg:
	@mkdir -p evidence
	@nohup $(MAKE) probe-destructive ONLY=$(ONLY) > evidence/probe-$(TS).log 2>&1 &
	@echo "log: evidence/probe-$(TS).log"

publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(ONLY),--only $(ONLY),)

destroy:
	@tofu plan -destroy $(VARS) -var="supabase_access_token=$(TOK)" -out=tfplan-destroy
	@tofu apply tfplan-destroy
