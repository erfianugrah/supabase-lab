ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
OUT := $(CURDIR)/evidence/$(TS)

# Ids sort in execution order; PL99 deletes the shared source project, so it
# stays last. PL01 is read-only and needs no project.
ONLY ?= PL01,PL02,PL03,PL04,PL05,PL06,PL07,PL08,PL99

# Needs, in the invoking environment: SUPABASE_ACCESS_TOKEN (a PAT) and
# PVLAB_ORG_PRO (the slug of a Pro organisation); docker with compose; duckdb
# and psql on PATH. Run from source: the compiled harness binary targets
# linux-x64 and cannot drive this Mac's docker.
.PHONY: gen probe run teardown clean

gen:
	cd $(ROOT)/harness && bun scripts/gen-registry.ts >/dev/null

# Read-only: what a PAT can reach of Pipelines.
probe: gen
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment pipelines \
	  --only PL01 --out $(OUT)

# The whole battery. Creates one pl-* project, deletes it in PL99.
run: gen
	mkdir -p $(OUT)
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment pipelines \
	  --only $(ONLY) --destructive --out $(OUT) 2>&1 | tee $(OUT)/console.log

# If a run died before PL99: delete the project recorded in .run/fixture.json
# and the local stack.
teardown: gen
	cd $(ROOT) && bun harness/src/run.ts --where local --experiment pipelines \
	  --only PL99 --destructive --out $(OUT)

clean:
	docker compose --env-file .run/env --profile replicator down -v --remove-orphans
	rm -rf .run
