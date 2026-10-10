ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

# supabase/supabase at the commit the 2026-10-10 run used. Self-hosted
# docker/ is versioned by this repo's master, not by an image tag, so the
# pin is a commit.
PIN := 8617532ae1a41571d5d557cd24c6f5f2565d9230
REPO := https://github.com/supabase/supabase.git
SRC := work/supabase
STACK := work/stack
ONLY ?= SD01,SD02,SD03,SD04,SD05,SD06,SD07,SD08

# The stack is a COPY of docker/ so the pinned clone stays pristine: the
# official key script edits docker-compose.yml in place (SD02d records what it
# changed) and `up` writes db data under volumes/.
COMPOSE := cd $(STACK) && docker compose

.PHONY: fetch stack up probe logs down clean unit publish-evidence

fetch:
	@test -d $(SRC)/.git || git clone --no-checkout --filter=blob:none $(REPO) $(SRC)
	@git -C $(SRC) fetch --depth 1 origin $(PIN)
	@git -C $(SRC) checkout --quiet --force $(PIN)
	@echo "pinned: $$(git -C $(SRC) rev-parse HEAD)"

# docker/ copied out of the pin, .env from .env.example, then the two
# upstream key scripts exactly as the self-hosting guide runs them. Their
# stdout carries the generated secrets, so it goes to /dev/null; the values
# live only in $(STACK)/.env (gitignored, removed by `make clean`).
stack: fetch
	@rm -rf $(STACK) && mkdir -p $(STACK)
	@cp -R $(SRC)/docker/. $(STACK)/
	@cp $(STACK)/.env.example $(STACK)/.env
	@cd $(STACK) && sh utils/generate-keys.sh --update-env >/dev/null
	@cd $(STACK) && sh utils/add-new-auth-keys.sh --update-env >/dev/null
	@echo "stack prepared in $(STACK) (secrets not printed)"

up:
	@test -f $(STACK)/.env || (echo "run 'make stack' first"; exit 1)
	$(COMPOSE) up -d --wait

probe:
	@test -f $(STACK)/.env || (echo "run 'make stack' first"; exit 1)
	@cd $(ROOT)/harness && bun run gen >/dev/null
	@mkdir -p evidence/$(TS)
	PVLAB_ENDPOINT_STACK_DIR="$(abspath $(STACK))" PVLAB_ENDPOINT_GW="http://127.0.0.1:8000" \
		PVLAB_ENDPOINT_PIN="$(PIN)" \
		bun $(ROOT)/harness/src/run.ts --where local --experiment self-hosted-defaults \
		--only $(ONLY) --destructive --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

logs:
	$(COMPOSE) logs --tail 60 api-gw auth

# Tear down every container, named volume and bind-mounted data directory the
# stack created, then drop the generated secrets. `down -v` leaves bind
# mounts, so the data directories are removed by hand.
down:
	-$(COMPOSE) -f docker-compose.yml -f docker-compose.logs.yml -f docker-compose.kong.yml down -v --remove-orphans
	-rm -rf $(STACK)/volumes/db/data $(STACK)/volumes/storage

clean: down
	rm -rf $(STACK)

unit:
	@cd $(ROOT) && bun test experiments/self-hosted-defaults/lib

publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
