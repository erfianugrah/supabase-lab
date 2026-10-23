ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

# supabase/supabase at the commit the 2026-10-10 run used. Self-hosted
# docker/ is versioned by this repo's master, not by an image tag, so the
# pin is a commit.
PIN := 8617532ae1a41571d5d557cd24c6f5f2565d9230
REPO := https://github.com/supabase/supabase.git
SRC := work/supabase
ONLY ?= SD01,SD02,SD03,SD04,SD05,SD06,SD07,SD08

# A second stack beside the default one (added 2026-10-23 for SD09-SD12):
# `make stack up probe SLOT=b GW_PORT=8200 PG_PORT=5632 TXN_PORT=6743` puts the
# copy in work/stack-b, names the compose project sd-b and publishes the
# gateway and Supavisor on the given host ports. The fixed container_name
# lines are commented out (compose names them <project>-<service>-1), and
# Realtime keeps its upstream name as a network alias because Envoy routes to
# it by that name and Realtime reads its tenant from it. Every edit to the
# stack copy's docker-compose.yml carries a `# sd-slot` marker and keeps the
# line count, so SD02d can still diff the key script's own edits. The modules
# find containers by compose labels; utils/upgrade-pg17.sh looks the database
# up as `supabase-db`, which SD11 handles (see its header).
SLOT ?=
STACK := work/stack$(if $(SLOT),-$(SLOT),)
PROJECT := $(if $(SLOT),sd-$(SLOT),supabase)
GW_PORT ?= 8000
PG_PORT ?= 5432
TXN_PORT ?= 6543
NOW_MS = bun -e 'console.log(Date.now())'

# The stack is a COPY of docker/ so the pinned clone stays pristine: the
# official key script edits docker-compose.yml in place (SD02d records what it
# changed) and `up` writes db data under volumes/.
COMPOSE := cd $(STACK) && docker compose

# Extra compose layers for `up`, by name: an upstream override in docker/
# (s3, logs, kong, ...) or one of this experiment's compose/ files
# (storage-limit, storage-image, storage-volume, minio-hostdir).
# `make up LAYERS="s3 minio-hostdir"`.
# storage-surface SS03 uses this for its sh-file / sh-s3 targets.
LAYERS ?=
LAYER_FILES = $(foreach l,$(LAYERS),-f $(if $(wildcard compose/docker-compose.$(l).yml),$(abspath compose/docker-compose.$(l).yml),docker-compose.$(l).yml))

.PHONY: fetch stack pull up up-pg15 amd64-layer vmfs-up vmfs-down probe logs down clean unit publish-evidence

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
ifneq ($(SLOT),)
	@cd $(STACK) && sed -i.orig \
		-e 's|^API_GW_HTTP_PORT=.*|API_GW_HTTP_PORT=$(GW_PORT)|' \
		-e 's|^KONG_HTTP_PORT=.*|KONG_HTTP_PORT=$(GW_PORT)|' \
		-e 's|^POOLER_PROXY_PORT_TRANSACTION=.*|POOLER_PROXY_PORT_TRANSACTION=$(TXN_PORT)|' \
		-e 's|^SUPABASE_PUBLIC_URL=.*|SUPABASE_PUBLIC_URL=http://localhost:$(GW_PORT)|' \
		-e 's|^API_EXTERNAL_URL=.*|API_EXTERNAL_URL=http://localhost:$(GW_PORT)/auth/v1|' .env \
		&& rm .env.orig && printf 'COMPOSE_PROJECT_NAME=$(PROJECT)\nSD_PG_HOST_PORT=$(PG_PORT)\n' >> .env
	@cd $(STACK) && sed -i.orig \
		-e 's|- $${POSTGRES_PORT}:5432|- $${SD_PG_HOST_PORT:-$${POSTGRES_PORT}}:5432 # sd-slot|' \
		-e 's|container_name: realtime-dev.supabase-realtime|networks: { default: { aliases: [realtime-dev.supabase-realtime] } } # sd-slot|' \
		-e 's|^\( *\)container_name: \(.*\)$$|\1# container_name: \2 # sd-slot|' docker-compose.yml && rm docker-compose.yml.orig
endif
	@echo "stack prepared in $(STACK), project $(PROJECT), gateway port $(GW_PORT) (secrets not printed)"

# Image pull, timed on its own so `up` measures start-up rather than download.
# Wall times land in $(STACK)/.timing (read by SD12).
pull:
	@test -f $(STACK)/.env || (echo "run 'make stack' first"; exit 1)
	@t0=$$($(NOW_MS)); $(COMPOSE) -f docker-compose.yml $(LAYER_FILES) pull --quiet; rc=$$?; \
		echo "pull_ms=$$(( $$($(NOW_MS)) - t0 )) pull_exit=$$rc layers=$(LAYERS)" >> .timing; exit $$rc

up:
	@test -f $(STACK)/.env || (echo "run 'make stack' first"; exit 1)
	@t0=$$($(NOW_MS)); $(COMPOSE) -f docker-compose.yml $(LAYER_FILES) up -d --wait --wait-timeout 1200; rc=$$?; \
		echo "up_ms=$$(( $$($(NOW_MS)) - t0 )) up_exit=$$rc layers=$(LAYERS)" >> .timing; exit $$rc

