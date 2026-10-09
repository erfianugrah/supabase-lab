ROOT  := $(abspath ../..)
VARS  := -var-file=$(ROOT)/secrets.tfvars -var-file=experiment.tfvars
# -json, not -raw: with no state, -raw prints its "No outputs found" warning to
# stdout, which would land in these variables instead of leaving them empty.
LIVE  := $(shell tofu output -json 2>/dev/null | jq -r '.live_ref.value // empty' 2>/dev/null)
READY := $(shell tofu output -json 2>/dev/null | jq -r '.ready_ref.value // empty' 2>/dev/null)
REGION := $(shell tofu output -json 2>/dev/null | jq -r '.region.value // empty' 2>/dev/null)
PW    := $(shell grep -E '^db_password' $(ROOT)/secrets.tfvars 2>/dev/null | cut -d'"' -f2)
TS    := $(shell date +%Y%m%d-%H%M%S)

# The harness build is linux-x64 only; elsewhere run the same entry from source.
ifeq ($(shell uname -s),Linux)
RUNNER := $(ROOT)/harness/dist/pvlab
BUILD  := cd $(ROOT)/harness && bun run build >/dev/null
else
RUNNER := bun $(ROOT)/harness/src/run.ts
BUILD  := cd $(ROOT)/harness && bun scripts/gen-registry.ts >/dev/null
endif

# PAT from the ENVIRONMENT, never secrets.tfvars - see pdf-corpus-graph/Makefile
# for why a placeholder in the var-file must not be quoted.
TOK := $(SUPABASE_ACCESS_TOKEN)
export TF_VAR_supabase_access_token = $(TOK)
export SUPABASE_ACCESS_TOKEN = $(TOK)

BASE := sql/00-baseline.sql
APP  := sql/10-app.sql sql/20-agent.sql

# Which project the web app points at. ready by default (seeded example app);
# APP_REF=$(LIVE) after a live build.
APP_REF ?= $(READY)

.PHONY: init fmt validate apply guard-tok wait-ready schema seed seed-ready fn-deploy kb-embed pooler probe up destroy \
	app-env app-dev app-deploy app-delete guard-live mcp-config live-workspace live-reset

init:
	tofu init

fmt:
	tofu fmt -recursive $(ROOT)

validate:
	tofu validate

apply: guard-tok
	tofu plan $(VARS) -out=tfplan
	tofu apply tfplan
	@echo "live_ref  = $$(tofu output -raw live_ref)"
	@echo "ready_ref = $$(tofu output -raw ready_ref)"

guard-tok:
	@test -n "$(TOK)" || (echo "no SUPABASE_ACCESS_TOKEN in the environment - export a live PAT (the one in secrets.tfvars is a placeholder by design)"; exit 1)

# Per-service health, then a pause past the first-write window (AGENTS.md,
# "ACTIVE_HEALTHY is not readiness"). Both projects.
wait-ready: guard-tok
	@test -n "$(LIVE)" -a -n "$(READY)" || (echo "no refs - run 'make apply' first"; exit 1)
	@for ref in $(LIVE) $(READY); do \
		printf "waiting for $$ref"; \
		for i in $$(seq 1 60); do \
			s=$$(curl -s -H "Authorization: Bearer $(TOK)" \
				"https://api.supabase.com/v1/projects/$$ref/health?services=db&services=rest&services=auth" \
				| jq -r '[.[].status] | unique | join(",")' 2>/dev/null); \
			if [ "$$s" = "ACTIVE_HEALTHY" ]; then printf ' healthy\n'; break; fi; \
			printf '.'; sleep 10; \
			if [ $$i -eq 60 ]; then printf '\ntimed out\n'; exit 1; fi; \
		done; \
	done; sleep 20

# live: baseline only - the app schema is the coding agent's to write.
# ready: baseline + example app + agent schema.
schema: guard-tok
	bun scripts/kit.ts schema $(LIVE) $(BASE)
	bun scripts/kit.ts schema $(READY) $(BASE) $(APP)

