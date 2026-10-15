ROOT := $(abspath ../..)
STAMP ?= $(shell date -u +%Y%m%d-%H%M%S)
IDS ?= TD02
OUT := $(CURDIR)/evidence/$(STAMP)

# Self-provisioning, no OpenTofu state: `make up` creates one of each backend
# in Sydney plus the probe Worker and writes .fixture.json (gitignored);
# `make down` deletes them; `make cleanup` deletes any sec-* leftover on all
# three vendors (prefix-filtered: the Cloudflare account and both orgs hold
# other work, and nothing without the sec- prefix is ever listed for deletion).
#
# Environment (never written down in this repo), injected per command:
#   SUPABASE_ACCESS_TOKEN                     Management API PAT
#   PVLAB_ORG_PRO                             slug of a Pro-plan organization
#   CLOUDFLARE_EMAIL CLOUDFLARE_API_KEY CLOUDFLARE_ACCOUNT_ID   Global API Key trio (wrangler + REST)
#   TURSO_API_TOKEN                           Turso Platform API token
#   PVLAB_TURSO_ORG                           Turso organization slug
# e.g.
#   sx SUPABASE_ACCESS_TOKEN CLOUDFLARE_EMAIL CLOUDFLARE_API_KEY CLOUDFLARE_ACCOUNT_ID \
#      TURSO_API_TOKEN=TURSO_API_TOKEN -- env PVLAB_ORG_PRO=<slug> PVLAB_TURSO_ORG=<slug> make up
#
# `make probe` exports the fixture's identifiers (PVLAB_ENDPOINT_*, PVLAB_PEER_*,
# PVLAB_REF, PVLAB_ORG_TURSO) from .fixture.json into the runner's environment;
# secrets stay in the file and modules read them through lib/client.ts.

.PHONY: gen up down status probe list cleanup publish-evidence test

gen:
	cd $(ROOT) && bun harness/scripts/gen-registry.ts >/dev/null

# ~6-10 min: the Supabase project dominates (ACTIVE_HEALTHY, then readiness).
up:
	bun lib/fixture.ts up

down:
	bun lib/fixture.ts down

status:
	bun lib/fixture.ts status

# One battery at a time: modules share the Worker colo, never run two probes at once.
probe: gen
	@mkdir -p $(OUT)
	@envs="$$(bun lib/fixture.ts env)" || exit 1; eval "$$envs"; \
	  cd $(ROOT) && TD_STAMP=$(STAMP) bun harness/src/run.ts \
	  --tests experiments/sqlite-edge-compare/tests --where local \
	  --experiment sqlite-edge-compare --only $(IDS) --destructive --out $(OUT)/$(IDS)

list: gen
	cd $(ROOT) && bun harness/src/run.ts --tests experiments/sqlite-edge-compare/tests --where local --list | grep TD || true

# Safety net after a killed run. DRY=1 lists without deleting. Exit 1 if anything is left.
cleanup:
	bun lib/fixture.ts cleanup $(if $(DRY),--dry-run,)

test:
	cd $(ROOT) && bun test experiments/sqlite-edge-compare/lib

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
# Shapeless identifiers (Turso org, D1 / Hyperdrive ids) come from the live and
# archived fixtures (evidence/fixture-ids-*.json) as PVLAB_REDACT_LITERALS.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@PVLAB_REDACT_LITERALS="$$(bun lib/fixture.ts literals)"; export PVLAB_REDACT_LITERALS; \
	  cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
