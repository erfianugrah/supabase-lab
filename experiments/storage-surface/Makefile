# storage-surface: self-provisioning, no OpenTofu state. Each module creates a
# throwaway Pro-org project named ss-<tag>-<epoch> and deletes it in
# `finally`. Needs SUPABASE_ACCESS_TOKEN and PVLAB_ORG_PRO in the environment.
#
#   make probe                 # SS01 + SS02, one run each
#   make probe MODS=SS02       # one module
#   make sweep                 # list ss- projects left behind
#   make probe MODS=SS03       # SS03-SS05 rows on a managed project
#   make probe-sh              # the same rows on the local self-hosted stack (SS06 input)
#   make probe-sh SHMODS=SS12  # self-hosted only: does a delete free backend space (file or MinIO)
#   make probe MODS=SS11       # overwrite staleness per path, purge, past-2 GiB objects, parallel parts, TUS race
#   make probe MODS=SS03 ROWS=SS03d,SS03k   # only those rows (setup and uploads still run)
#   make probe MODS=SS07       # read-only: region catalogue, key-management API surface
#   make ss06 RUNS=a.json,b.json,c.json   # diff table from published run artifacts
#   make clean-fixtures        # delete the 2 GiB / 64 MiB / 256 MiB fixtures and the SS11 ones
#   make probe MODS=SS10       # egress-meter load on two KEPT projects; then make ss10-teardown REFS=a,b
#   make aws-control           # optional: dot-segment and double-slash keys against Amazon S3 (needs AWS credentials)
#
# Runs from source (bun harness/src/run.ts): the AWS SDK v3 lives in canary/
# (own package.json), so it is not part of the compiled registry.
ROOT := $(abspath ../..)
comma := ,
TS := $(shell date +%Y%m%d-%H%M%S)
MODS ?= SS01,SS02
SHMODS ?= SS03

SH_RIG := $(ROOT)/experiments/self-hosted-defaults
FIXTURES := evidence/fixtures
.PHONY: probe probe-sh ss06 clean-fixtures sweep publish-evidence aws-control ss10-teardown

probe:
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "SUPABASE_ACCESS_TOKEN not set"; exit 1)
	@test -n "$$PVLAB_ORG_PRO" || (echo "PVLAB_ORG_PRO not set (slug of a Pro org)"; exit 1)
	@cd $(ROOT)/harness && bun scripts/gen-registry.ts >/dev/null
	@mkdir -p evidence/$(TS)
	@cd $(ROOT) && PVLAB_ENDPOINT_SS03_ROWS="$(ROWS)" PVLAB_ENDPOINT_SS11_ROWS="$(ROWS)" bun harness/src/run.ts --where local --experiment storage-surface \
		--only $(MODS) --destructive --out experiments/storage-surface/evidence/$(TS)
	@echo "== evidence/$(TS) =="

# SS03 against the self-hosted rig (bring it up first, e.g.
# `make -C ../self-hosted-defaults stack up LAYERS=s3`). No PAT, no project.
# The gateway is addressed as localhost, the host of the stack's
# SUPABASE_PUBLIC_URL: the Storage server verifies S3 signatures against that
# host, so 127.0.0.1 gets SignatureDoesNotMatch (SS03_target records both).
probe-sh:
	@test -f $(SH_RIG)/work/stack/.env || (echo "no rig: make -C ../self-hosted-defaults stack up [LAYERS=s3]"; exit 1)
	@cd $(ROOT)/harness && bun scripts/gen-registry.ts >/dev/null
	@mkdir -p evidence/$(TS)
	@cd $(ROOT) && PVLAB_ENDPOINT_STACK_DIR="$(SH_RIG)/work/stack" PVLAB_ENDPOINT_GW="http://localhost:8000" PVLAB_ENDPOINT_SS03_ROWS="$(ROWS)" \
		bun harness/src/run.ts --where local --experiment storage-surface \
		--only $(SHMODS) --destructive --out experiments/storage-surface/evidence/$(TS)
	@echo "== evidence/$(TS) =="

# SS06: the row-by-row diff of SS03 runs (published artifacts, offline).
#   make ss06 RUNS=out/<date>/run-a.json,out/<date>/run-b.json,...
ss06:
	@test -n "$(RUNS)" || (echo "RUNS=run1.json,run2.json,..."; exit 1)
	@cd $(ROOT)/harness && bun scripts/gen-registry.ts >/dev/null
	@mkdir -p evidence/$(TS)
	@cd $(ROOT) && PVLAB_ENDPOINT_SS06_RUNS="$(foreach r,$(subst $(comma), ,$(RUNS)),$(abspath $(r)))" \
		bun harness/src/run.ts --where local --experiment storage-surface \
		--only SS06 --out experiments/storage-surface/evidence/$(TS)
	@echo "== evidence/$(TS) =="

# The fixture files by name (no recursive delete).
clean-fixtures:
	rm -f $(FIXTURES)/big.bin $(FIXTURES)/mid.bin $(FIXTURES)/gz.bin.gz $(FIXTURES)/solid.png $(FIXTURES)/manifest.json
	rm -f $(FIXTURES)/huge.bin $(FIXTURES)/r1.bin $(FIXTURES)/r2.bin $(FIXTURES)/ss11.json
	-rmdir $(FIXTURES)

# Orphan check: any project left behind by a crashed run carries this prefix.
# Fails loudly when the API call fails: an empty list from a failed request
# looked like a clean sweep once (2026-10-12).
sweep:
	@out=$$(printf 'Authorization: Bearer %s\n' "$$SUPABASE_ACCESS_TOKEN" | curl -sSf -H @- https://api.supabase.com/v1/projects) \
		|| { echo "sweep: GET /v1/projects failed"; exit 1; }; \
		echo "$$out" | jq -r '.[] | select(.name | startswith("ss-")) | "\(.name) \(.status)"'; \
		echo "sweep: $$(echo "$$out" | jq '[.[] | select(.name | startswith("ss-"))] | length') ss- projects"

# Redacted copy + facts into out/<date>/ (what the RUNLOG cites).
#   make publish-evidence RUN=evidence/<ts>/run-<stamp>.json
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .)

aws-control:
	@cd canary && bun install >/dev/null && bun aws-control.ts ap-southeast-1

# SS10 keeps its two projects so their metered egress can be read later.
# Delete them by ref once the read is done:
#   make ss10-teardown REFS=<gz_ref>,<plain_ref>
ss10-teardown:
	@test -n "$(REFS)" || (echo "REFS=<gz_ref>,<plain_ref>"; exit 1)
	@test -n "$$SUPABASE_ACCESS_TOKEN" || (echo "SUPABASE_ACCESS_TOKEN not set"; exit 1)
	@for r in $(subst $(comma), ,$(REFS)); do \
		code=$$(printf 'Authorization: Bearer %s\n' "$$SUPABASE_ACCESS_TOKEN" | curl -s -o /dev/null -w '%{http_code}' -X DELETE -H @- https://api.supabase.com/v1/projects/$$r); \
		echo "DELETE $$r: HTTP $$code"; done