seed: guard-tok
	bun scripts/kit.ts seed $(LIVE)
	$(MAKE) --no-print-directory seed-ready

seed-ready: guard-tok
	bun scripts/kit.ts seed $(READY) --app

# In-app agent Edge Function (supabase/functions/agent) on the ready project.
# --use-api bundles server-side (no Docker); verify_jwt stays at its default
# (on). The LLM step needs ANTHROPIC_API_KEY as a function secret, set
# separately: everything else (tool layer, embeddings) works without it.
fn-deploy: guard-tok
	supabase functions deploy agent --project-ref $(READY) --workdir . --use-api

# Real gte-small embeddings for kb_chunks, via the function's embed mode.
kb-embed: guard-tok
	bun scripts/kit.ts embed $(READY)

# Array response, one entry per database - select the PRIMARY (see
# pdf-corpus-graph/Makefile).
pooler:
	@curl -s -H "Authorization: Bearer $(TOK)" \
		"https://api.supabase.com/v1/projects/$(READY)/config/database/pooler" \
		| jq -r '[.[] | select(.database_type=="PRIMARY")][0].db_host // empty'

# The RLS matrix runs against the ready project.
probe: guard-tok
	@test -n "$(READY)" || (echo "no ready_ref - run 'make apply' first"; exit 1)
	@$(BUILD)
	@mkdir -p evidence/$(TS)
	@PVLAB_REF="$(READY)" SUPABASE_ACCESS_TOKEN="$(TOK)" \
	 DB_PASSWORD="$(PW)" PVLAB_REGION="$(REGION)" \
	 PVLAB_ENDPOINT_POOLER="$$($(MAKE) --no-print-directory pooler)" \
		$(RUNNER) --where local $(ONLY) \
		--experiment governed-starter-kit --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# --- web app (app/, Next.js on Workers via OpenNext) ---
app-env: guard-tok
	@test -n "$(APP_REF)" || (echo "no project ref - run 'make apply' first"; exit 1)
	bun scripts/kit.ts env $(APP_REF)

app-dev: app-env
	cd app && bun install && bun run dev

# Needs wrangler auth (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, or
# `wrangler login`). Deploys to workers.dev only - no custom domain to clean up.
app-deploy: app-env
	cd app && bun install && bun run deploy

app-delete:
	-cd app && wrangler delete starter-kit-app

# --- live segment: a coding agent builds a new app on kit-live ---
# See docs/LIVE-SEGMENT.md. The MCP server is scoped to the live project with
# project_ref; refs never go in committed files, so the config is generated.
MCP_FEATURES := database,debugging,development,docs
WORKSPACE ?= $(HOME)/kit-live-demo

guard-live:
	@test -n "$(LIVE)" -a -n "$(READY)" || (echo "no refs - run 'make apply' first"; exit 1)
	@test "$(LIVE)" != "$(READY)" || (echo "live and ready refs are the same - refusing"; exit 1)

# Writes live/.mcp.json (gitignored) from the committed template.
mcp-config: guard-live
	@sed -e 's/<project-ref>/$(LIVE)/' -e 's/features=[a-z,]*/features=$(MCP_FEATURES)/' \
		live/.mcp.json.example > live/.mcp.json
	@jq -e '.mcpServers.supabase.url | test("project_ref=$(LIVE)&")' live/.mcp.json >/dev/null \
		&& echo "live/.mcp.json written (scoped to the live project; features=$(MCP_FEATURES))"
	@mkdir -p live/.codex && sed -e 's/<project-ref>/$(LIVE)/' -e 's/features=[a-z,]*/features=$(MCP_FEATURES)/' \
		live/.codex/config.toml.example > live/.codex/config.toml \
		&& echo "live/.codex/config.toml written (Codex, same scope)"

