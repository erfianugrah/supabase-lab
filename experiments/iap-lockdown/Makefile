ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
REF := $(shell tofu output -raw project_ref 2>/dev/null)
TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS := $(shell date +%Y%m%d-%H%M%S)
IDS ?= L01,L02,L03,L04,L05,L06,L07,L08,L09

.PHONY: init fmt validate apply probe destroy worker-deploy worker-delete

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

# All L modules run from the local vantage against the shared tofu project.
# L01 is read-only; L02-L07 are destructive-but-restoring and sort after it,
# so one `--only L01..L07 --destructive` run executes them in id order.
probe:
	@test -n "$(REF)" || (echo "no project_ref output - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars - run 'make secrets-decrypt' at the root"; exit 1)
	@cd $(ROOT)/harness && bun run build >/dev/null
	@mkdir -p evidence/$(TS)
	@keys=$$(curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/api-keys?reveal=true"); \
	anon=$$(echo "$$keys" | jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	svc=$$(echo "$$keys" | jq -r '.[] | select(.name=="service_role") | .api_key' | head -1); \
	test -n "$$anon" -a -n "$$svc" || (echo "could not fetch anon/service_role keys"; exit 1); \
	PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
		SUPABASE_ANON_KEY="$$anon" SUPABASE_SERVICE_ROLE_KEY="$$svc" \
		PVLAB_ENDPOINT_OIDC_ISSUER="$$(tofu output -raw oidc_issuer_url 2>/dev/null)" \
		PVLAB_ENDPOINT_WORKER="https://$$(tofu output -raw proxy_hostname 2>/dev/null)" \
		CF_ACCESS_CLIENT_ID="$$(tofu output -raw svc_token_client_id 2>/dev/null)" \
		CF_ACCESS_CLIENT_SECRET="$$(tofu output -raw svc_token_client_secret 2>/dev/null)" \
		PVLAB_JWKS_DIR="$(abspath jwks)" \
		$(ROOT)/harness/dist/pvlab --where local --experiment iap-lockdown \
		--only "$(IDS)" --destructive --out evidence/$(TS)
	@echo "== evidence/$(TS)/run-<stamp>.md =="

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy

# --- Phase B: L11 proxy Worker (wrangler). Access apps come from tofu
# (enable_cloudflare). Deploy pushes the per-run project host + service key,
# neither of which is committed. Route hostname comes from the tofu output. ---
worker-deploy:
	@test -n "$(REF)" || (echo "no project_ref - run 'make apply' first"; exit 1)
	@host=$$(tofu output -raw proxy_hostname); \
	test -n "$$host" || (echo "no proxy_hostname output - is enable_cloudflare=true?"; exit 1); \
	svc=$$(curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(REF)/api-keys?reveal=true" \
		| jq -r '.[]|select(.name=="service_role")|.api_key'); \
	test -n "$$svc" || (echo "could not fetch service_role key"; exit 1); \
	printf '%s' "$$svc" | wrangler secret put SERVICE_KEY --name iap-lockdown-proxy; \
	wrangler deploy --var "UPSTREAM:https://$(REF).supabase.co"

worker-delete:
	-wrangler delete --name iap-lockdown-proxy --force
