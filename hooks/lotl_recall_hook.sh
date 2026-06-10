#!/usr/bin/env bash
# Lotl Recall Hook for Claude Code / OpenClaw
#
# Fires on the "UserPromptSubmit" event. Before the agent answers, looks up
# relevant memories in Lotl and injects them as additional context — the
# retrieve half of an auto-memory loop (pair with lotl_save_hook.sh for the
# push half).
#
# FAIL-OPEN by design: any error, timeout, or empty result injects nothing
# and exits 0. A memory lookup must never block or noticeably slow a prompt.
#
# Speed: runs a keyword (FTS) recall with LOTL_ONNX=off so no ONNX model is
# loaded per prompt — a semantic recall would reload the embedder on every
# call. For semantic recall without that cost, front it with a warm daemon.
#
# Pattern from MemPalace. Requires `jq`.
#
# Install in .claude/settings.local.json (macOS/Linux):
# {
#   "hooks": {
#     "UserPromptSubmit": [{
#       "hooks": [{"type": "command", "command": "/path/to/hooks/lotl_recall_hook.sh", "timeout": 15}]
#     }]
#   }
# }
#
# On Windows, wrap with bash and use the .cmd shim, e.g.:
#   "command": "bash 'C:/path/to/hooks/lotl_recall_hook.sh'"
# and set LOTL_BIN=lotl.cmd if `lotl` is not directly executable.
set -uo pipefail

LOTL_BIN="${LOTL_BIN:-lotl}"
RECALL_TIMEOUT="${LOTL_RECALL_TIMEOUT:-12}"
MAX_LINES="${LOTL_RECALL_MAX_LINES:-25}"

emit_nothing() { printf '{}'; exit 0; }

INPUT="$(cat 2>/dev/null)" || emit_nothing

# Extract the user's prompt from the hook's stdin JSON.
PROMPT="$(printf '%s' "$INPUT" | jq -r '.prompt // ""' 2>/dev/null)" || emit_nothing

# Skip empty / trivial prompts.
[ -n "$PROMPT" ] && [ "${#PROMPT}" -ge 8 ] || emit_nothing

# Fast keyword recall, hard-bounded. FTS only (no model load).
RESULTS="$(LOTL_ONNX=off LOTL_MEMORY_RERANK=off timeout "$RECALL_TIMEOUT" \
  "$LOTL_BIN" memory recall "$PROMPT" 2>/dev/null | head -n "$MAX_LINES")" || emit_nothing

# Nothing useful → inject nothing.
if [ -z "$RESULTS" ] || printf '%s' "$RESULTS" | grep -qiE 'no memories|no results|^usage:'; then
  emit_nothing
fi

# Emit as UserPromptSubmit additionalContext (jq handles JSON escaping).
jq -n --arg ctx "Relevant memories from lotl (recalled automatically):
$RESULTS" \
  '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}}' \
  2>/dev/null || emit_nothing
exit 0
