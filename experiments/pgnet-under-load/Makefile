ROOT := $(abspath ../..)
include $(ROOT)/harness/pvlab.mk
TS := $(shell date +%Y%m%d-%H%M%S)

# Self-provisioning, no OpenTofu state. Two processes, run in parallel:
#   make micro   NL01, NL02 on a fresh Pro-org Micro, then NL99 deletes it
#   make large   NL03, NL04 on a fresh Pro-org Large, then NL99 deletes it
# Environment (never argv):
#   SUPABASE_ACCESS_TOKEN     Management API token
#   PVLAB_ORG_PRO             slug of a Pro-plan organization
#   RECEIVER                  URL printed by `make receiver-up`
# Receiver: `make receiver-up` / `make receiver-down` need CLOUDFLARE_API_TOKEN
# (Workers edit) and CLOUDFLARE_ACCOUNT_ID in the env.
# Leftovers by name prefix: `make clean` lists, `make clean DELETE=1` deletes.
MICRO ?= NL01,NL02,NL99
LARGE ?= NL03,NL04,NL99

.PHONY: micro large receiver-up receiver-down clean publish-evidence

define run_ids
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$$PVLAB_ORG_PRO" || (echo "export PVLAB_ORG_PRO"; exit 1)
	@test -n "$(RECEIVER)" || (echo "RECEIVER=<workers.dev url> required (make receiver-up)"; exit 1)
	@$(HARNESS_BUILD)
	@mkdir -p evidence/$(TS)-$(1)
	cd $(ROOT) && PVLAB_ENDPOINT_RECEIVER="$(RECEIVER)" $(HARNESS_RUN) --where local --experiment pgnet-under-load \
		--only $(2) --destructive --out experiments/pgnet-under-load/evidence/$(TS)-$(1)
	@echo "== evidence/$(TS)-$(1)/ =="
endef

micro:
	$(call run_ids,micro,$(MICRO))

large:
	$(call run_ids,large,$(LARGE))

receiver-up:
	cd receiver && wrangler deploy

receiver-down:
	cd receiver && wrangler delete --force

clean:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	cd $(ROOT)/experiments/pgnet-under-load && bun lib/cleanup.ts $(if $(DELETE),--delete,)

# Redacted copy + facts table into out/<date>/ - what RUNLOG and docs cite.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
