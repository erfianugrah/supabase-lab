ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
OUT := $(CURDIR)/evidence/$(TS)

# Ids sort in execution order; RM99 deletes the shared pair, so it stays last.
ONLY ?= RM01,RM02,RM99

# Needs, in the invoking environment: SUPABASE_ACCESS_TOKEN (a PAT) and
# PVLAB_ORG_PRO (the slug of a Pro organisation); Postgres 17 clients at PGBIN
# (default /opt/homebrew/opt/postgresql@17/bin); IPv6 to the direct db hosts.
# The modules create their own projects (rm-*) through the Management API,
# because create-to-healthy time is one of the measurements. Run from source.
# RM03 (pgmig cutover --with-auth-data, live) is a pgmig harness, not a module
# here: test/auth-cutover-live.harness.ts in the pgmig repo.
.PHONY: gen run teardown

gen:
	cd $(ROOT)/harness && bun scripts/gen-registry.ts >/dev/null

run: gen
	mkdir -p $(OUT)
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment region-move \
	  --only $(ONLY) --destructive --out $(OUT) 2>&1 | tee $(OUT)/console.log

# If a run died before RM99: delete every project recorded in .run/projects.json.
teardown: gen
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment region-move \
	  --only RM99 --destructive --out $(OUT)

.PHONY: publish-evidence

publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(ONLY),--only $(ONLY),)
