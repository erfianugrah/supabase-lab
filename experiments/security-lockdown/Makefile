ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
REF := $(shell tofu output -raw project_ref 2>/dev/null)
TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
PW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS := $(shell date +%Y%m%d-%H%M%S)
IDS ?= S01,S02,S03,S04,S05,S06,S07,S08,S09,S10,S11,S12,S13,S14,S15,S16,S17,S18,S19,S20,S21
PGRST_PORT ?= 3001
RL_PORT ?= 8080
RLW_PORT ?= 8788
EDGE_PORT ?= 8081

.PHONY: init fmt validate apply probe publish-evidence destroy postgrest-up postgrest-down ratelimit-up ratelimit-down ratelimit-worker-up ratelimit-worker-down edge-up edge-down

init:
	tofu init

fmt:
	tofu fmt -recursive $(ROOT)

validate:
	tofu validate

apply:
	tofu plan $(VARS) -out=tfplan
	tofu apply tfplan
	@echo "project_ref = $$(tofu output -raw project_ref)"

# S04: self-hosted PostgREST (Docker) against the project's Postgres, with a
# db-pre-request IP filter - the control the managed Data API cannot give.
# Connects through the session pooler (IPv4). The pre-request function is
# installed by the S04 module; this target just runs the container.
# Pinned to the verified latest stable image tag (oci_tags, 2026-08-28).
postgrest-up:
	@test -n "$(REF)" || (echo "no project_ref - run 'make apply' first"; exit 1)
	@pooler="aws-0-$$(tofu output -raw region).pooler.supabase.com"; \
	uri="postgres://postgres.$(REF):$(PW)@$$pooler:5432/postgres"; \
	docker rm -f sec-postgrest >/dev/null 2>&1 || true; \
	docker run -d --name sec-postgrest -p $(PGRST_PORT):3000 \
		-e PGRST_DB_URI="$$uri" \
		-e PGRST_DB_SCHEMAS=public \
		-e PGRST_DB_ANON_ROLE=anon \
		-e PGRST_DB_PRE_REQUEST=public.sec_ip_filter \
		-e PGRST_SERVER_PORT=3000 \
		postgrest/postgrest:v16.2 >/dev/null && echo "postgrest up on :$(PGRST_PORT)"

postgrest-down:
	-docker rm -f sec-postgrest >/dev/null 2>&1 && echo "postgrest down"

# S05: nginx rate limiter in front of the self-hosted PostgREST. Pinned tag
# (oci_tags, 2026-08-28). host-gateway lets the container reach the PostgREST
# port published on the host.
ratelimit-up:
	docker rm -f sec-ratelimit >/dev/null 2>&1 || true
	docker run -d --name sec-ratelimit --add-host=host.docker.internal:host-gateway \
		-p $(RL_PORT):8080 -v $(abspath ratelimit.nginx.conf):/etc/nginx/nginx.conf:ro \
		nginx:1.31.4-trixie >/dev/null && echo "ratelimit up on :$(RL_PORT)"

ratelimit-down:
	-docker rm -f sec-ratelimit >/dev/null 2>&1 && echo "ratelimit down"

# S12: the Cloudflare Worker rate-limiter variant. Runs locally via wrangler
# dev (no deploy, no cost) in front of the same PostgREST container. Foreground
# by design - leave it in its own terminal, then `make probe`. ORIGIN is
# overridden with the actual PostgREST port.
ratelimit-worker-up:
	cd ratelimit-worker && wrangler dev --port $(RLW_PORT) --var ORIGIN:http://localhost:$(PGRST_PORT)

ratelimit-worker-down:
	-pkill -f 'wrangler dev --port $(RLW_PORT)' >/dev/null 2>&1 && echo "ratelimit-worker down"

# S20: an nginx edge that OVERWRITES X-Forwarded-For in front of the self-hosted
# PostgREST - the trust boundary S04's spoof test leaves open. Same pinned image
# as the rate limiter.
edge-up:
	docker rm -f sec-edge >/dev/null 2>&1 || true
	docker run -d --name sec-edge --add-host=host.docker.internal:host-gateway \
		-p $(EDGE_PORT):8081 -v $(abspath edge.nginx.conf):/etc/nginx/nginx.conf:ro \
		nginx:1.31.4-trixie >/dev/null && echo "edge up on :$(EDGE_PORT)"

edge-down:
	-docker rm -f sec-edge >/dev/null 2>&1 && echo "edge down"

probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@keys=$$(curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/api-keys?reveal=true"); \
	anon=$$(echo "$$keys" | jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	svc=$$(echo "$$keys" | jq -r '.[] | select(.name=="service_role") | .api_key' | head -1); \
	test -n "$$anon" -a -n "$$svc" || (echo "could not fetch anon/service_role keys"; exit 1); \
	PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
		SUPABASE_ANON_KEY="$$anon" SUPABASE_SERVICE_ROLE_KEY="$$svc" \
		PVLAB_DB_PASSWORD="$(PW)" \
		PVLAB_ENDPOINT_SELFHOSTED_POSTGREST="http://localhost:$(PGRST_PORT)" \
		PVLAB_ENDPOINT_RATELIMIT="http://localhost:$(RL_PORT)" \
		PVLAB_ENDPOINT_RATELIMIT_WORKER="http://localhost:$(RLW_PORT)" \
		PVLAB_ENDPOINT_EDGE="http://localhost:$(EDGE_PORT)" \
		$(ROOT)/harness/dist/pvlab --where local --experiment security-lockdown \
		--only "$(IDS)" --destructive --out evidence/$(TS)
	@echo "== evidence/$(TS)/run-<stamp>.md =="

# Redact a run artifact and publish it (plus facts.md) to the committed out/<date>/.
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(ONLY),--only $(ONLY),)

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy
