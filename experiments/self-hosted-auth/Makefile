ROOT := $(abspath ../..)
VARS := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
REF := $(shell tofu output -raw project_ref 2>/dev/null)
REGION := $(shell tofu output -raw region 2>/dev/null || echo ap-southeast-1)
TOK := $(shell grep -E '^supabase_access_token' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
PW := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS := $(shell date +%Y%m%d-%H%M%S)
IDS ?= SH01,SH02,SH03,SH04,SH05
# OWNKEY=1 (gotrue-up) generates an ES256 key pair into evidence/ownkey/ and
# starts GoTrue signing with it, with the managed ES256 public key and the
# legacy HS256 secret as verify-only keys; SH06 publishes the public half from
# an Edge Function, registers it as third-party auth, and revokes the legacy
# key. Run SH06 alone on a fresh project (IDS=SH06).
# The managed project answered /auth/v1/health with v2.196.0 on 2026-09-02 and
# the public image exists at the same tag; matching it keeps the embedded
# migration set aligned with the auth schema the platform already applied
# (77 rows in auth.schema_migrations, latest 20260625000000; the v2.196.0
# image ships 70 files, all present in those rows; the v2.189.0 image the
# public self-hosting compose pins ships only 69 and is not what this Makefile
# runs).
GOTRUE_IMAGE ?= supabase/gotrue:v2.196.0
GOTRUE_PORT ?= 9999
GOTRUE_NAME ?= sha-gotrue

.PHONY: init fmt validate apply probe destroy gotrue-up gotrue-down gotrue-logs unit

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

unit:
	@cd $(ROOT) && bun test experiments/self-hosted-auth

# A GoTrue you run yourself, pointed at the managed project's Postgres through
# the SESSION pooler (IPv4; the direct host is IPv6-only). It connects as the
# `postgres` role: `supabase_auth_admin` is a reserved role on the platform
# (only superusers may set its password or grant membership), so the role the
# managed Auth service uses is not available to you. Signing secret is the
# project's legacy HS256 secret from GET /postgrest, so the tokens it mints are
# verifiable by the managed PostgREST for as long as that key stays
# `previously_used` rather than revoked. Issuer mirrors the managed one.
#
# JWKS=1 additionally hands GoTrue the managed project's ES256 PUBLIC key
# (from /auth/v1/.well-known/jwks.json, key_ops ["verify"]) alongside the
# HS256 secret as a sign+verify oct JWK, via GOTRUE_JWT_KEYS - a JSON array of
# JWKs, exactly one of which may carry key_ops "sign". That is what lets the
# self-hosted side verify tokens the MANAGED side minted (SH04). The mode is
# recorded in evidence/.gotrue-mode so `make probe` can export it.
#
# The oct key carries NO kid by default. With GOTRUE_JWT_KEYS set, the
# self-hosted GoTrue stamps its signing key's kid into every token header, and
# the managed PostgREST answered 401 PGRST301 to a self-hosted HS256 token
# carrying a kid - both an arbitrary one AND the platform's own HS256 key id
# from signing-keys - while the managed GoTrue verified the same tokens
# (measured 2026-09-02, projects 1 and 2). A kid-less HS256 token was accepted
# by both managed verifiers in plain mode (project 1) and in JWKS mode with
# this default kid-less oct key (project 3, evidence 20260902-150030). Pass
# OCT_KID=platform to reproduce the rejection.
gotrue-up:
	@test -n "$(REF)" || (echo "no project_ref - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars"; exit 1)
	@mkdir -p evidence
	@jwt=$$(curl -s -H "Authorization: Bearer $(TOK)" "https://api.supabase.com/v1/projects/$(REF)/postgrest" | jq -r .jwt_secret); \
	test -n "$$jwt" -a "$$jwt" != null || (echo "could not read the project's jwt_secret"; exit 1); \
	pooler="aws-0-$(REGION).pooler.supabase.com"; \
	keysenv=""; mode=plain; \
	if [ "$(OWNKEY)" = "1" ]; then \
	  bun lib/keygen.ts evidence/ownkey >/dev/null; \
	  priv=$$(cat evidence/ownkey/own-es256.private.json); \
	  anon=$$(curl -s -H "Authorization: Bearer $(TOK)" "https://api.supabase.com/v1/projects/$(REF)/api-keys" | jq -r '.[] | select(.name=="anon") | .api_key'); \
	  pub=$$(curl -s -H "apikey: $$anon" "https://$(REF).supabase.co/auth/v1/.well-known/jwks.json" | jq -c '[.keys[] | . + {key_ops:["verify"]}]'); \
	  octv=$$(printf '%s' "$$jwt" | basenc --base64url -w0 | tr -d '=' | jq -Rc '{kty:"oct",k:.,alg:"HS256",key_ops:["verify"]}'); \
	  keysenv=$$(jq -cn --argjson o "$$priv" --argjson p "$$pub" --argjson h "$$octv" '[$$o] + $$p + [$$h]'); mode=ownkey; \
	elif [ "$(JWKS)" = "1" ]; then \
	  anon=$$(curl -s -H "Authorization: Bearer $(TOK)" "https://api.supabase.com/v1/projects/$(REF)/api-keys" | jq -r '.[] | select(.name=="anon") | .api_key'); \
	  pub=$$(curl -s -H "apikey: $$anon" "https://$(REF).supabase.co/auth/v1/.well-known/jwks.json" | jq -c '[.keys[] | . + {key_ops:["verify"]}]'); \
	  if [ "$(OCT_KID)" = "platform" ]; then \
	    hskid=$$(curl -s -H "Authorization: Bearer $(TOK)" "https://api.supabase.com/v1/projects/$(REF)/config/auth/signing-keys" | jq -r '.keys[] | select(.algorithm=="HS256") | .id' | head -1); \
	    test -n "$$hskid" || (echo "OCT_KID=platform needs an HS256 signing key on the project to take its id from; none found"; exit 1); \
	    oct=$$(printf '%s' "$$jwt" | basenc --base64url -w0 | tr -d '=' | jq -Rc --arg kid "$$hskid" '{kty:"oct",k:.,alg:"HS256",kid:$$kid,key_ops:["sign","verify"]}'); \
	  else \
	    oct=$$(printf '%s' "$$jwt" | basenc --base64url -w0 | tr -d '=' | jq -Rc '{kty:"oct",k:.,alg:"HS256",key_ops:["sign","verify"]}'); \
	  fi; \
	  keysenv=$$(jq -cn --argjson o "$$oct" --argjson p "$$pub" '[$$o] + $$p'); mode=jwks; \
	fi; \
	echo "$$mode" > evidence/.gotrue-mode; \
	docker rm -f $(GOTRUE_NAME) >/dev/null 2>&1 || true; \
	docker run -d --name $(GOTRUE_NAME) -p $(GOTRUE_PORT):9999 \
		$${keysenv:+-e GOTRUE_JWT_KEYS="$$keysenv"} \
		-e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 \
		-e API_EXTERNAL_URL="https://$(REF).supabase.co/auth/v1" \
		-e GOTRUE_DB_DRIVER=postgres \
		-e GOTRUE_DB_DATABASE_URL="postgres://postgres.$(REF):$(PW)@$$pooler:5432/postgres?search_path=auth" \
		-e GOTRUE_DB_NAMESPACE=auth \
		-e GOTRUE_SITE_URL=http://localhost:3000 \
		-e GOTRUE_JWT_SECRET="$$jwt" \
		-e GOTRUE_JWT_ISSUER="https://$(REF).supabase.co/auth/v1" \
		-e GOTRUE_JWT_AUD=authenticated -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
		-e GOTRUE_JWT_ADMIN_ROLES=service_role -e GOTRUE_JWT_EXP=3600 \
		-e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_MAILER_AUTOCONFIRM=true \
		-e GOTRUE_DISABLE_SIGNUP=false \
		$(GOTRUE_IMAGE) >/dev/null && echo "gotrue ($(GOTRUE_IMAGE)) up on :$(GOTRUE_PORT)"

gotrue-logs:
	@docker logs $(GOTRUE_NAME) 2>&1 | sed -E 's#postgres\.[a-z]{20}:[^@]+@#postgres.<ref>:<pw>@#g' | tail -40

gotrue-down:
	-docker rm -f $(GOTRUE_NAME) >/dev/null 2>&1 && echo "gotrue down"

# Modules self-skip without PVLAB_ENDPOINT_SELFHOSTED_GOTRUE; run gotrue-up
# first. IDS=SH02 narrows the run. SH05 revokes a signing key and is last.
# BUILD=0 RUNNER="bun $(ROOT)/harness/src/run.ts" runs from source without
# recompiling dist/pvlab - needed when another experiment's battery is running
# from that binary (Linux refuses to overwrite a running executable).
RUNNER ?= $(ROOT)/harness/dist/pvlab
BUILD ?= 1
probe:
	@test -n "$(REF)" || (echo "no project_ref - run 'make apply' first"; exit 1)
	@test -n "$(TOK)" || (echo "no PAT in $(ROOT)/secrets.tfvars"; exit 1)
	@if [ "$(BUILD)" = "1" ]; then cd $(ROOT)/harness && bun run build >/dev/null; else cd $(ROOT)/harness && bun run gen >/dev/null; fi
	@mkdir -p evidence/$(TS)
	@keys=$$(curl -s -H "Authorization: Bearer $(TOK)" "https://api.supabase.com/v1/projects/$(REF)/api-keys?reveal=true"); \
	anon=$$(echo "$$keys" | jq -r '.[] | select(.name=="anon") | .api_key' | head -1); \
	svc=$$(echo "$$keys" | jq -r '.[] | select(.name=="service_role") | .api_key' | head -1); \
	gotrue=""; docker inspect $(GOTRUE_NAME) >/dev/null 2>&1 && gotrue="http://localhost:$(GOTRUE_PORT)"; \
	mode=$$(cat evidence/.gotrue-mode 2>/dev/null || echo plain); \
	ownpub=""; test -f evidence/ownkey/own-es256.public.json && ownpub=$$(base64 -w0 < evidence/ownkey/own-es256.public.json); \
	PVLAB_REF="$(REF)" SUPABASE_ACCESS_TOKEN="$(TOK)" DB_PASSWORD="$(PW)" \
		SUPABASE_ANON_KEY="$$anon" SUPABASE_SERVICE_ROLE_KEY="$$svc" \
		PVLAB_ENDPOINT_SELFHOSTED_GOTRUE="$$gotrue" \
		PVLAB_ENDPOINT_SELFHOSTED_GOTRUE_MODE="$$mode" \
		PVLAB_ENDPOINT_OWNKEY_PUBLIC_JWK="$$ownpub" \
		PVLAB_ENDPOINT_POOLER="aws-0-$(REGION).pooler.supabase.com" \
		$(RUNNER) --where local --experiment self-hosted-auth \
		--destructive --only $(IDS) --out evidence/$(TS)
	@echo "== evidence/$(TS) =="

destroy:
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy
