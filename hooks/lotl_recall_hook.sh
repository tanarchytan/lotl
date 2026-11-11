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
# Speed: runs a keyword (FTS) recall with no ONNX model loaded per prompt; a
# semantic recall would reload the embedder on every call. LOTL_ONNX=on in
# ~/.config/lotl/.env overrides the LOTL_ONNX=off set here, so the embed and
# rerank switches are also set explicitly. For semantic recall without that
# cost, front it with a warm daemon.
#
# Relevance gate: recall runs with --min-relevance (default 0.6), so a prompt
# that shares no specific terms with any memory ("send it", "continue", a
# generic coding request) injects nothing instead of the nearest keyword
# noise. Override with LOTL_RECALL_MIN_RELEVANCE=<0..1>, or "off" for the old
# ungated behaviour. The flag is passed as --min-relevance=R: a lotl without
# the flag (1.2.0-alpha.2 and older) ignores it and recalls ungated, so the
# hook keeps working until lotl is upgraded.
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
MIN_RELEVANCE="${LOTL_RECALL_MIN_RELEVANCE:-0.6}"
GATE=()
[ "$MIN_RELEVANCE" != "off" ] && [ -n "$MIN_RELEVANCE" ] && GATE=("--min-relevance=$MIN_RELEVANCE")

emit_nothing() { printf '{}'; exit 0; }

INPUT="$(cat 2>/dev/null)" || emit_nothing

# Extract the user's prompt from the hook's stdin JSON.
PROMPT="$(printf '%s' "$INPUT" | jq -r '.prompt // ""' 2>/dev/null)" || emit_nothing

# Skip empty / trivial prompts.
[ -n "$PROMPT" ] && [ "${#PROMPT}" -ge 8 ] || emit_nothing

# Per-project opt-out: a .lotl-norecall file in the project root suppresses
# memory injection there (recall stays active in every other project).
CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)"
[ -n "$CWD" ] && [ -f "$CWD/.lotl-norecall" ] && emit_nothing

# Fast keyword recall, hard-bounded. FTS only (no model load). Options go
# before "--" and the prompt after it, so a prompt that starts with "-" (a
# markdown bullet, "--help ...") is a query, not a flag.
#
# Read-only: LOTL_RECALL_NO_TOUCH=on stops memoryRecall from bumping access_count/last_accessed.
# Without it each recalled row is UPDATEd, the memories_au trigger rewrites its FTS entry, and
# the resulting WAL write would release the PreCompact gate with nothing saved.
FTS_ONLY=(LOTL_ONNX=off LOTL_EMBED_BACKEND=off LOTL_MEMORY_RERANK=off LOTL_RECALL_NO_TOUCH=on)

# Bound the call. GNU `timeout`, else coreutils' `gtimeout` (macOS + brew), else perl's alarm
# (ships with macOS). Stock macOS has no `timeout`; a missing binary here would make every
# recall fail and inject nothing.
if command -v timeout >/dev/null 2>&1; then
  TMO=(timeout "$RECALL_TIMEOUT")
elif command -v gtimeout >/dev/null 2>&1; then
  TMO=(gtimeout "$RECALL_TIMEOUT")
elif command -v perl >/dev/null 2>&1; then
  TMO=(perl -e 'alarm shift; exec @ARGV or exit 127' "$RECALL_TIMEOUT")
else
  TMO=()
fi

if [ "${LOTL_OKF:-on}" = "off" ]; then
  RESULTS="$(env "${FTS_ONLY[@]}" ${TMO[@]+"${TMO[@]}"} "$LOTL_BIN" memory recall ${GATE[@]+"${GATE[@]}"} -- "$PROMPT" 2>/dev/null | head -n "$MAX_LINES")" || emit_nothing
else
  RESULTS="$(env "${FTS_ONLY[@]}" ${TMO[@]+"${TMO[@]}"} "$LOTL_BIN" okf recall ${GATE[@]+"${GATE[@]}"} -- "$PROMPT" 2>/dev/null | head -n "$MAX_LINES")" || emit_nothing
fi

# Nothing useful → inject nothing (the gate filtering everything lands here too).
if [ -z "$RESULTS" ] || printf '%s' "$RESULTS" | grep -qiE 'no memories|no results|no matches|^usage:'; then
  emit_nothing
fi

# Emit as UserPromptSubmit additionalContext (jq handles JSON escaping).
if [ "${LOTL_OKF:-on}" = "off" ]; then
  HEADER="Relevant lotl memories:"
else
  HEADER="Relevant lotl concepts (open with okf_get):"
fi
jq -n --arg ctx "$HEADER
$RESULTS" \
  '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}}' \
  2>/dev/null || emit_nothing
exit 0
