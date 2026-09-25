ROOT := $(abspath ../..)
# The PAT in the decrypted secrets.tfvars is a placeholder; the live one is the
# supabase CLI's token file. Passed with -var, which beats the -var-file value.
TOK ?= $(shell cat $(HOME)/.supabase/access-token 2>/dev/null)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars -var=supabase_access_token=$(TOK)
SOURCE := $(shell tofu output -raw source_ref 2>/dev/null)
TARGET := $(shell tofu output -raw target_ref 2>/dev/null)
TS := $(shell date +%Y%m%d-%H%M%S)
# Optional: a project in a DIFFERENT org, for S01x (is kid uniqueness per org?).
# Not provisioned here - a free-org project cannot take instance_size via tofu.
XORG ?=

.PHONY: init fmt validate apply probe publish-evidence destroy

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

# S00-S04, all `where: "local"` and all destructive: they rotate signing keys
# and write auth rows on both projects. Id order is execution order - S00 must
# run before S01 imports the shared key, or the negative control is void.
probe:
	@test -n "$(SOURCE)" || (echo "no source_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TARGET)" || (echo "no target_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT - log in with the supabase CLI or pass TOK="; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(SOURCE)" PVLAB_PEER_TARGET="$(TARGET)" PVLAB_PEER_XORG="$(XORG)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
		$(ROOT)/harness/dist/pvlab --where local --destructive --only S00,S01,S02,S03,S04 \
		--experiment session-carry --out evidence/$(TS)
	@echo "== evidence/$(TS)/REPORT.md =="

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy

publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(ONLY),--only $(ONLY),)