# The agent's working directory, OUTSIDE this repo: the repo-root AGENTS.md
# (lab notes, far past an agent's instruction budget), tofu state and the
# seeded passwords in evidence/ should not be in its view. Fresh git repo so
# the agent's diff can be shown on screen.
live-workspace: mcp-config
	@test ! -e "$(WORKSPACE)" || test -z "$$(ls -A "$(WORKSPACE)")" \
		|| (echo "$(WORKSPACE) exists and is not empty - remove it or pass WORKSPACE=..."; exit 1)
	mkdir -p "$(WORKSPACE)/kit"
	cp live/AGENTS.md live/CLAUDE.md live/.mcp.json "$(WORKSPACE)/"
	mkdir -p "$(WORKSPACE)/.codex" && cp live/.codex/config.toml "$(WORKSPACE)/.codex/"
	cp $(BASE) "$(WORKSPACE)/kit/00-baseline.sql"
	cp sql/10-app.sql "$(WORKSPACE)/kit/10-app.sql"
	printf '.mcp.json\n.codex/config.toml\n.env*\n!.env.example\nnode_modules/\n.next/\n' > "$(WORKSPACE)/.gitignore"
	cd "$(WORKSPACE)" && git init -q && git add -A && git commit -q -m "kit workspace" \
		&& echo "workspace ready: $(WORKSPACE)"

# Back to baseline-only between rehearsals. Lists what it would drop; with
# APPLY=1 it lists, drops, reapplies sql/00-baseline.sql and re-checks.
# Never touches the ready project; seeded users and profiles are kept.
live-reset: guard-tok guard-live
	bun scripts/live-reset.ts $(LIVE) $(READY) $(if $(APPLY),--apply,)

# Zero to a seeded, tested pair of projects in one command. The app deploy is
# separate (make app-deploy) because it needs Cloudflare credentials.
up: guard-tok
	$(MAKE) init
	$(MAKE) apply
	$(MAKE) wait-ready
	$(MAKE) schema
	$(MAKE) seed
	$(MAKE) fn-deploy
	$(MAKE) integrations
	$(MAKE) kb-embed
	$(MAKE) probe

destroy: guard-tok
	$(MAKE) --no-print-directory app-delete
	tofu plan -destroy $(VARS) -out=tfplan-destroy
	tofu apply tfplan-destroy

# --- agent chat (fn-secret) ---
# Sets ANTHROPIC_API_KEY as a function secret on the ready project, read from
# the vault item named by ANTHROPIC_ITEM. The value never reaches argv or
# stdout: sx injects it into one child's environment, printf (a shell builtin)
# writes it to a pipe, and the CLI reads it as an env file on stdin. Run as
#   sx SUPABASE_ACCESS_TOKEN -- make fn-secret ANTHROPIC_ITEM=<vault item>
# Secrets apply to new invocations without a redeploy.
.PHONY: fn-secret
fn-secret: guard-tok
	@test -n "$(READY)" || (echo "no ready_ref - run 'make apply' first"; exit 1)
	@test -n "$(ANTHROPIC_ITEM)" || (echo "set ANTHROPIC_ITEM=<vault item holding the Anthropic API key>"; exit 1)
	@sx ANTHROPIC_API_KEY=$(ANTHROPIC_ITEM) -- sh -c \
		'test -n "$$ANTHROPIC_API_KEY" || { echo "vault item is empty"; exit 1; }; \
		 printf "ANTHROPIC_API_KEY=%s\n" "$$ANTHROPIC_API_KEY" \
		   | supabase secrets set --env-file /dev/stdin --project-ref "$$0" >/dev/null' $(READY)
	@curl -s -H "Authorization: Bearer $$SUPABASE_ACCESS_TOKEN" \
		"https://api.supabase.com/v1/projects/$(READY)/secrets" \
		| jq -e 'any(.[]; .name == "ANTHROPIC_API_KEY")' >/dev/null \
		&& echo "ANTHROPIC_API_KEY set on the ready project" \
		|| (echo "ANTHROPIC_API_KEY not listed after set"; exit 1)

