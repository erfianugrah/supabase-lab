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

.PHONY: gen read all sweep

gen:
	bun $(ROOT)/harness/scripts/gen-registry.ts

# MF01 only: no project is created.
read: gen
	$(RUN) --only MF01

# MF01-MF05, destructive tier included. MF04 provisions projects and takes
# about 10 minutes for MF01-MF04 (MF03e waits out six 60 s attempts); MF05 adds about 4.
all: gen
	$(RUN) --only MF01,MF02,MF03,MF04,MF05 --destructive

# Panic button: delete every project whose name starts with the experiment
# prefix. Never touches other names.
sweep:
	bun -e 'import {sweep} from "./lib/proxy.ts"; const pat=process.env.SUPABASE_ACCESS_TOKEN; console.log(await sweep({pat} as any))'
