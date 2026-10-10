#!/usr/bin/env bash
# Claude Code Elicitation hook for K07: logs the event it receives (one JSON
# line per call) and answers with the action in K07_ACTION (accept, decline,
# cancel; default decline). K07_LOG is the log path. Output format per
# https://code.claude.com/docs/en/hooks (Elicitation output): exit 0 and a
# hookSpecificOutput object with "action". Nothing here prints the
# environment; the event carries the form schema and message, not credentials.
set -euo pipefail
log="${K07_LOG:-/dev/null}"
action="${K07_ACTION:-decline}"
event="$(cat)"
printf '%s\n' "$event" | jq -c '{hook_event_name, mcp_server_name, mode, message, requested_schema}' >> "$log"
jq -cn --arg a "$action" '{hookSpecificOutput: ({hookEventName: "Elicitation", action: $a} + (if $a == "accept" then {content: {}} else {} end))}'
