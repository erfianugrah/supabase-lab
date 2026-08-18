ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars

# A project ref is 20 lowercase letters (see platform-downtime Makefile for
# why the shape guard exists).
REF = $(shell tofu output -raw project_ref 2>/dev/null | tr -d '\n' | grep -Eo '^[a-z]{20}$$' || true)

# Environment wins over the file so a rotated PAT never reaches the API as a
# 401 that looks like an auth bug.
FILE_TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TOK := $(if $(SUPABASE_ACCESS_TOKEN),$(SUPABASE_ACCESS_TOKEN),$(FILE_TOK))
PW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)

DART := $(HOME)/sdk/dart-sdk/bin/dart

# gotrue version under test. 2.21.0 = last pre-fix release; >=2.22.0 carries
# the PR-1351 dedup/session-version guard.
GOTRUE_VERSION ?= 2.21.0

# GoTrue's default refresh-token reuse interval is 10s; wait past it.
REUSE_WINDOW_SEC ?= 12

.PHONY: init validate apply destroy repro repro-both

init:
	tofu init

validate:
	@ls *.tf >/dev/null || (echo "no .tf files"; exit 1)
	tofu validate

apply:
	tofu plan $(VARS) -var="supabase_access_token=$(TOK)" -out=tfplan
	tofu apply tfplan
	@echo "project_ref = $$(tofu output -raw project_ref)"

destroy:
	tofu plan -destroy $(VARS) -var="supabase_access_token=$(TOK)" -out=tfplan-destroy
	tofu apply tfplan-destroy

# One repro run: provision user -> dart run against gotrue $(GOTRUE_VERSION)
# -> delete user. Prints the RESULT block; verdict line is the differential.
repro:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT"; exit 1)
	@case "$(TOK)" in *REPLACE_ME*) echo "PAT is the committed placeholder"; exit 1;; esac
	$(eval TS := $(shell date +%Y%m%d-%H%M%S))
	@mkdir -p evidence/$(TS)
	@anon=$$(curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/api-keys" \
		| jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	svc=$$(curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/api-keys" \
		| jq -r '.[] | select(.name=="service_role") | .api_key' | head -1); \
	test -n "$$anon" -a -n "$$svc" || (echo "could not fetch api keys"; exit 1); \
	email="repro-$(TS)@example.com"; password="Repro-$(TS)-pass!"; \
	uid=$$(curl -s -X POST "https://$(REF).supabase.co/auth/v1/admin/users" \
		-H "apikey: $$svc" -H "Authorization: Bearer $$svc" \
		-H "Content-Type: application/json" \
		-d "{\"email\":\"$$email\",\"password\":\"$$password\",\"email_confirm\":true}" \
		| jq -r '.id'); \
	test "$$uid" != "null" -a -n "$$uid" || (echo "user create failed"; exit 1); \
	echo "user=$$uid gotrue=$(GOTRUE_VERSION)"; \
	cd dart && sed -i 's/^  gotrue: .*/  gotrue: $(GOTRUE_VERSION)/' pubspec.yaml \
		&& $(DART) pub get >/dev/null \
		&& SUPABASE_URL="https://$(REF).supabase.co" SUPABASE_ANON_KEY="$$anon" \
		   TEST_EMAIL="$$email" TEST_PASSWORD="$$password" \
		   $(DART) run bin/repro.dart stale-reuse $(REUSE_WINDOW_SEC) \
		   2>&1 | tee ../evidence/$(TS)/stale-reuse-gotrue-$(GOTRUE_VERSION).log; \
	curl -s -X DELETE "https://$(REF).supabase.co/auth/v1/admin/users/$$uid" \
		-H "apikey: $$svc" -H "Authorization: Bearer $$svc" >/dev/null; \
	echo "evidence: evidence/$(TS)/"

# The differential: same scenario, pre-fix vs post-fix gotrue.
repro-both:
	$(MAKE) repro GOTRUE_VERSION=2.21.0
	$(MAKE) repro GOTRUE_VERSION=2.27.2

# Local-stack variant. The hosted platform currently TOLERATES refresh-token
# reuse (even grandparent tokens, even past the reuse interval, even with
# reuse_interval=0 - see RUNLOG), so the `refresh_token_already_used` path
# the pre-fix client mishandles can only be triggered against a local gotrue
# (the supabase-flutter monorepo test stack, gateway :54421). Needs
# `supabase start` already running in the monorepo.
FLUTTER_REPO ?= $(HOME)/work/supabase-flutter
repro-local:
	$(eval TS := $(shell date +%Y%m%d-%H%M%S))
	@mkdir -p evidence/$(TS)
	@status=$$(cd $(FLUTTER_REPO) && supabase status -o json 2>/dev/null); \
	host=$$(echo "$$status" | jq -r '.API_URL'); \
	svc=$$(echo "$$status" | jq -r '.SERVICE_ROLE_KEY'); \
	anon=$$(echo "$$status" | jq -r '.ANON_KEY'); \
	test -n "$$host" -a "$$host" != "null" || (echo "local stack not running"; exit 1); \
	email="local-$(TS)@example.com"; password="Local-$(TS)-pass!"; \
	uid=$$(curl -s -X POST "$$host/auth/v1/admin/users" \
		-H "apikey: $$svc" -H "Authorization: Bearer $$svc" \
		-H "Content-Type: application/json" \
		-d "{\"email\":\"$$email\",\"password\":\"$$password\",\"email_confirm\":true}" \
		| jq -r '.id'); \
	test "$$uid" != "null" -a -n "$$uid" || (echo "user create failed"; exit 1); \
	echo "local user=$$uid gotrue=$(GOTRUE_VERSION)"; \
	cd dart && sed -i 's/^  gotrue: .*/  gotrue: $(GOTRUE_VERSION)/' pubspec.yaml \
		&& $(DART) pub get >/dev/null \
		&& SUPABASE_URL="$$host" SUPABASE_ANON_KEY="$$anon" \
		   TEST_EMAIL="$$email" TEST_PASSWORD="$$password" \
		   $(DART) run bin/repro.dart stale-reuse $(REUSE_WINDOW_SEC) \
		   2>&1 | tee ../evidence/$(TS)/local-stale-reuse-gotrue-$(GOTRUE_VERSION).log; \
	curl -s -X DELETE "$$host/auth/v1/admin/users/$$uid" \
		-H "apikey: $$svc" -H "Authorization: Bearer $$svc" >/dev/null; \
	echo "evidence: evidence/$(TS)/"

repro-local-both:
	$(MAKE) repro-local GOTRUE_VERSION=2.21.0
	$(MAKE) repro-local GOTRUE_VERSION=2.27.2