# --- integrations ---
# Purchase decisions -> external system (sql/30-integrations.sql, pg_net from
# an AFTER UPDATE trigger) -> the webhook-sink Edge Function on the ready
# project. Applies the SQL, deploys the sink with JWT verification off (the
# caller is the database; the sink checks a shared secret instead), then
# generates a fresh shared secret and stores it on both sides: as the
# WEBHOOK_SINK_SECRET function secret and, with the sink URL, in Vault. The
# secret never reaches argv or stdout (both writes read it from stdin).
# Re-running rotates it. Run as
#   sx SUPABASE_ACCESS_TOKEN -- make integrations
# Optional Slack forward: set SLACK_WEBHOOK_URL as a function secret yourself.
.PHONY: integrations
integrations: guard-tok
	@test -n "$(READY)" || (echo "no ready_ref - run 'make apply' first"; exit 1)
	bun scripts/kit.ts schema $(READY) sql/30-integrations.sql
	supabase functions deploy webhook-sink --project-ref $(READY) --workdir . --use-api --no-verify-jwt
	@sh -c 'set -e; s=$$(openssl rand -hex 32); \
		printf "WEBHOOK_SINK_SECRET=%s\n" "$$s" \
		  | supabase secrets set --env-file /dev/stdin --project-ref "$$0" >/dev/null; \
		printf "https://%s.supabase.co/functions/v1/webhook-sink\n%s\n" "$$0" "$$s" \
		  | jq -Rn "([39]|implode) as \$$q | [inputs] | {query: (\"select private.put_integration_secret(\" + \$$q + \"webhook_sink_url\" + \$$q + \", \" + \$$q + .[0] + \$$q + \"), private.put_integration_secret(\" + \$$q + \"webhook_sink_secret\" + \$$q + \", \" + \$$q + .[1] + \$$q + \")\")}" \
		  | curl -sf -o /dev/null -X POST -H "Authorization: Bearer $$SUPABASE_ACCESS_TOKEN" \
		      -H "Content-Type: application/json" --data-binary @- \
		      "https://api.supabase.com/v1/projects/$$0/database/query"' $(READY)
	@curl -s -H "Authorization: Bearer $$SUPABASE_ACCESS_TOKEN" \
		"https://api.supabase.com/v1/projects/$(READY)/secrets" \
		| jq -e 'any(.[]; .name == "WEBHOOK_SINK_SECRET")' >/dev/null \
		&& echo "WEBHOOK_SINK_SECRET set on the ready project" \
		|| (echo "WEBHOOK_SINK_SECRET not listed after set"; exit 1)
	@jq -n '([39]|implode) as $$q | {query: ("select count(*) as n from vault.secrets where name in (" + $$q + "webhook_sink_url" + $$q + ", " + $$q + "webhook_sink_secret" + $$q + ")")}' \
		| curl -s -X POST -H "Authorization: Bearer $$SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
		  --data-binary @- "https://api.supabase.com/v1/projects/$(READY)/database/query" \
		| jq -e '.[0].n == 2' >/dev/null \
		&& echo "webhook_sink_url and webhook_sink_secret in Vault" \
		|| (echo "Vault entries missing"; exit 1)

# --- deploy + provisioning ---
# Self-service backends: `make new-app NAME=<slug>` turns a request into a
# guarded project (supabase_project.app in supabase.tf) in the same Team org:
# plan, apply, health, kit baseline, RLS check, then the URL and publishable
# key. The request list is apps.auto.tfvars (gitignored; tofu reads
# *.auto.tfvars on every plan), so `make apply` and `make destroy` see the
# same apps. Every plan is saved and checked before it is applied: anything
# other than the one intended create (or delete) - a change to kit-live or
# kit-ready included - aborts and restores the request list. PLAN=1 stops
# after the checked plan so it can be read first. Run as
#   sx SUPABASE_ACCESS_TOKEN -- make new-app NAME=demo1 [PLAN=1]
#   sx SUPABASE_ACCESS_TOKEN -- make remove-app NAME=demo1 [PLAN=1]
APPS_FILE := apps.auto.tfvars
APPS      := $(shell grep -oE '"[a-z][a-z0-9-]*"' $(APPS_FILE) 2>/dev/null | tr -d '"')
APP_ADDR   = supabase_project.app["$(NAME)"]
MGMT       = https://api.supabase.com/v1/projects
RLS_SQL    = select count(*) filter (where relrowsecurity) as rls_on, count(*) as tables from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'

