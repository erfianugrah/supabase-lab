ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
TS := $(shell date +%Y%m%d-%H%M%S)

# A project ref is 20 lowercase letters; filtering on the shape makes the
# guards fire when there is no state (tofu prints a warning to STDOUT).
REF := $(shell tofu output -raw project_ref 2>/dev/null | tr -d '\n' | grep -Eo '^[a-z]{20}$$' || true)
REGION := $(shell tofu output -raw region 2>/dev/null | tr -d '\n' | grep -Eo '^[a-z0-9-]+$$' || echo ap-southeast-1)

# The committed secrets carry a placeholder token; the environment wins.
FILE_TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TOK := $(if $(SUPABASE_ACCESS_TOKEN),$(SUPABASE_ACCESS_TOKEN),$(FILE_TOK))
PW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)

# Read-only modules. The Postgres ones (TL10-TL12) cover direct 5432 and the
# dedicated 6543 only once TL14 has put the IPv4 add-on on - see `full`.
READ_ONLY := TL01,TL02,TL03,TL04,TL05,TL06,TL10,TL11,TL12
ONLY ?= $(READ_ONLY)
RUNNER_FLAGS ?=
# Set to a hostname to point TL17 at it; default tl17.lab.erfi.io.
CUSTOM_HOST ?=

.PHONY: init fmt validate apply probe probe-destructive full diff publish-evidence destroy

init:
	tofu init

fmt:
	tofu fmt -recursive $(ROOT)

validate:
	@ls *.tf >/dev/null || (echo "no .tf files - tofu validate returns Success on an EMPTY dir"; exit 1)
	tofu validate

# Recipe lines silenced (@): make would otherwise echo the PAT into the log.
apply:
	@tofu plan $(VARS) -var="supabase_access_token=$(TOK)" -out=tfplan
	@tofu apply tfplan
	@echo "project_ref = $$(tofu output -raw project_ref)"

probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT - export SUPABASE_ACCESS_TOKEN"; exit 1)
	@case "$(TOK)" in *REPLACE_ME*) echo "PAT is the committed placeholder - export SUPABASE_ACCESS_TOKEN"; exit 1;; esac
	@test -n "$(ONLY)" || (echo "refusing to run with an empty ONLY: the registry spans every experiment"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@keys=$$(curl -s -H "Authorization: Bearer $(TOK)" "https://api.supabase.com/v1/projects/$(REF)/api-keys?reveal=true"); \
	anon=$$(echo "$$keys" | jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	svc=$$(echo "$$keys" | jq -r '.[] | select(.name=="service_role") | .api_key' | head -1); \
	test -n "$$anon" || (echo "could not fetch the anon key"; exit 1); \
	PVLAB_REF="$(REF)" AWS_REGION="$(REGION)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
		SUPABASE_ANON_KEY="$$anon" SUPABASE_SERVICE_ROLE_KEY="$$svc" DB_PASSWORD="$(PW)" \
		PVLAB_ENDPOINT_CUSTOM_HOST="$(CUSTOM_HOST)" \
		$(ROOT)/harness/dist/pvlab --where local --experiment tls-surface \
		--only $(ONLY) $(RUNNER_FLAGS) --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

probe-destructive:
	@$(MAKE) probe RUNNER_FLAGS=--destructive

# The whole surface, in the order the modules need:
#   1. read-only pass (edge + shared pooler)
#   2. TL14 IPv4 add-on on (billable while on)
#   3. Postgres modules again, now reaching direct 5432 and dedicated 6543
#   4. SSL enforcement on/off, pg_net and Edge Function outbound
#   5. TL17 custom domain (billable while on; needs ~/bin/knotctl) - skipped
#      unless CUSTOM=1
#   6. TL18 IPv4 add-on off
full:
	@$(MAKE) probe ONLY=$(READ_ONLY)
	@$(MAKE) probe-destructive ONLY=TL14
	@$(MAKE) probe ONLY=TL10,TL11,TL12
	@$(MAKE) probe-destructive ONLY=TL16,TL20,TL21
	@if [ "$(CUSTOM)" = "1" ]; then $(MAKE) probe-destructive ONLY=TL17; else echo "TL17 skipped (CUSTOM=1 to run it)"; fi
	@$(MAKE) probe-destructive ONLY=TL18

# Compare the two most recent runs of the same module set. Offline. The
# per-suite (TL02) and per-route (TL05) columns are what move between runs.
diff:
	@cd $(ROOT)/harness && bun run build >/dev/null
	@ls -1 evidence/*/run-*.json 2>/dev/null | tail -2 | { \
		read prev; read cur; \
		test -n "$$cur" || (echo "need two runs under evidence/"; exit 1); \
		echo "prev: $$prev"; echo "cur:  $$cur"; \
		$(ROOT)/harness/dist/pvlab --diff "$$prev,$$cur" --out evidence/diff-$(TS); }

publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(ONLY),--only $(ONLY),)

destroy:
	@tofu plan -destroy $(VARS) -var="supabase_access_token=$(TOK)" -out=tfplan-destroy
	@tofu apply tfplan-destroy
