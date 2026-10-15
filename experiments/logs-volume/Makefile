ROOT := $(abspath ../..)
STAMP ?= $(shell date -u +%Y%m%d-%H%M%S)
IDS ?= LV01,LV02
OUT := $(CURDIR)/evidence/$(STAMP)

# Self-provisioning: every module creates its own `lv-` project on the Pro org
# (PVLAB_ORG_PRO) and deletes it in `finally`. No OpenTofu state.
# Environment (never written down in this repo):
#   SUPABASE_ACCESS_TOKEN   Management API PAT
#   PVLAB_ORG_PRO           slug of a Pro-plan organization
# Inject them per command, e.g.
#   sx SUPABASE_ACCESS_TOKEN -- env PVLAB_ORG_PRO=<slug> make probe IDS=LV01

.PHONY: gen probe list cleanup publish-evidence

gen:
	cd $(ROOT) && bun harness/scripts/gen-registry.ts >/dev/null

# LV01 ~25-28 min (LV01_N, LV01_IDLE_S), LV02 ~14-17 min (LV02_WORK). Modules run in sequence.
probe: gen
	@mkdir -p $(OUT)
	cd $(ROOT) && LV_STAMP=$(STAMP) bun harness/src/run.ts \
	  --tests experiments/logs-volume/tests --where local \
	  --experiment logs-volume --only $(IDS) --destructive --out $(OUT)/$(IDS)

list: gen
	cd $(ROOT) && bun harness/src/run.ts --tests experiments/logs-volume/tests --where local --list | grep LV

# Safety net after a killed run: delete every project whose name starts with lv-.
cleanup:
	@printf 'Authorization: Bearer %s\n' "$$SUPABASE_ACCESS_TOKEN" | curl -s https://api.supabase.com/v1/projects -H @- \
	  | jq -r '.[] | select(.name | startswith("lv-")) | .id' \
	  | while read r; do echo "deleting $$r"; \
	      printf 'Authorization: Bearer %s\n' "$$SUPABASE_ACCESS_TOKEN" | curl -s -o /dev/null -w "%{http_code}\n" -X DELETE https://api.supabase.com/v1/projects/$$r -H @-; done
	@printf 'Authorization: Bearer %s\n' "$$SUPABASE_ACCESS_TOKEN" | curl -s https://api.supabase.com/v1/projects -H @- \
	  | jq -r '[.[] | select(.name | startswith("lv-"))] | length | "lv- projects left: \(.)"'

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
