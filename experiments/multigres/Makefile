# multigres - failover and lost-commit measurements against the Multigres OSS
# all-in-one container (Docker only; no native binaries are installed).
#
#   make build      clone the pinned upstream commit into .src/ and build the image
#   make up         start a 3-cell cluster (container $(CONTAINER))
#   make run        MG01,MG06,MG07 (read-only), then MG02..MG05,MG08,MG09 (--destructive)
#   make down       remove the container
#
# The tests drive the cluster with `docker exec kill`, and recreate the
# container themselves at the start of MG03 (every run), MG04, MG05, MG08 and MG09 (first run).

CONTAINER ?= multigres-lab
IMAGE     ?= multigres-cluster:local
# Upstream main at the time of the run. The v0.1.0 tag predates the
# all-in-one Dockerfile.cluster, so a tag checkout cannot build it.
MULTIGRES_REF ?= e3cbdbbb0b94453ca2ec43c9c40c05c98ed7bb73
# empty = each module's own default (MG02 3, MG03 3, MG04 2, MG05 3, MG08 3, MG09 3)
REPS      ?=
OUT       ?= evidence/$(shell date +%Y%m%d-%H%M%S)
ROOT      := $(abspath ../..)

.PHONY: build up down run read-only destructive test

.src:
	mkdir -p .src
	cd .src && git init -q && git remote add origin https://github.com/multigres/multigres \
	  && git fetch -q --depth 1 origin $(MULTIGRES_REF) && git checkout -q FETCH_HEAD

build: .src
	cd .src && docker build -f Dockerfile.cluster -t $(IMAGE) \
	  --build-arg GIT_COMMIT=$(MULTIGRES_REF) .

up:
	docker rm -f $(CONTAINER) >/dev/null 2>&1 || true
	docker run -d --name $(CONTAINER) --init \
	  -e MULTIGRES_NUM_CELLS=3 -e MULTIGRES_GATEWAY_PG_PORT=15432 \
	  -p 15432:15432 -p 15433:15433 -p 15434:15434 \
	  -p 15100:15100 -p 15000:15000 \
	  -p 25432:25432 -p 25433:25433 -p 25434:25434 \
	  $(IMAGE)
	@echo "ready when: PGPASSWORD=postgres psql -h 127.0.0.1 -p 15432 -U postgres -c 'select 1' (about 20-45 s)"

down:
	docker rm -f $(CONTAINER)

# Runs from source: the compiled harness binary targets linux-x64 only.
PVLAB = PVLAB_ENDPOINT_CONTAINER=$(CONTAINER) PVLAB_ENDPOINT_IMAGE=$(IMAGE) PVLAB_ENDPOINT_REPS=$(REPS) \
        bun $(ROOT)/harness/src/run.ts --where local --experiment multigres

read-only:
	$(PVLAB) --only MG01,MG06,MG07 --out $(OUT)/read-only

destructive:
	$(PVLAB) --only MG02,MG03,MG04,MG05,MG08,MG09 --destructive --out $(OUT)/destructive

run: read-only destructive

test:
	cd $(ROOT) && bun test experiments/multigres