# SD12: write the stack's docker-compose.amd64.yml (linux/amd64 images by
# manifest digest, see lib/amd64-layer.ts), then `make pull up LAYERS=amd64`.
# Studio and imgproxy stay on their native images by default: they are not
# core API services, and Studio alone is about 1.25 GB per architecture.
AMD64_SERVICES ?= db auth rest realtime api-gw storage functions supavisor meta
amd64-layer:
	@test -f $(STACK)/.env || (echo "run 'make stack' first"; exit 1)
	@bun lib/amd64-layer.ts $(abspath $(STACK)) $(AMD64_SERVICES)

# SD11 with the stack on the engine VM's own filesystem (ext4) instead of the
# host copy, which Docker Desktop for Mac bind-mounts over virtiofs: the
# prepared stack is copied into an anonymous volume held by a container, and
# started from there with docker:29-dind as a root shell. `make probe` passes
# the location to SD11 when $(STACK)/.vmfs exists. `make vmfs-down` removes the
# stack and the volume (the holder is removed with -v).
VMFS := sd-vmfs-$(SLOT)
RUNNER = docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$$(cat $(STACK)/.vmfs):$$(cat $(STACK)/.vmfs)" \
	-w "$$(cat $(STACK)/.vmfs)/stack" --entrypoint sh docker:29-dind -c
vmfs-up:
	@test -f $(STACK)/.env || (echo "run 'make stack' first"; exit 1)
	@docker run -d --name $(VMFS) -v /stack-volume alpine:latest tail -f /dev/null >/dev/null
	@docker inspect -f '{{range .Mounts}}{{.Source}}{{end}}' $(VMFS) > $(STACK)/.vmfs
	@docker run --rm -v "$(abspath $(STACK)):/src:ro" -v "$$(cat $(STACK)/.vmfs):/dst" alpine:latest sh -c 'mkdir -p /dst/stack && cp -a /src/. /dst/stack/'
	@t0=$$($(NOW_MS)); $(RUNNER) 'sh run.sh config add pg15 >/dev/null && sh run.sh start'; rc=$$?; \
		echo "up_ms=$$(( $$($(NOW_MS)) - t0 )) up_exit=$$rc layers=pg15(run.sh,vmfs)" >> $(STACK)/.timing; exit $$rc

vmfs-down:
	-@test ! -f $(STACK)/.vmfs || $(RUNNER) 'docker compose down -v --remove-orphans'
	-docker rm -f -v $(VMFS)
	-rm -f $(STACK)/.vmfs

# SD11's starting point: the stack on Postgres 15, selected the way the guide
# does it (`sh run.sh config add pg15` writes COMPOSE_FILE into .env).
up-pg15:
	@test -f $(STACK)/.env || (echo "run 'make stack' first"; exit 1)
	@cd $(STACK) && sh run.sh config add pg15 >/dev/null && t0=$$($(NOW_MS)); sh run.sh start; rc=$$?; \
		echo "up_ms=$$(( $$($(NOW_MS)) - t0 )) up_exit=$$rc layers=pg15(run.sh)" >> .timing; exit $$rc

probe:
	@test -f $(STACK)/.env || (echo "run 'make stack' first"; exit 1)
	@cd $(ROOT)/harness && bun run gen >/dev/null
	@mkdir -p evidence/$(TS)
	PVLAB_ENDPOINT_STACK_DIR="$(abspath $(STACK))" PVLAB_ENDPOINT_GW="http://127.0.0.1:$(GW_PORT)" \
		PVLAB_ENDPOINT_PIN="$(PIN)" PVLAB_ENDPOINT_PROJECT="$(PROJECT)" \
		PVLAB_ENDPOINT_EXEC_DIR="$$(test -f $(STACK)/.vmfs && echo "$$(cat $(STACK)/.vmfs)/stack")" \
		PVLAB_ENDPOINT_EXEC_MOUNT="$$(test -f $(STACK)/.vmfs && echo "$$(cat $(STACK)/.vmfs):$$(cat $(STACK)/.vmfs)")" \
		bun $(ROOT)/harness/src/run.ts --where local --experiment self-hosted-defaults \
		--only $(ONLY) --destructive --out evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

logs:
	$(COMPOSE) logs --tail 60 api-gw auth

# Tear down every container, named volume and bind-mounted data directory the
# stack created, then drop the generated secrets. `down -v` leaves bind
# mounts, so the data directories are removed by hand.
down:
	-$(COMPOSE) -f docker-compose.yml -f docker-compose.logs.yml -f docker-compose.kong.yml -f docker-compose.s3.yml -f $(abspath compose/docker-compose.storage-volume.yml) down -v --remove-orphans
	-rm -rf $(STACK)/volumes/db/data $(STACK)/volumes/storage
	@# SD11 leaves the upgrade's backups, staging dir and binary tarball next to
	@# the data dir; some of them are written by root inside a container.
	-test ! -d $(STACK)/volumes/db || docker run --rm -v "$(abspath $(STACK))/volumes/db:/v" alpine:latest \
		sh -c 'rm -rf /v/data /v/data.bak.pg15 /v/data_migration /v/data-manual-backup /v/.upgrade-tmp /v/pg17_upgrade_bin_*.tar.gz /v/pgsodium_root.key.bak.pg15'

clean: down
	rm -rf $(STACK)

unit:
	@cd $(ROOT) && bun test experiments/self-hosted-defaults/lib

publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .) $(if $(PUBLISH_ONLY),--only $(PUBLISH_ONLY),)
