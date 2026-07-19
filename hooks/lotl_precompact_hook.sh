#!/usr/bin/env bash
# Lotl PreCompact Hook for Claude Code / OpenClaw
#
# Fires before context compaction. HARD-BLOCKS until a memory save is recorded,
# THEN lets compaction through. (Forcing function that doesn't permanently wedge
# /compact: it blocks once to force a save, releases as soon as a write lands.)
#
# Save signal: mtime of the lotl SQLite write-ahead log (index.sqlite-wal). A real
# memory write (memory_add/extract/knowledge_add) commits and bumps the WAL mtime;
# read-only recall does not append to the WAL, so it won't spuriously release.
#
# State: a single marker file records the moment we first blocked. We release once
# the WAL has been written AFTER that moment, then clear the marker so the gate
# re-arms for the next compaction.
#
# See devnotes/precompact-block-until-saved.md for the rationale.
#
# Install in settings.json:
#   "hooks": { "PreCompact": [{ "hooks": [{"type":"command",
#     "command":"/path/to/hooks/lotl_precompact_hook.sh","timeout":30}] }] }

STATE_DIR="${HOME}/.config/lotl/hook_state"
LOG_FILE="${STATE_DIR}/hook.log"
MARKER="${STATE_DIR}/precompact.flag"
mkdir -p "$STATE_DIR"

SESSION_ID="${CLAUDE_SESSION_ID:-${OPENCLAW_SESSION_KEY:-default}}"
NOW=$(date +%s)
ts() { date '+%H:%M:%S'; }

# Newest write to the lotl memory DB (prefer the WAL; fall back to the main file).
last_write=0
for f in "${HOME}/.cache/lotl/index.sqlite-wal" "${HOME}/.cache/lotl/index.sqlite"; do
  if [ -f "$f" ]; then
    m=$(stat -c %Y "$f" 2>/dev/null || echo 0)
    [ "$m" -gt "$last_write" ] && last_write="$m"
  fi
done

block() {
  echo "[$(ts)] Session $SESSION_ID: PRECOMPACT BLOCK ($1)" >> "$LOG_FILE"
  echo '{"decision": "block", "reason": "Context compaction imminent — save everything now: memory_extract with the full conversation (topics, decisions, preferences, facts, reflections) + knowledge_store for entity relationships. Re-run /compact after saving; this gate releases automatically once a memory write is recorded."}'
  exit 0
}

if [ -f "$MARKER" ]; then
  blocked_at=$(cat "$MARKER" 2>/dev/null || echo 0)
  if [ "$last_write" -gt "$blocked_at" ]; then
    rm -f "$MARKER"
    echo "[$(ts)] Session $SESSION_ID: PRECOMPACT RELEASE — save detected (wal=$last_write > block=$blocked_at)" >> "$LOG_FILE"
    exit 0   # no decision => allow compaction
  fi
  block "awaiting save since $blocked_at (wal=$last_write)"
else
  echo "$NOW" > "$MARKER"
  block "first block, marker set $NOW"
fi
