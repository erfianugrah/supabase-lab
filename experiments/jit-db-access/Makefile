# jit-db-access: self-provisioning, no OpenTofu state. The module creates one
# Pro-org project, runs every row on it and deletes it in `finally`.
#
#   SUPABASE_ACCESS_TOKEN=... PVLAB_ORG_PRO=<pro-org-slug> make run
#
# Needs psql on PATH (the PAT is the Postgres password, so the module shells
# out to psql rather than holding it in a driver) and, for the direct-path
# rows, IPv6 from this machine. The org slug is an account identifier: pass it
# in the environment, never in a tracked file.
ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)

.PHONY: run reuse publish-evidence

run:
	@test -n "$(SUPABASE_ACCESS_TOKEN)" || (echo "export SUPABASE_ACCESS_TOKEN"; exit 1)
	@test -n "$(PVLAB_ORG_PRO)" || (echo "export PVLAB_ORG_PRO=<pro org slug>"; exit 1)
	@cd $(ROOT)/harness && bun scripts/gen-registry.ts >/dev/null
	@mkdir -p evidence/$(TS)
	@cd $(ROOT) && bun harness/src/run.ts --where local --experiment jit-db-access \
		--only JA01 --destructive --out experiments/jit-db-access/evidence/$(TS)
	@echo "== evidence/$(TS)/ =="

# Debugging only: reuse an existing project (PVLAB_PEER_JIT=<ref>); it is not deleted.
reuse: run

# Redacted copy of a run artifact plus its facts.md into out/<date>/ (committed).
publish-evidence:
	@test -n "$(RUN)" || (echo "RUN=evidence/<ts>/run-<stamp>.json required"; exit 1)
	@cd $(ROOT)/harness && bun scripts/publish-evidence.ts $(abspath $(RUN)) $(abspath .)
