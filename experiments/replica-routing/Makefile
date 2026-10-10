# replica-routing: self-provisioning (Management API), no OpenTofu state.
# Creates a Small project, a pitr_7 add-on and one read replica, measures, then
# removes the replica and deletes the project in `finally`.
#
#   SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<pro-org-slug> make run
#
# Optional:
#   PVLAB_RR_KEEP=1              skip teardown (you delete rr-* by hand)
#   PVLAB_PEER_RR_PRIMARY=<ref>  reuse a primary (needs DB_PASSWORD); no teardown
#   PVLAB_RR_PHASES=routing,ryw  limit phases: replica routing methods edge ryw lag conflict logs
#   PVLAB_RR_N / PVLAB_RR_RYW_N / PVLAB_RR_CONFLICT_MAX_S   sample sizes and conflict wait bound
ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

.PHONY: run facts publish list

run:
	@test -n "$(PVLAB_ORG_PRO)" || (echo "PVLAB_ORG_PRO not set" && exit 1)
	cd $(ROOT) && bun harness/src/run.ts --where local --tests experiments/replica-routing/tests \
	  --experiment replica-routing --only RR01 --destructive \
	  --out experiments/replica-routing/evidence/$(TS)

# RUN=evidence/<ts>/run-<stamp>.json
facts:
	cd $(ROOT) && bun harness/src/run.ts --facts experiments/replica-routing/$(RUN) --only RR01

publish:
	cd $(ROOT) && bun harness/scripts/publish-evidence.ts experiments/replica-routing/$(RUN) experiments/replica-routing

# After a run, confirm nothing is left billing:
leftovers:
	@curl -s -H "Authorization: Bearer $(SUPABASE_ACCESS_TOKEN)" https://api.supabase.com/v1/projects | jq -r '.[] | select(.name | startswith("rr-")) | .name'
