# pooler-checkout: self-provisioning (no OpenTofu state). The modules create
# one Micro project through the Management API, share it, and PC09 deletes it.
#
#   PVLAB_ORG_PRO=<org slug> SUPABASE_ACCESS_TOKEN=<pat> make probe
#
# Needs: bun, node (the driver probe runs under node), docker (toxiproxy for
# PC03), network to api.supabase.com and the regional pooler.
ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
# MANDATORY: one registry carries every experiment's tests.
ONLY ?= PC01,PC02,PC03,PC04,PC09
# Prefix of the project names this experiment creates; `sweep` deletes by it.
PREFIX ?= pc-checkout-

.PHONY: test probe sweep lint publish-evidence

test:
	@cd $(ROOT) && bun test experiments/pooler-checkout

# Runs from source (run.ts scans the registry), from this directory so the
# drivers/ path resolves.
probe:
	@test -n "$(SUPABASE_ACCESS_TOKEN)" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$(PVLAB_ORG_PRO)" || (echo "export PVLAB_ORG_PRO (a Pro org slug)"; exit 1)
	@cd $(ROOT) && bun harness/scripts/gen-registry.ts >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_PC_PREFIX="$(PREFIX)" bun $(ROOT)/harness/src/run.ts --where local --experiment pooler-checkout \
		--only $(ONLY) --destructive --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# Delete any project left behind by a run that died before PC09.
sweep:
	@test -n "$(SUPABASE_ACCESS_TOKEN)" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@curl -s -H "Authorization: Bearer $(SUPABASE_ACCESS_TOKEN)" https://api.supabase.com/v1/projects \
		| jq -r '.[] | select(.name | startswith("$(PREFIX)")) | .id' \
		| while read -r ref; do echo "deleting $$ref"; curl -s -o /dev/null -w "%{http_code}\n" -X DELETE -H "Authorization: Bearer $(SUPABASE_ACCESS_TOKEN)" https://api.supabase.com/v1/projects/$$ref; done

# Flag aws-0 pooler hosts under the given paths (default: the repo root).
lint:
	@bun lib/lint-pooler-hosts.ts $(or $(PATHS),$(ROOT))

publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(ONLY),--only $(ONLY),)
