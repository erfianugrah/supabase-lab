ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
OUT := $(CURDIR)/evidence/$(TS)

# Self-provisioning: modules create mf- projects on the Pro org and
# delete them in `finally`. No OpenTofu state in this directory (MF04 uses a
# scratch directory with local state).
#
# Needs: docker (oven/bun:1 for the proxy), tofu, supabase CLI, bun.
#   SUPABASE_ACCESS_TOKEN  Management API PAT
#   PVLAB_ORG_PRO          slug of a Pro org to create throwaway projects in
RUN = bun $(ROOT)/harness/src/run.ts --where local --experiment mgmt-api-faults --out $(OUT)

.PHONY: gen read all conn reconcile sweep publish-evidence

gen:
	bun $(ROOT)/harness/scripts/gen-registry.ts

# MF01 only: no project is created.
read: gen
	$(RUN) --only MF01

# MF01-MF05, destructive tier included. MF04 provisions projects and takes
# about 10 minutes for MF01-MF04 (MF03e waits out six 60 s attempts); MF05 adds about 4.
all: gen
	$(RUN) --only MF01,MF02,MF03,MF04,MF05 --destructive

# MF06-MF08: connection-level faults (in-process proxy, no docker) and the
# orphan reconciler. MF06 creates nothing; MF07 creates five projects, MF08
# one; all are deleted. About 2 minutes. Needs the supabase CLI, node, bun
# and openssl.
conn: gen
	$(RUN) --only MF06,MF07,MF08 --destructive

# Orphan check for any tool that keeps a JSON Lines ledger of the creates it
# heard a 2xx for (lib/reconcile.ts). Read-only; exit 3 when orphans exist.
#   make reconcile LEDGER=path/to/ledger.jsonl [PREFIX=mf-] [STATE=path/to/state.json] [GRACE_S=300]
reconcile:
	@test -n "$(LEDGER)" || (echo "LEDGER=<ledger.jsonl> required"; exit 1)
	bun lib/reconcile.ts --ledger $(LEDGER) --prefix $(or $(PREFIX),mf-) --grace-s $(or $(GRACE_S),300) $(if $(STATE),--state $(STATE),)

# RUN is the harness command here, so the artifact goes in ARTIFACT.
publish-evidence:
	@test -n "$(ARTIFACT)" || (echo "ARTIFACT=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(ARTIFACT)) $(abspath .) $(if $(ONLY),--only $(ONLY),)

# Panic button: delete every project whose name starts with the experiment
# prefix. Never touches other names.
sweep:
	bun -e 'import {sweep} from "./lib/proxy.ts"; const pat=process.env.SUPABASE_ACCESS_TOKEN; console.log(await sweep({pat} as any))'
