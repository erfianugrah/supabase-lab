ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
REF := $(shell tofu output -raw project_ref 2>/dev/null)
TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS := $(shell date +%Y%m%d-%H%M%S)

# Organization slugs to read entitlements from. NOT a tofu resource: the
# supabase provider has no organization resource and plan changes are a
# billing action, so these are a precondition supplied by the operator.
# Ideally one Pro and one Team - the interesting rows are the ones that differ.
ORGS ?=

.PHONY: init fmt validate apply probe diff destroy

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

# F01/F02/F03 are all read-only GETs, so no --destructive and nothing to
# clean up. Built to be re-run on a schedule: `make probe` twice, then
# `make diff`, and the drift in platform constants is the output.
#
# Do NOT diff the rendered reports by hand - they carry timestamps, a lab
# commit and per-test durations, so every re-run diffs dirty and the one
# entitlement that moved is buried. `make diff` compares at the measurement
# level instead.
probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@test -n "$(ORGS)" || echo "note: ORGS empty - F01 will skip. Re-run with 'make probe ORGS=slug-a,slug-b'"
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" PVLAB_ORG_SLUGS="$(ORGS)" \
		$(ROOT)/harness/dist/pvlab --where local --only F01,F02,F03 --experiment platform-facts \
		--out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# Compare the two most recent runs. Offline: no PAT, no network - the diff is
# a pure function over two artifacts.
diff:
	@cd $(ROOT)/harness && bun run build >/dev/null
	@ls -1 evidence/*/run-*.json 2>/dev/null | tail -2 | { \
		read prev; read cur; \
		test -n "$$cur" || (echo "need two runs under evidence/ - run 'make probe' twice"; exit 1); \
		echo "prev: $$prev"; echo "cur:  $$cur"; \
		$(ROOT)/harness/dist/pvlab --diff "$$prev,$$cur" --out evidence/diff-$(TS); }

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy
