# wal-on-s3: write-ahead logs and data on object storage - OrioleDB's
# experimental S3 mode on a local Docker rig (WS01).
#
#   make probe ONLY=WS01      # local rig, 13 to 25 min, Docker only
#   make clean                # remove the ws3-* containers, volumes and network
#   make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
ROOT := $(abspath ../..)
include $(ROOT)/harness/pvlab.mk
TS := $(shell date +%Y%m%d-%H%M%S)
ONLY ?= WS01

.PHONY: probe clean publish-evidence

probe:
	@mkdir -p evidence/$(TS)
	@$(HARNESS_BUILD)
	@cd $(ROOT) && $(HARNESS_RUN) --where local --experiment wal-on-s3 \
		--only $(ONLY) --destructive --out experiments/wal-on-s3/evidence/$(TS)
	@echo "== evidence/$(TS) =="

# Only names this rig creates (ws3- prefix).
clean:
	-docker rm -f -v ws3-pg ws3-pg2 ws3-s3
	-docker volume rm ws3-src ws3-restore
	-docker network rm ws3

publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .)
