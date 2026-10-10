ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
comma := ,

# Self-provisioning: no OpenTofu state. Destructive modules create their own
# `lo-*` projects in the Pro org and delete them in `finally`.
#   SUPABASE_ACCESS_TOKEN  Management API token
#   PVLAB_ORG_PRO          slug of the Pro organization (export it; never commit it)
# LO01 is read-only and needs neither.
#
# ids run in numeric order inside the destructive tier. LO02 is not used: the
# first draft of the restart module ran under that id (RUNLOG) and is LO05.
ONLY ?= LO03,LO04,LO05

.PHONY: test status run-destructive

# Gate unit tests (fixtures, no network).
test:
	@cd $(ROOT) && bun test experiments/lifecycle-ops

# LO01: reads status.supabase.com, no credential.
status:
	@cd $(ROOT) && bun harness/scripts/gen-registry.ts >/dev/null
	@cd $(ROOT) && bun harness/src/run.ts --where local --experiment lifecycle-ops --only LO01 --out experiments/lifecycle-ops/evidence/$(TS)

# LO03: 3 creates, sequential. LO04: 1-2 creates. LO05: 1 create, ~20 min
# (waits ~11.5 min after the create before restarting). One full pass = 5-6
# creates. Set LO_HANDOFF=1 to let LO05 restart the project LO04 leaves running
# (saves a create; LO05 then waits from LO04's first POST, see RUNLOG). The
# runner is invoked from source because harness/dist/pvlab is linux-x64.
run-destructive:
	@test -n "$(SUPABASE_ACCESS_TOKEN)" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$(PVLAB_ORG_PRO)" || (echo "export PVLAB_ORG_PRO=<pro org slug>"; exit 1)
	@cd $(ROOT) && bun harness/scripts/gen-registry.ts >/dev/null
	@cd $(ROOT) && bun harness/src/run.ts --where local --experiment lifecycle-ops \
		--only $(ONLY) --destructive --out experiments/lifecycle-ops/evidence/$(TS)
