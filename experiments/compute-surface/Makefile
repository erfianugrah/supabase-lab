ROOT := $(abspath ../..)
include $(ROOT)/harness/pvlab.mk
STAMP ?= $(shell date -u +%Y%m%d-%H%M%S)
IDS ?= CS00
OUT := $(CURDIR)/evidence/$(STAMP)

# Self-provisioning: CS00 creates one `compute-surface-` Micro project on the
# Pro org (PVLAB_ORG_PRO) and deletes it in `finally`. No OpenTofu state.
# Environment (never written down in this repo):
#   SUPABASE_ACCESS_TOKEN   Management API PAT
#   PVLAB_ORG_PRO           slug of a Pro-plan organization
# Inject them per command, e.g.
#   sx SUPABASE_ACCESS_TOKEN -- env PVLAB_ORG_PRO=<slug> make probe
# The prefix is long on purpose: `cleanup` deletes by prefix, and the lab org
# keeps long-lived projects whose names start with `cs-`.
PREFIX := compute-surface-

.PHONY: gen probe list cleanup publish-evidence

gen:
	@$(HARNESS_BUILD)

# CS00 ~2-4 min (project create dominates).
probe: gen
	@mkdir -p $(OUT)
	$(HARNESS_RUN) --tests $(CURDIR)/tests --where local \
	  --experiment compute-surface --only $(IDS) --destructive --out $(OUT)

list: gen
	$(HARNESS_RUN) --tests $(CURDIR)/tests --where local --list | grep CS

# Safety net after a killed run: delete every project whose name starts with $(PREFIX).
cleanup:
	@printf 'Authorization: Bearer %s\n' "$$SUPABASE_ACCESS_TOKEN" | curl -s https://api.supabase.com/v1/projects -H @- \
	  | jq -r '.[] | select(.name | startswith("$(PREFIX)")) | .id' \
	  | while read r; do echo "deleting $$r"; \
	      printf 'Authorization: Bearer %s\n' "$$SUPABASE_ACCESS_TOKEN" | curl -s -o /dev/null -w "%{http_code}\n" -X DELETE https://api.supabase.com/v1/projects/$$r -H @-; done
	@printf 'Authorization: Bearer %s\n' "$$SUPABASE_ACCESS_TOKEN" | curl -s https://api.supabase.com/v1/projects -H @- \
	  | jq -r '[.[] | select(.name | startswith("$(PREFIX)"))] | length | "$(PREFIX) projects left: \(.)"'

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
