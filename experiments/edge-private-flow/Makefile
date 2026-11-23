# edge-private-flow: client -> front Worker -> Edge Function -> mTLS / JWT upstream.
#
# Whole run (project + Workers + probe), from this directory:
#   sx SUPABASE_ACCESS_TOKEN CLOUDFLARE_WORKERS_TOKEN=CLOUDFLARE_WORKERS_TOKEN CLOUDFLARE_ACCOUNT_ID -- make all
# Teardown:
#   sx SUPABASE_ACCESS_TOKEN CLOUDFLARE_WORKERS_TOKEN=CLOUDFLARE_WORKERS_TOKEN CLOUDFLARE_ACCOUNT_ID -- make destroy
#
# certs/ (gitignored) must hold badssl-client.{crt,key} (public test cert from
# https://badssl.com/certs/badssl.com-client.pem, passphrase badssl.com) and
# client-named.{crt,key} (a named-curve P-256 client cert from a throwaway CA):
# `make certs` builds both.
ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
REF = $(shell tofu output -raw project_ref 2>/dev/null)
URL = https://$(REF).supabase.co
export CLOUDFLARE_API_TOKEN ?= $(CLOUDFLARE_WORKERS_TOKEN)
WURL = $(shell cat evidence/$(1).url 2>/dev/null)

.PHONY: all certs apply upstream setup function front probe run2 cf-up gateway setup2 probe2 run3 cf3-up setup3 probe3 full repeat destroy

all: apply upstream setup function front probe

certs:
	@mkdir -p certs && cd certs && \
	curl -sS -o badssl-client.pem https://badssl.com/certs/badssl.com-client.pem && \
	openssl x509 -in badssl-client.pem -out badssl-client.crt && \
	openssl pkey -in badssl-client.pem -passin pass:badssl.com -out badssl-client.key && \
	openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=lab-test-ca" -keyout ca.key -out ca.crt 2>/dev/null && \
	openssl ecparam -name prime256v1 -genkey -noout -out client-named.key && \
	openssl req -new -key client-named.key -subj "/CN=lab-edge-function-client-ec" -out client-named.csr && \
	printf 'extendedKeyUsage=clientAuth\n' > ext.cnf && \
	openssl x509 -req -in client-named.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 -extfile ext.cnf -out client-named.crt 2>/dev/null

apply:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "SUPABASE_ACCESS_TOKEN required"; exit 1)
	TF_VAR_supabase_access_token="$$SUPABASE_ACCESS_TOKEN" tofu apply -auto-approve -input=false $(VARS)

upstream:
	@mkdir -p evidence
	cd workers/upstream && bun install --silent && \
	wrangler deploy --var SUPABASE_URL:$(URL) 2>&1 | tee ../../evidence/upstream.deploy.log | grep -o 'https://[^ ]*workers.dev' | head -1 > ../../evidence/upstream.url
	@cat evidence/upstream.url

setup:
	REF=$(REF) UPSTREAM_JWT_URL=$(call WURL,upstream) bun setup.ts

function:
	supabase functions deploy relay --remote=$(REF) --no-verify-jwt --use-api --yes

front:
	cd workers/front && wrangler deploy --var SUPABASE_URL:$(URL) 2>&1 | tee ../../evidence/front.deploy.log | grep -o 'https://[^ ]*workers.dev' | head -1 > ../../evidence/front.url
	jq -r .front evidence/state.json | (cd workers/front && wrangler secret put FRONT_SECRET)
	@cat evidence/front.url

probe:
	FRONT_URL=$(call WURL,front) bun probe.ts

# Run 2: integration-gateway stand-in on <zone> hostnames (mTLS via the
# Cloudflare-managed CA + JWT; and an Access service-token host), plus runtime
# arms (proxy option, HTTPS_PROXY secret, v1 cert, explicit-params EC key,
# caller-address headers, reused vs new HttpClient). Needs CLOUDFLARE_EMAIL +
# CLOUDFLARE_API_KEY (zone-level writes; the Workers token cannot) on top of
# the run-1 env:
#   sx SUPABASE_ACCESS_TOKEN CLOUDFLARE_EMAIL CLOUDFLARE_API_KEY -- make run2
run2: cf-up gateway setup2 function probe2

cf-up:
	@mkdir -p evidence certs
	bun cf.ts up

gateway:
	cd workers/gateway && bun install --silent && env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=$$(bun ../../zone-account.ts) wrangler deploy --var SUPABASE_URL:$(URL)

setup2:
	bun setup2.ts

probe2:
	FRONT_URL=$(call WURL,front) bun probe2.ts

# Run 3: gateway trusting OUR OWN CA only (Cloudflare BYO CA, Enterprise zone),
# Cloudflare Tunnel + Access to a local origin (no inbound port; probe3 starts
# the origin and cloudflared itself), region from abroad, cert rotation without
# redeploy, latency rounds. Same env as run 2.
run3: cf3-up gateway setup3 probe3

cf3-up:
	@mkdir -p evidence certs
	bun cf3.ts up

setup3:
	bun setup3.ts

probe3:
	FRONT_URL=$(call WURL,front) bun probe3.ts

# Everything from a clean slate, with runs 1 and 2 repeated after run 3:
#   sx SUPABASE_ACCESS_TOKEN CLOUDFLARE_EMAIL CLOUDFLARE_API_KEY CLOUDFLARE_WORKERS_TOKEN=CLOUDFLARE_WORKERS_TOKEN CLOUDFLARE_ACCOUNT_ID -- make full
full: apply upstream setup function front cf-up cf3-up gateway setup2 setup3 probe probe2 probe3 repeat

repeat:
	FRONT_URL=$(call WURL,front) bun probe.ts
	FRONT_URL=$(call WURL,front) bun probe2.ts

# Redacted copies + facts table of evidence/run*-<DATE>*.json into out/<DATE>/.
# CLIENT_IP=<the probing machine's address> so it is masked too.
publish-evidence:
	@test -n "$(DATE)" || (echo "DATE=YYYY-MM-DD required"; exit 1)
	bun publish.ts $(DATE)

destroy:
	-cd workers/gateway && env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=$$(bun ../../zone-account.ts) wrangler delete --force
	-test -f evidence/cf3.json && bun cf3.ts down
	-test -f evidence/cf.json && bun cf.ts down
	-cd workers/front && wrangler delete --force
	-cd workers/upstream && wrangler delete --force
	TF_VAR_supabase_access_token="$$SUPABASE_ACCESS_TOKEN" tofu destroy -auto-approve -input=false $(VARS)
