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

.PHONY: run run-rr02 run-rr03 facts publish list

# RR02: re-routing on a lagging or unhealthy replica, non-REST traffic through
# the load balancer. Same billing shape as RR01; 24 and 33 minutes in the
# 2026-10-23 runs. Knobs:
#   PVLAB_RR_PHASES=services,burst,stall,restart,remove,logs
#   PVLAB_RR_STANDBY_DELAY (600s) / PVLAB_RR_STALL_S (180) / PVLAB_RR_BURST_ROWS (1500000; filled a Small disk on 2026-10-23, RR02g)
#   PVLAB_RR_REMOVE_WATCH_S (360)  how long RR02j reads after the remove call
#   PVLAB_RR_REFS_FILE=<path outside git>  appends the created ref
run-rr02:
	@test -n "$(PVLAB_ORG_PRO)" || (echo "PVLAB_ORG_PRO not set" && exit 1)
	cd $(ROOT) && bun harness/src/run.ts --where local --tests experiments/replica-routing/tests \
	  --experiment replica-routing --only RR02 --destructive \
	  --out experiments/replica-routing/evidence/$(TS)

# RR03: user JWTs, RLS, API keys, RPC volatility and HEAD routing on a replica,
# the load balancer's split with primary and replica in the same region, lag
# under steady writes. Small primary + Small replica + pitr_7, same region. Knobs:
#   PVLAB_RR3_REGION (ap-southeast-1) / PVLAB_RR3_REPLICA_REGION (same)
#   PVLAB_RR3_LAG_S (300) / PVLAB_RR3_LAG_RATE (50 rows/s)
#   PVLAB_RR_REFS_FILE=<path outside git>  appends the created ref
run-rr03:
	@test -n "$(PVLAB_ORG_PRO)" || (echo "PVLAB_ORG_PRO not set" && exit 1)
	cd $(ROOT) && bun harness/src/run.ts --where local --tests experiments/replica-routing/tests \
	  --experiment replica-routing --only RR03 --destructive \
	  --out experiments/replica-routing/evidence/$(TS)

run:
	@test -n "$(PVLAB_ORG_PRO)" || (echo "PVLAB_ORG_PRO not set" && exit 1)
	cd $(ROOT) && bun harness/src/run.ts --where local --tests experiments/replica-routing/tests \
	  --experiment replica-routing --only RR01 --destructive \
	  --out experiments/replica-routing/evidence/$(TS)

# RUN=evidence/<ts>/run-<stamp>.json
facts:
	cd $(ROOT) && bun harness/src/run.ts --facts experiments/replica-routing/$(RUN) --only $(or $(ONLY),RR01)

publish:
	cd $(ROOT) && bun harness/scripts/publish-evidence.ts experiments/replica-routing/$(RUN) experiments/replica-routing

# After a run, confirm nothing is left billing:
leftovers:
	@printf 'Authorization: Bearer %s\n' "$$SUPABASE_ACCESS_TOKEN" | curl -s -H @- https://api.supabase.com/v1/projects | jq -r '.[] | select(.name | startswith("rr-")) | .name'
