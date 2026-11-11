#!/usr/bin/env bash
# Lotl PreCompact Hook for Claude Code / OpenClaw
#
# Fires before context compaction. It branches on the TRIGGER, because the two cases need
# opposite behaviour:
#
#   manual ("/compact")  -> HARD-BLOCK until a memory save is recorded, then release. This is the
#                           forcing function: the user asked to compact, so there is a turn
#                           available in which to save, and losing state is the expensive outcome.
#
#   auto (context full)  -> NEVER BLOCK. Auto-compaction fires when the window is nearly exhausted
#                           and there is no turn left to spend on a save; blocking there risks
#                           wedging the session instead of protecting it. Allow, and leave a
#                           breadcrumb if the last save is stale so the next session knows.
#
# Before 2026-09-14 this blocked unconditionally, which made auto-compaction unusable.
#
# Save signal: mtime of the lotl SQLite write-ahead log (<index>.sqlite-wal). A real memory write
# commits and bumps the WAL mtime; read-only recall does not append to it, so it cannot spuriously
# release the gate.
#
# See devnotes/precompact-block-until-saved.md for the rationale.
#
# Install in settings.json:
#   "hooks": { "PreCompact": [{ "hooks": [{"type":"command",
#     "command":"/path/to/hooks/lotl_precompact_hook.sh","timeout":30}] }] }

STATE_DIR="${HOME}/.config/lotl/hook_state"
LOG_FILE="${STATE_DIR}/hook.log"
MARKER="${STATE_DIR}/precompact.flag"
BREADCRUMB="${STATE_DIR}/last-autocompact.txt"
STALE_AFTER=1800   # seconds; a save older than this at auto-compact time is worth recording
mkdir -p "$STATE_DIR"

SESSION_ID="${CLAUDE_SESSION_ID:-${OPENCLAW_SESSION_KEY:-default}}"
NOW=$(date +%s)
ts() { date '+%H:%M:%S'; }

# Claude Code sends the hook payload on stdin. `trigger` is "manual" or "auto".
INPUT=""
if [ ! -t 0 ]; then INPUT=$(cat); fi
TRIGGER=$(printf '%s' "$INPUT" | sed -n 's/.*"trigger"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p')

# No payload at all means we cannot tell, and wedging the session is the worse error: allow.
if [ -z "$INPUT" ]; then TRIGGER="auto"; fi
if [ -z "$TRIGGER" ]; then TRIGGER="manual"; fi

# ALWAYS write the automatic handoff snapshot, whatever the trigger. Auto-compaction cannot be
# blocked to ask the agent for a save, so this is the save that happens without it: the user's
# recent asks, verbatim, plus the state of both trees. Never allowed to interfere with compaction.
# Optional: only runs when ~/.claude/hooks/compact_snapshot.py exists.
SNAPSHOT_SCRIPT="${HOME}/.claude/hooks/compact_snapshot.py"
if [ -f "$SNAPSHOT_SCRIPT" ]; then
  printf '%s' "$INPUT" | timeout 25 python "$SNAPSHOT_SCRIPT" >> "$LOG_FILE" 2>&1 \
    || echo "[$(ts)] Session $SESSION_ID: snapshot FAILED (compaction still allowed)" >> "$LOG_FILE"
fi

# Same resolution as lotl's getDefaultDbPath(): INDEX_PATH, else
# ${XDG_CACHE_HOME:-~/.cache}/lotl/index.sqlite. Watching a fixed ~/.cache path
# kept the manual gate shut forever when the index lived elsewhere.
LOTL_DB="${INDEX_PATH:-${XDG_CACHE_HOME:-${HOME}/.cache}/lotl/index.sqlite}"
last_write=0
for f in "${LOTL_DB}-wal" "${LOTL_DB}"; do
  if [ -f "$f" ]; then
    m=$(stat -c %Y "$f" 2>/dev/null || echo 0)
    [ "$m" -gt "$last_write" ] && last_write="$m"
  fi
done

if [ "$TRIGGER" = "auto" ]; then
  age=$(( NOW - last_write ))
  if [ "$last_write" -gt 0 ] && [ "$age" -lt "$STALE_AFTER" ]; then
    echo "[$(ts)] Session $SESSION_ID: AUTOCOMPACT allowed - last save ${age}s ago" >> "$LOG_FILE"
  else
    echo "auto-compaction at $(date '+%F %T'); last memory write was ${age}s before it." > "$BREADCRUMB"
    echo "[$(ts)] Session $SESSION_ID: AUTOCOMPACT allowed - STALE save (${age}s), breadcrumb written" >> "$LOG_FILE"
  fi
  rm -f "$MARKER"   # a manual gate half-armed before an auto-compact must not survive it
  exit 0
fi

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
