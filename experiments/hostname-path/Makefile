ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
RUNNER ?= bun $(ROOT)/harness/src/run.ts
ONLY ?= HP01,HP02,HP03,HP04,HP05,HP06,HP07,HP08,HP09
# The custom hostname must sit in a Cloudflare zone the CLOUDFLARE_API_KEY pair can edit.
DOMAIN ?=

.PHONY: unit up probe down run

# Pure parsers (dig, DoH, curl phases). No network.
unit:
	@cd $(ROOT) && bun test experiments/hostname-path

# One self-provisioning run. Needs, injected per command:
#   sx SUPABASE_ACCESS_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL -- \
#     env PVLAB_ORG_PRO=<pro org slug> make run DOMAIN=hp-1.<zone>
# HP01 creates a project named hp-<ms>; HP09 deletes it, the custom
# hostname, the DNS records and the add-on. `make down` does the same from
# .state.json after a crashed run.
run:
	@test -n "$(DOMAIN)" || (echo "DOMAIN=<host in a Cloudflare zone> required"; exit 1)
	@cd $(ROOT)/harness && bun run gen >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_ENDPOINT_CUSTOM_DOMAIN="$(DOMAIN)" \
		$(RUNNER) --where local --experiment hostname-path --destructive --only $(ONLY) --out evidence/$(TS)
	@echo "== evidence/$(TS) =="

up:
	@$(MAKE) run ONLY=HP01,HP02,HP03,HP04,HP05 DOMAIN="$(DOMAIN)"

down:
	@cd $(ROOT)/harness && bun run gen >/dev/null
	@mkdir -p evidence/$(TS)
	@PVLAB_ENDPOINT_CUSTOM_DOMAIN="$(DOMAIN)" \
		$(RUNNER) --where local --experiment hostname-path --destructive --only HP09 --out evidence/$(TS)