.PHONY: guard-name apps apps-restore new-app app-ready remove-app

guard-name:
	@echo "$(NAME)" | grep -Eq '^[a-z][a-z0-9-]{0,19}$$' \
		|| (echo "NAME=<slug> required: a lowercase letter, then up to 19 of a-z 0-9 -"; exit 1)

# slug -> ref for every self-service app in state.
apps:
	@tofu output -json app_refs 2>/dev/null | jq -r 'to_entries[] | "\(.key)\t\(.value)"'

apps-restore:
	@if [ -f $(APPS_FILE).bak ]; then mv $(APPS_FILE).bak $(APPS_FILE); else rm -f $(APPS_FILE); fi

# $(1) = the new request list, $(2) = the one action the plan may contain.
define apps_plan
	@if [ -f $(APPS_FILE) ]; then cp $(APPS_FILE) $(APPS_FILE).bak; else rm -f $(APPS_FILE).bak; fi
	@if [ -n "$(strip $(1))" ]; then \
		{ echo 'extra_apps = ['; for n in $(1); do echo "  \"$$n\","; done; echo ']'; } > $(APPS_FILE); \
	else rm -f $(APPS_FILE); fi
	@tofu plan $(VARS) -out=tfplan-app >/dev/null || { $(MAKE) --no-print-directory apps-restore; exit 1; }
	@tofu show -json tfplan-app | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | "plan: \(.change.actions | join(",")) \(.address)"'
	@tofu show -json tfplan-app | jq -e --arg a '$(APP_ADDR)' --arg act '$(2)' \
		'[.resource_changes[] | select(.change.actions != ["no-op"])] | length == 1 and .[0].address == $$a and .[0].change.actions == [$$act]' >/dev/null \
		|| { echo "plan is not exactly one $(2) of $(APP_ADDR) - not applying"; rm -f tfplan-app; $(MAKE) --no-print-directory apps-restore; exit 1; }
endef

new-app: guard-tok guard-name
	@! echo " $(APPS) " | grep -q " $(NAME) " || (echo "$(NAME) already requested - make apps"; exit 1)
	@date +%s > .new-app-t0
	$(call apps_plan,$(APPS) $(NAME),create)
ifeq ($(PLAN),)
	@out=$$(tofu apply -no-color tfplan-app 2>&1) || { echo "$$out"; rm -f tfplan-app; exit 1; }; echo "$$out" | tail -1
	@rm -f tfplan-app $(APPS_FILE).bak
	@$(MAKE) --no-print-directory app-ready NAME=$(NAME)
else
	@echo "checked plan saved to tfplan-app. To go on:"
	@echo "  tofu apply tfplan-app && rm -f tfplan-app $(APPS_FILE).bak && make app-ready NAME=$(NAME)"
	@echo "To abandon: rm tfplan-app && make apps-restore"
endif

