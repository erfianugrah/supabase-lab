#!/usr/bin/env bash
# Start Claude Code in the live workspace with none of the operator's
# user-scope config (hooks, CLAUDE.md, MCP servers, plugins).
# Usage: stage-agent.sh [--dry-run] [WORKSPACE] [claude args...]
# CLAUDE_CONFIG_DIR points at an isolated dir (STAGE_CLAUDE_HOME, default
# ~/.claude-stage); --setting-sources project,local skips user-scope settings
# and memory; --strict-mcp-config limits MCP to the workspace .mcp.json.
# Not --bare: that would stop CLAUDE.md discovery, which loads AGENTS.md.
set -euo pipefail

dry=0
if [ "${1:-}" = "--dry-run" ]; then
  dry=1
  shift
fi

ws="${1:-$HOME/kit-live-demo}"
[ "$#" -gt 0 ] && shift
extra=("$@")

ws="$(cd "$ws" && pwd)"
cd "$ws"
[ -f "$ws/.mcp.json" ] || { echo "missing $ws/.mcp.json - run make live-workspace" >&2; exit 1; }

cfg="${STAGE_CLAUDE_HOME:-$HOME/.claude-stage}"

# Instruction files in the workspace's ancestor directories load as Project
# memory whatever CLAUDE_CONFIG_DIR and --setting-sources say: with the
# workspace under $HOME, ~/.claude/CLAUDE.md (the operator's own) loaded
# (seen 2026-10-09, Claude Code 2.1.286). Exclude every ancestor's files;
# the workspace's own CLAUDE.md and AGENTS.md still load.
excl=()
d="$(dirname "$ws")"
while :; do
  p="${d%/}"
  excl+=("$p/CLAUDE.md" "$p/CLAUDE.local.md" "$p/.claude/CLAUDE.md" "$p/.claude/rules/**")
  [ "$d" = / ] && break
  d="$(dirname "$d")"
done
settings="$(jq -cn '{claudeMdExcludes: $ARGS.positional}' --args "${excl[@]}")"

cmd=(claude --setting-sources "project,local" --settings "$settings" --strict-mcp-config --mcp-config "$ws/.mcp.json" ${extra[@]+"${extra[@]}"})

echo "note: $cfg starts logged out; run /login once during setup" >&2

if [ "$dry" = 1 ]; then
  printf 'CLAUDE_CONFIG_DIR=%q' "$cfg"
  printf ' %q' "${cmd[@]}"
  printf '\n'
  exit 0
fi

mkdir -p "$cfg"
export CLAUDE_CONFIG_DIR="$cfg"
exec "${cmd[@]}"
