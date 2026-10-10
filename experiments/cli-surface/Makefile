ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
EVD := $(CURDIR)/evidence/$(TS)

# Self-provisioning: no OpenTofu state. CL01-CL03 and CL20-CL22 need only Docker
# (CL20-CL22 run INSIDE a container that has no Docker daemon). CL04 creates and
# deletes one Free-org project, so it needs a PAT and an org:
#
#   sx SUPABASE_ACCESS_TOKEN -- env PVLAB_ORG_FREE=<free-org-slug> make remote
#
# The CLI under test is whatever `supabase` is on PATH (override with
# PVLAB_SUPABASE_CLI); the container image pins CLI_VERSION.
PVLAB = cd $(ROOT) && PVLAB_EVIDENCE=$(EVD) bun harness/src/run.ts --where local \
  --experiment cli-surface --out $(EVD)

STACK_IDS ?= CL20,CL21,CL22

.PHONY: gen image local nodocker remote all facts publish-evidence

gen:
	cd $(ROOT)/harness && bun run gen >/dev/null

image:
	docker build -f Dockerfile.nodocker -t pvlab-cli-nodocker:2.120.0 .

# CL01-CL03: local Postgres under Docker, three diff/declarative modules.
local: gen
	mkdir -p $(EVD)
	$(PVLAB) --only CL01,CL02,CL03

# CL20-CL22 (STACK_IDS=CL22 for one): the experimental stack backend in a Linux container without Docker.
nodocker: gen image
	mkdir -p $(EVD)
	$(PVLAB) --only $(STACK_IDS) --destructive

# CL04: one Free-org project, created and deleted by the module.
remote: gen
	mkdir -p $(EVD)
	$(PVLAB) --only CL04 --destructive

all: local nodocker remote

# usage: make facts RUN=evidence/<ts>/run-<stamp>.json [IDS=CL01,CL02]
facts:
	cd $(ROOT) && bun harness/src/run.ts --facts experiments/cli-surface/$(RUN) $(if $(IDS),--only $(IDS),)

# usage: make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
publish-evidence:
	cd $(ROOT) && bun harness/scripts/publish-evidence.ts experiments/cli-surface/$(RUN) experiments/cli-surface