# Health (db, rest, auth), kit baseline, RLS on every public table, then what
# the requesting team needs. The publishable key is safe to hand out; RLS is
# what protects the data.
app-ready: guard-tok guard-name
	@ref=$$(tofu output -json app_refs | jq -r --arg n '$(NAME)' '.[$$n] // empty'); \
	test -n "$$ref" || { echo "no app $(NAME) in state - make apps"; exit 1; }; \
	printf "waiting for health"; \
	for i in $$(seq 1 60); do \
		s=$$(curl -s -H "Authorization: Bearer $(TOK)" \
			"$(MGMT)/$$ref/health?services=db&services=rest&services=auth" \
			| jq -r '[.[].status] | unique | join(",")' 2>/dev/null); \
		if [ "$$s" = "ACTIVE_HEALTHY" ]; then printf ' healthy\n'; break; fi; \
		printf '.'; sleep 5; \
		if [ $$i -eq 60 ]; then printf '\ntimed out\n'; exit 1; fi; \
	done; \
	bun scripts/kit.ts schema $$ref $(BASE) || exit 1; \
	rls=$$(jq -n --arg q "$(RLS_SQL)" '{query: $$q}' \
		| curl -s -X POST -H "Authorization: Bearer $(TOK)" -H "Content-Type: application/json" \
			--data-binary @- "$(MGMT)/$$ref/database/query" \
		| jq -r '.[0] | "\(.rls_on)/\(.tables)"'); \
	echo "baseline: RLS on $$rls public tables"; \
	[ "$${rls%/*}" = "$${rls#*/}" ] && [ "$${rls#*/}" != "0" ] || { echo "baseline check FAILED"; exit 1; }; \
	pub=$$(curl -s -H "Authorization: Bearer $(TOK)" "$(MGMT)/$$ref/api-keys?reveal=true" \
		| jq -r '[.[] | select(.type == "publishable")][0].api_key // empty'); \
	echo "project:          kit-app-$(NAME)"; \
	echo "url:              https://$$ref.supabase.co"; \
	echo "publishable key:  $$pub"; \
	if [ -f .new-app-t0 ]; then echo "request to ready: $$(( $$(date +%s) - $$(cat .new-app-t0) )) s"; rm -f .new-app-t0; fi

# Deletes the project and its data - throwaway apps only.
remove-app: guard-tok guard-name
	@echo " $(APPS) " | grep -q " $(NAME) " || (echo "$(NAME) is not in $(APPS_FILE) - make apps"; exit 1)
	$(call apps_plan,$(filter-out $(NAME),$(APPS)),delete)
ifeq ($(PLAN),)
	@out=$$(tofu apply -no-color tfplan-app 2>&1) || { echo "$$out"; rm -f tfplan-app; exit 1; }; echo "$$out" | tail -1
	@rm -f tfplan-app $(APPS_FILE).bak
else
	@echo "checked plan saved to tfplan-app. To go on: tofu apply tfplan-app && rm -f tfplan-app $(APPS_FILE).bak"
	@echo "To abandon: rm tfplan-app && make apps-restore"
endif

# The live segment's deploy step (docs/LIVE-SEGMENT.md, prompt step 5): the
# agent's create-next-app with-supabase scaffold in $(WORKSPACE)/web, on
# Cloudflare Workers at $(LIVE_WORKER).<subdomain>.workers.dev. Wrangler auth
# from the environment (CLOUDFLARE_API_TOKEN or the email + global key pair,
# plus CLOUDFLARE_ACCOUNT_ID).
#
# live-app-prep runs at setup, off stage, right after the scaffold: the
# OpenNext adapter (`@opennextjs/cloudflare migrate`), then three changes
# that measured necessary on 2026-10-07: next pinned to $(LIVE_NEXT) (with
# next 16.4.0, OpenNext 1.20.9 builds and deploys but every page 500s on
# "Unexpected loadManifest(/.next/server/preview-props.json)"), the
# template's `cacheComponents: true` removed (with it, pages hang until the
# Workers runtime cancels them), and the migrate defaults trimmed to a
# plain Worker - no R2 incremental-cache bucket, image binding or
# self-reference service to create and clean up. After it, the deploy on
# stage is one `npm run deploy`.
LIVE_WEB    ?= $(WORKSPACE)/web
LIVE_WORKER ?= kit-live-app
LIVE_NEXT   ?= 16.3.8

.PHONY: live-app-prep live-app-deploy live-app-delete

live-app-prep:
	@test -f "$(LIVE_WEB)/package.json" || (echo "no app in $(LIVE_WEB) - scaffold it first"; exit 1)
	cd "$(LIVE_WEB)" && npm install next@$(LIVE_NEXT) \
		&& npx --yes @opennextjs/cloudflare migrate
	cd "$(LIVE_WEB)" && printf '%s\n' '{' \
		'  "$$schema": "node_modules/wrangler/config-schema.json",' \
		'  "name": "$(LIVE_WORKER)",' \
		'  "main": ".open-next/worker.js",' \
		'  "compatibility_date": "$(shell date +%Y-%m-%d)",' \
		'  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],' \
		'  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" }' \
		'}' > wrangler.jsonc \
		&& printf '%s\n' 'import { defineCloudflareConfig } from "@opennextjs/cloudflare";' '' \
			'export default defineCloudflareConfig({});' > open-next.config.ts \
		&& sed -i.orig '/cacheComponents: true,/d' next.config.ts && rm -f next.config.ts.orig
	@cd "$(LIVE_WEB)" && ! grep -q cacheComponents next.config.ts \
		&& grep -q '"name": "$(LIVE_WORKER)"' wrangler.jsonc \
		&& echo "$(LIVE_WEB) ready to deploy as $(LIVE_WORKER) (commit it in the workspace)"

# The operator's fallback for step 5 - the same command the agent runs.
live-app-deploy:
	@test -f "$(LIVE_WEB)/wrangler.jsonc" || (echo "run make live-app-prep first"; exit 1)
	@test -f "$(LIVE_WEB)/.env.local" || (echo "no $(LIVE_WEB)/.env.local - the build needs the URL and publishable key"; exit 1)
	cd "$(LIVE_WEB)" && npm run deploy

# By name, so it works after the workspace is gone.
live-app-delete:
	-wrangler delete $(LIVE_WORKER)

# --- observability faults ---
# Reversible faults on the READY project for the troubleshooting segment
# (docs/OBSERVABILITY.md, scripts/faults.ts, sql/40-faults.sql). The live
# project is refused. FAULT = slow-activity | summary-error | all.
.PHONY: fault-inject fault-traffic fault-check fault-timing fault-clear fault-workspace
FAULT ?= all
FAULT_RUN = KIT_LIVE_REF="$(LIVE)" bun scripts/faults.ts

fault-inject: guard-tok guard-live
	@$(FAULT_RUN) inject $(READY) $(FAULT)

# App-path calls as alice and bob, so logs and Query Performance have traffic.
fault-traffic: guard-tok guard-live
	@$(FAULT_RUN) traffic $(READY) $(or $(ROUNDS),5)

# Traffic, then advisors + logs + pg_stat_statements; waits for log ingestion.
# With no faults injected it runs the clean check only (no traffic).
fault-check: guard-tok guard-live
	@if ls evidence/faults-$(READY).json >/dev/null 2>&1; then $(FAULT_RUN) traffic $(READY) $(or $(ROUNDS),5); fi
	@$(FAULT_RUN) check $(READY) --wait

# EXPLAIN ANALYZE as alice/bob, as injected and with the fix (rolled back).
fault-timing: guard-tok guard-live
	@DB_PASSWORD="$(PW)" POOLER_HOST="$$($(MAKE) --no-print-directory pooler)" $(FAULT_RUN) timing $(READY)

fault-clear: guard-tok guard-live
	@$(FAULT_RUN) clear $(READY)

# The troubleshooting agent's working directory: an MCP config scoped to the
# READY project (the live segment's config points at kit-live), with the
# groups this segment needs - database (execute_sql, apply_migration),
# debugging (get_logs, query_logs, get_advisors), docs.
OBS_WORKSPACE ?= $(HOME)/kit-ready-obs
fault-workspace: guard-live
	@test ! -e "$(OBS_WORKSPACE)" || test -z "$$(ls -A "$(OBS_WORKSPACE)")" \
		|| (echo "$(OBS_WORKSPACE) exists and is not empty - remove it or pass OBS_WORKSPACE=..."; exit 1)
	@mkdir -p "$(OBS_WORKSPACE)"
	@sed -e 's/<project-ref>/$(READY)/' -e 's/features=[a-z,]*/features=database,debugging,docs/' \
		live/.mcp.json.example > "$(OBS_WORKSPACE)/.mcp.json"
	@jq -e '.mcpServers.supabase.url | test("project_ref=$(READY)&")' "$(OBS_WORKSPACE)/.mcp.json" >/dev/null \
		&& echo "$(OBS_WORKSPACE)/.mcp.json written (scoped to the ready project; features=database,debugging,docs)"

# --- stage agent ---
# Claude Code in the live workspace with no operator hooks, CLAUDE.md, MCP
# servers or plugins (isolated CLAUDE_CONFIG_DIR). DRY=1 prints the command.
.PHONY: stage-agent
stage-agent:
	scripts/stage-agent.sh $(if $(DRY),--dry-run,) "$(WORKSPACE)"

# --- BFF demo: fanout-api + upstream-mock ---
# One app request -> four upstream calls in parallel, per-call timeout,
# partial results, per-user cache in Postgres (sql/50-fanout.sql). README,
# "BFF demo: fan-out API". Not part of `make up`.
#
# bff-test: offline Deno unit tests for the fan-out (no network, no Docker).
# bff-local: the end-to-end checks on a throwaway local stack in Docker
#   (scripts/bff-local.ts; KEEP=1 leaves it running, BFF_LOCAL_DIR moves it).
# bff-deploy: SQL + both functions + their secrets on the ready project. The
#   mock is deployed with --no-verify-jwt (its caller is fanout-api, which
#   sends a shared key); fanout-api keeps JWT verification on. A fresh
#   UPSTREAM_API_KEY goes to the function secrets from stdin, never argv.
#   Run as  sx SUPABASE_ACCESS_TOKEN -- make bff-deploy
#   then    sx SUPABASE_ACCESS_TOKEN -- make probe ONLY="--only K05"
.PHONY: bff-test bff-local bff-deploy
bff-test:
	cd supabase/functions/fanout-api && deno test --no-remote --no-npm fanout.test.ts

bff-local:
	bun scripts/bff-local.ts

# --- Agent chat loop, locally ---
# agent-local: the K03 chat checks (lib/agent-chat-checks.ts) plus embed and
#   tool-mode checks on a throwaway local stack in Docker
#   (scripts/agent-local.ts; ports 5452x, project id kit-agent-local, so it
#   runs beside bff-local; KEEP=1 leaves it running, AGENT_LOCAL_DIR moves it).
#   ENV_FILE is required: a dotenv file holding ANTHROPIC_API_KEY. Its path
#   goes only to `supabase functions serve --env-file`; nothing reads or
#   prints its contents. Every chat call is a live model call.
.PHONY: agent-local
agent-local:
	@test -n "$(ENV_FILE)" || (echo "ENV_FILE=<path> is required: a dotenv file holding ANTHROPIC_API_KEY (passed to supabase functions serve --env-file, never read or printed)"; exit 2)
	bun scripts/agent-local.ts "$(ENV_FILE)"

bff-deploy: guard-tok
	@test -n "$(READY)" || (echo "no ready_ref - run 'make apply' first"; exit 1)
	bun scripts/kit.ts schema $(READY) sql/50-fanout.sql
	supabase functions deploy upstream-mock --project-ref $(READY) --workdir . --use-api --no-verify-jwt
	supabase functions deploy fanout-api --project-ref $(READY) --workdir . --use-api
	@sh -c 'set -e; k=$$(openssl rand -hex 32); \
		printf "UPSTREAM_API_KEY=%s\nUPSTREAM_BASE_URL=https://%s.supabase.co/functions/v1/upstream-mock\n" "$$k" "$$0" \
		  | supabase secrets set --env-file /dev/stdin --project-ref "$$0" >/dev/null' $(READY)
	@curl -s -H "Authorization: Bearer $$SUPABASE_ACCESS_TOKEN" \
		"https://api.supabase.com/v1/projects/$(READY)/secrets" \
		| jq -e '[.[].name] | contains(["UPSTREAM_API_KEY", "UPSTREAM_BASE_URL"])' >/dev/null \
		&& echo "UPSTREAM_API_KEY and UPSTREAM_BASE_URL set on the ready project" \
		|| (echo "upstream secrets not listed after set"; exit 1)
