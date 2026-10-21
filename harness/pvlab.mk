# Harness runner for experiment Makefiles: `include $(ROOT)/harness/pvlab.mk`
# after ROOT is set, then call `$(HARNESS_BUILD)` and `$(HARNESS_RUN) --where ...`.
#
# `bun run build` compiles for linux-x64 only, so on any other OS (the macOS
# orchestrator) the same entry runs from source and the build step only
# regenerates the test registry. Override per run: `make probe
# HARNESS_RUN="bun $ROOT/harness/src/run.ts"` (e.g. while another battery runs the
# binary - Linux refuses to overwrite a running executable), or HARNESS_OS=Linux
# to preview the Linux commands with `make -n`.
HARNESS_OS ?= $(shell uname -s)
ifeq ($(HARNESS_OS),Linux)
HARNESS_RUN   ?= $(ROOT)/harness/dist/pvlab
HARNESS_BUILD ?= cd $(ROOT)/harness && bun run build >/dev/null
else
HARNESS_RUN   ?= bun $(ROOT)/harness/src/run.ts
HARNESS_BUILD ?= cd $(ROOT)/harness && bun run gen >/dev/null
endif

# Detach a background battery into its own session so it outlives the caller
# (`$(HARNESS_DETACH) nohup sh -c '...' > log 2>&1 < /dev/null &`). setsid(1)
# is util-linux and macOS has none; perl's POSIX::setsid after a fork is what
# `setsid -f` does (checked on macOS 2026-10-21: child pid == pgid, ppid 1).
ifneq ($(shell command -v setsid 2>/dev/null),)
HARNESS_DETACH ?= setsid
else
HARNESS_DETACH ?= perl -MPOSIX -e 'fork and exit; POSIX::setsid() or die "setsid: $$!"; exec @ARGV or die "exec: $$!"'
endif
