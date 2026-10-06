ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
REF := $(shell tofu output -raw project_ref 2>/dev/null | tr -d '\n' | grep -Eo '^[a-z]{20}$$' || true)
# The local secrets.tfvars comments the token out (a quoted placeholder there
# would beat TF_VAR_), so the environment supplies it: `sx SUPABASE_ACCESS_TOKEN
# -- make apply`. TF_VAR_ keeps it out of the process list.
TOK := $(SUPABASE_ACCESS_TOKEN)
export TF_VAR_supabase_access_token = $(TOK)
TS := $(shell date +%Y%m%d-%H%M%S)
# Every module writes to the project (bucket + objects, or a deployed
# function), so all of them are destructive. HS05 needs `make site` first.
ALL := HS01,HS02,HS03,HS05

.PHONY: init validate apply site probe domain-up front domain-down probe-bg publish-evidence destroy

init:
	tofu init

validate:
	tofu validate

apply:
	@test -n "$(TOK)" || (echo "no PAT - run under: sx SUPABASE_ACCESS_TOKEN -- make apply"; exit 1)
	tofu plan $(VARS) -out=tfplan
	tofu apply tfplan
	@echo "project_ref = $$(tofu output -raw project_ref)"

# The Astro site, built once per host: each mounts it under a different base
# path. The island calls the project's Auth health endpoint with the anon key,
# which is public by design; the builds are gitignored all the same (they carry
# the project ref).
site:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@cd site && bun install --frozen-lockfile >/dev/null
	@anon=$$(curl -s -H "Authorization: Bearer $(TOK)" "https://api.supabase.com/v1/projects/$(REF)/api-keys" \
		| jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	cd site && for t in "root|/" "storage|/storage/v1/object/public/astro" "fn|/functions/v1/pvlab-hs-astro"; do \
		name=$${t%%|*}; base=$${t#*|}; \
		SITE_BASE="$$base" OUT_DIR="./dist-$$name" PUBLIC_SUPABASE_URL="https://$(REF).supabase.co" \
			PUBLIC_SUPABASE_ANON_KEY="$$anon" bun run build >/dev/null && echo "built dist-$$name (base $$base)"; \
	done

# ONLY=HS02 narrows the run. HS05-domain self-skips unless a custom domain is active
# on the project and passed in: make probe DOMAIN=static.example.com
# Runs from source by default: `bun run build` compiles for linux-x64, and
# HS05 drives a local browser, so this battery runs on the operator's machine.
ONLY ?= $(ALL)
DOMAIN ?=
KEEP ?= 0
SITE_STORAGE ?=
SITE_FN ?=
RUNNER ?= bun $(ROOT)/harness/src/run.ts
BUILD ?= 0
probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT - run under: sx SUPABASE_ACCESS_TOKEN -- make probe"; exit 1)
	@if [ "$(BUILD)" = "1" ]; then cd $(ROOT)/harness && bun run build >/dev/null; else cd $(ROOT)/harness && bun run gen >/dev/null; fi
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" PVLAB_ENDPOINT_CUSTOM_DOMAIN="$(DOMAIN)" PVLAB_ENDPOINT_SITE_STORAGE="$(SITE_STORAGE)" PVLAB_ENDPOINT_SITE_FN="$(SITE_FN)" PVLAB_SHOTS="evidence/$(TS)/screens" PVLAB_KEEP_DEPLOYED="$(KEEP)" \
		$(RUNNER) --where local --experiment static-hosting \
		--destructive --only $(ONLY) --out evidence/$(TS)
	@echo "== evidence/$(TS) =="

# The documented exception, end to end: custom domain up (HS04, DNS through
# the Cloudflare API), then the browser battery against it with the function
# left deployed so the URLs can be opened. BILLABLE until domain-down.
#   sx SUPABASE_ACCESS_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL -- make domain-up DOMAIN=<host>
domain-up:
	@test -n "$(DOMAIN)" || (echo "DOMAIN=<host in a Cloudflare zone> required"; exit 1)
	@$(MAKE) probe ONLY=HS04,HS05 DOMAIN="$(DOMAIN)" KEEP=1

# Production-shaped: a Worker on your own hostname in front of each origin,
# serving the root-base build at `/`. Left up for viewing; domain-down removes it.
#   sx SUPABASE_ACCESS_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL CLOUDFLARE_ACCOUNT_ID -- \
#     make front DOMAIN=<custom domain> SITE_STORAGE=<host> SITE_FN=<host>
front:
	@test -n "$(SITE_STORAGE)" || (echo "SITE_STORAGE=<host in a Cloudflare zone> required"; exit 1)
	@$(MAKE) probe ONLY=HS06 DOMAIN="$(DOMAIN)" SITE_STORAGE="$(SITE_STORAGE)" SITE_FN="$(SITE_FN)"

# Workers, hostname, DNS records and add-on removed. Run before `make destroy`: the
# records live in the Cloudflare zone, not the project.
domain-down:
	@test -n "$(DOMAIN)" || (echo "DOMAIN=<host> required"; exit 1)
	@$(MAKE) probe ONLY=HS07 DOMAIN="$(DOMAIN)"

probe-bg:
	@mkdir -p evidence
	@log=evidence/probe-$(TS).log; \
	nohup sh -c '$(MAKE) probe ONLY="$(ONLY)" DOMAIN="$(DOMAIN)"; echo "=== make exit $$? $$(date +%T)"' > $$log 2>&1 < /dev/null & \
	echo "running detached; log: $$log"

# Redact and publish a run artifact to out/<date>/ (committed) with its facts
# rendering. RUN=evidence/<ts>/run-<stamp>.json; PUBLISH_ONLY narrows the ids
# (its own variable: ONLY defaults to the battery list, which dropped HS04/HS06/
# HS07 rows from the first publishes).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)

destroy:
	@test -n "$(TOK)" || (echo "no PAT - run under: sx SUPABASE_ACCESS_TOKEN -- make destroy"; exit 1)
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy
