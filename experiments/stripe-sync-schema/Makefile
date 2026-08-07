ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
REF  := $(shell tofu output -raw project_ref 2>/dev/null)
POOL := $(shell tofu output -raw pooler_host 2>/dev/null)
TOK  := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
PW   := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS   := $(shell date +%Y%m%d-%H%M%S)

# Transaction pooler. Everything here is schema introspection, so the pooler is
# fine and it is the only path that works over IPv4.
PGURL = postgresql://postgres.$(REF):$(PW)@$(POOL):6543/postgres?connect_timeout=10

.PHONY: init fmt validate apply gate seed probe diff destroy

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

# The manual step, same shape as privatelink-aws's RAM invitation: a control
# that exists only in the Dashboard, so the Makefile refuses to continue until
# a human has done it and says exactly what to do.
#
# The install is not expressible in IaC and not scriptable. Verified 2026-08-07
# against CLI 2.111.0: no `integrations` subcommand, none under --experimental,
# no matching route string in the binary; the supabase Terraform provider
# exposes seven resources and none of them is an integration; and the published
# Management API spec's only `integration` routes are config/auth/third-party-auth.
# The Dashboard is evidently calling something, but it is unpublished, so
# wiring this to a private endpoint would buy automation at the price of a
# harness that breaks silently when the endpoint moves.
gate:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(PW)"  || (echo "no db_password in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@if psql "$(PGURL)" -tAc "select 1 from information_schema.schemata where schema_name='stripe'" 2>/dev/null | grep -q 1; then \
		echo "stripe schema present - integration is installed. Next: make seed"; \
	else \
		echo ""; \
		echo "  MANUAL STEP - the Stripe Sync Engine install is Dashboard-only."; \
		echo ""; \
		echo "  1. Open the project  $(REF)  in the Supabase Dashboard."; \
		echo "  2. Integrations -> Stripe Sync Engine -> Install."; \
		echo "  3. Paste a restricted key for the DEDICATED Stripe test account."; \
		echo "     Do not use an account that anything else depends on: this"; \
		echo "     experiment changes the account's API version on purpose."; \
		echo "  4. Re-run 'make gate'."; \
		echo ""; \
		exit 1; \
	fi

# Fixtures. The whole point of a dedicated account: the failure being measured
# is invisible unless subscriptions exist in states the naive demo never
# produces. STRIPE_SECRET_KEY is read from the environment, never from
# secrets.tfvars - see variables.tf for why.
seed:
	@test -n "$$STRIPE_SECRET_KEY" || (echo "export STRIPE_SECRET_KEY=sk_test_... for the dedicated test account"; exit 1)
	@echo "not implemented yet - see RUNLOG.md 'Fixture matrix'"
	@exit 1

probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@$(MAKE) --no-print-directory gate >/dev/null
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
	 DB_PASSWORD="$(PW)" PVLAB_ENDPOINT_POOLER="$(POOL)" \
		$(ROOT)/harness/dist/pvlab --where local --only E01,E02,E03 \
		--experiment stripe-sync-schema --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# Two runs either side of a Stripe API version change is the actual experiment;
# a single run only photographs one side of it.
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
