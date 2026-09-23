ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
TS := $(shell date +%Y%m%d-%H%M%S)

REF   = $(shell tofu output -raw project_ref 2>/dev/null | tr -d '\n' | grep -Eo '^[a-z]{20}$$' || true)
REF_B = $(shell tofu output -raw project_b_ref 2>/dev/null | tr -d '\n' | grep -Eo '^[a-z]{20}$$' || true)

FILE_TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TOK := $(if $(SUPABASE_ACCESS_TOKEN),$(SUPABASE_ACCESS_TOKEN),$(FILE_TOK))

# The probe repository, owner/name. Kept out of tracked files: pass it on the
# command line (make probe REPO=owner/name).
REPO ?=
# SSH remote host, kept separate so the remote never reads as an address.
GH_HOST := github.com
# Org override (the shared secrets.tfvars default is not necessarily the plan wanted).
ORG_ID ?=
ORG_VAR := $(if $(ORG_ID),-var="supabase_org_id=$(ORG_ID)",)
ONLY ?= GB00,GB01

.PHONY: init validate apply push-fixture push-ci probe publish-evidence destroy

init:
	tofu init

validate:
	@ls *.tf >/dev/null || (echo "no .tf files"; exit 1)
	tofu validate

apply:
	tofu plan $(VARS) -var="supabase_access_token=$(TOK)" $(ORG_VAR) -out=tfplan
	tofu apply tfplan
	@echo "A=$$(tofu output -raw project_ref) B=$$(tofu output -raw project_b_ref)"

# Seed the (already created, empty) probe repository with fixture/ as main.
push-fixture:
	@test -n "$(REPO)" || (echo "REPO=owner/name required"; exit 1)
	@d=$$(mktemp -d) && cp -r fixture/. $$d/ && cd $$d && git init -q -b main && git add -A \
		&& git commit -qm "Monorepo fixture: apps/a and apps/b, each with supabase/" \
		&& git remote add origin git@$(GH_HOST):$(REPO).git && git push -q -u origin main && echo "pushed to $(REPO)"

# GB02's workflow. Over SSH because writing under .github/workflows/ through the
# REST API needs the OAuth `workflow` scope, which a default gh login lacks.
push-ci:
	@test -n "$(REPO)" || (echo "REPO=owner/name required"; exit 1)
	@d=$$(mktemp -d) && git clone -q git@$(GH_HOST):$(REPO).git $$d && mkdir -p $$d/.github/workflows \
		&& cp fixture-ci/wait-a.yaml $$d/.github/workflows/wait-a.yaml && cd $$d && git add -A \
		&& git commit -qm "ci: docs wait-by-name workflow for app A" && git push -q origin main && echo "pushed workflow to $(REPO)"

# Everything runs from this machine: the Management API, the v2 connections
# endpoint, and GitHub through the operator's gh login.
probe:
	@test -n "$(REF)" -a -n "$(REF_B)" || (echo "no project refs - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT - export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$(REPO)" || (echo "REPO=owner/name required"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(REF)" PVLAB_PEER_B="$(REF_B)" PVLAB_ENDPOINT_REPO="$(REPO)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
		$(ROOT)/harness/dist/pvlab --where local --experiment github-branching \
		--only "$(ONLY)" --destructive --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@test -n "$(REPO)" || (echo "REPO=owner/name required (it is redacted from the published copy)"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
	@# The shared redaction is by identifier SHAPE; the probe repository's name
	@# has no shape, so it is replaced literally (GB01's evidence records it).
	@grep -rlF "$(REPO)" out/ 2>/dev/null | xargs -r sed -i "s#$(REPO)#<repo>#g"
	@! grep -rqF "$(REPO)" out/ || (echo "repository name still present in out/"; exit 1)

destroy:
	tofu plan -destroy $(VARS) -var="supabase_access_token=$(TOK)" $(ORG_VAR) -out=tfplan-destroy
	tofu apply tfplan-destroy
