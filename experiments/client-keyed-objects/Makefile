# client-keyed-objects: one reference application (catalogue + RLS + custom
# access token hook, an operator-run key service, a TypeScript client doing
# chunked AES-256-GCM envelope encryption) and the CK01-CK13 suite, run
# against a self-hosted stack and two managed projects. See README.md.
#
#   make onprem                 self-hosted, MinIO backend: stack up, setup, CK01-CK13, stack down
#   make onprem-file            the same stack on the default file backend (control)
#   make managed                two Pro-org projects (ap-southeast-1, eu-central-1), suite, delete in finally
#   make managed MANAGED=region-b IDS=CK04,CK06   one region, chosen modules
#   make sweep                  list ck- projects left behind (needs SUPABASE_ACCESS_TOKEN)
#   make parity RUNS="a.json b.json ..."   one parity table from run artifacts
#   make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
#   make unit                   offline tests of the envelope layout and AEAD binding
#   make clean                  remove stacks, key service, KEKs, fixtures, run dir
#
# The self-hosted stack runs as its own compose project (ck-<name>) on host
# ports 8100 / 5532 / 6643, so it can run next to the self-hosted-defaults rig.
# The harness runs from source: the client's AWS SDK, tus-js-client and
# playwright-core live in client/ (own package.json) and run as child
# processes, so the compiled registry does not need them.
ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
IDS ?= CK01,CK02,CK03,CK04,CK05,CK06,CK07,CK08,CK09,CK10,CK11,CK12,CK13
# MANAGED=region-b re-runs one region; CK_BIG_MIB=2250 sizes the large fixture (default 2048).
MANAGED ?= region-a region-b
CK := bun scripts/ck.ts
RUN_DIR := $(abspath work/run$(if $(CK_SLOT),-$(CK_SLOT),))

.PHONY: deps onprem onprem-file managed probe sweep parity publish-evidence unit clean clean-fixtures

deps:
	@cd client && bun install >/dev/null
	@cd keysvc && bun install >/dev/null
	@cd $(ROOT)/harness && bun scripts/gen-registry.ts >/dev/null

# One self-hosted target end to end; the stack and its KEKs are removed
# whatever happened, so a failed run cannot leave ports 8100/5532/6643 taken.
define onprem_run
	@status=0; \
	  ( $(CK) onprem-prepare $(1) $(2) && $(CK) onprem-up $(1) && $(CK) run-init $(1) && $(CK) setup $(1) && $(CK) keysvc-up && $(MAKE) probe ) || status=$$?; \
	  $(CK) keysvc-down; $(CK) onprem-down $(1); exit $$status
endef

onprem: deps
	$(call onprem_run,onprem,s3)

onprem-file: deps
	$(call onprem_run,onprem-file,file)

# Managed: create both projects, run, delete them whatever happened.
managed: deps
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "SUPABASE_ACCESS_TOKEN not set"; exit 1)
	@test -n "$$PVLAB_ORG_PRO" || (echo "PVLAB_ORG_PRO not set (slug of a Pro org)"; exit 1)
	@status=0; \
	  ( CK_MANAGED="$(MANAGED)" $(CK) managed-up && $(CK) run-init $(MANAGED) && $(CK) setup $(MANAGED) && $(CK) keysvc-up && $(MAKE) probe ) || status=$$?; \
	  $(CK) keysvc-down; $(CK) managed-down; $(CK) sweep; exit $$status

probe:
	@mkdir -p evidence/$(TS)
	@cd $(ROOT) && PVLAB_ENDPOINT_CK_RUN_DIR="$(RUN_DIR)" bun harness/src/run.ts --where local --experiment client-keyed-objects \
		--only $(IDS) --destructive --out experiments/client-keyed-objects/evidence/$(TS)
	@echo "== evidence/$(TS) =="

sweep:
	@$(CK) sweep

parity:
	@test -n "$(RUNS)" || (echo 'RUNS="evidence/<ts>/run-<stamp>.json ..."'; exit 1)
	@bun scripts/parity.ts $(RUNS)

publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .)

unit:
	@cd client && bun test src

clean-fixtures:
	rm -rf work/fixtures

clean: clean-fixtures
	-$(CK) keysvc-down
	-$(CK) onprem-down onprem
	-$(CK) onprem-down onprem-file
	rm -rf work/run work/scratch
