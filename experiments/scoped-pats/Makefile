ROOT := $(abspath ../..)
TS := $(shell date +%Y%m%d-%H%M%S)
RUN = bun $(ROOT)/harness/src/run.ts --where local --tests $(CURDIR)/tests --experiment scoped-pats --out $(CURDIR)/evidence/$(TS)

# Self-provisioning: there is no OpenTofu state. The destructive modules create
# and delete their own projects (named $(PVLAB_SP_NAME_PREFIX)<tag>-<ms>).
# Needs in the environment:
#   SUPABASE_ACCESS_TOKEN   the lab token (inject with sx, never print)
#   PVLAB_ORG_PRO           slug of the Pro org (SP02, SP04, SP05, SP09)
# Optional (modules skip with the exact hand-off when absent; see README):
#   PVLAB_PEER_FIXTURE, PVLAB_PEER_OTHER      existing projects
#   PVLAB_SCOPED_PAT_{ORG,RO,DBRW,NARROW,MEMBER,REVOKE}, PVLAB_LEGACY_PAT
export PVLAB_SP_NAME_PREFIX ?= sp-

.PHONY: registry probe matrix org boundary watch-demote watch-revoke all-scoped facts

# The compiled/dir-scan registry is generated and gitignored; regenerate after
# adding a module or the run silently omits it.
registry:
	cd $(ROOT)/harness && bun run gen

# Read-only, no project: creation surface, profile/CLI, header semantics.
probe: registry
	$(RUN) --only SP01,SP06,SP10

# Permission matrix + SQL read-only boundary. Provisions one project per module.
matrix: registry
	$(RUN) --only SP02,SP05 --destructive

# Q14: org-scoped token creates projects, sees later ones, request budget.
org: registry
	$(RUN) --only SP04 --destructive

# Project-scoped token boundary (needs PVLAB_PEER_FIXTURE and PVLAB_PEER_OTHER).
boundary: registry
	$(RUN) --only SP09 --destructive

# Operator-in-the-loop: demote the creator / delete the token while this polls.
watch-demote: registry
	PVLAB_SP_WATCH_S=$${PVLAB_SP_WATCH_S:-900} $(RUN) --only SP07 --destructive

watch-revoke: registry
	PVLAB_SP_WATCH_S=$${PVLAB_SP_WATCH_S:-900} $(RUN) --only SP08 --destructive

all-scoped: probe matrix org boundary

facts:
	@test -n "$(RUNFILE)" || (echo "usage: make facts RUNFILE=evidence/<ts>/run-<stamp>.json"; exit 1)
	bun $(ROOT)/harness/src/run.ts --facts $(RUNFILE)
