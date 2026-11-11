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
# commits and bumps the WAL mtime. Recall must not move it: the hooks run recall with
# LOTL_RECALL_NO_TOUCH=on, because a normal recall bumps access_count, and through the
# memories_au trigger that rewrites the row's FTS entry, which is a WAL write that would
# release this gate with nothing saved.
#
# Portable: works with GNU and BSD (macOS) userland and bash 3.2. Mtime comes from
# `stat -c %Y` (GNU) or `stat -f %m` (BSD), never `stat -c` alone.
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
PYBIN=$(command -v python3 || command -v python || true)
# macOS has no `timeout`; coreutils installs it as gtimeout. Without either, run unbounded.
TMO=$(command -v timeout || command -v gtimeout || true)
if [ -f "$SNAPSHOT_SCRIPT" ] && [ -n "$PYBIN" ]; then
  printf '%s' "$INPUT" | ${TMO:+"$TMO" 25} "$PYBIN" "$SNAPSHOT_SCRIPT" >> "$LOG_FILE" 2>&1 \
    || echo "[$(ts)] Session $SESSION_ID: snapshot FAILED (compaction still allowed)" >> "$LOG_FILE"
fi

# Same resolution as lotl's getDefaultDbPath(): INDEX_PATH, else
# ${XDG_CACHE_HOME:-~/.cache}/lotl/index.sqlite. Watching a fixed ~/.cache path
# kept the manual gate shut forever when the index lived elsewhere.
LOTL_DB="${INDEX_PATH:-${XDG_CACHE_HOME:-${HOME}/.cache}/lotl/index.sqlite}"
# Print a file's mtime (epoch seconds), or 0. GNU first: on GNU, `stat -f` means
# "filesystem status" and would print junk, so it must only be the fallback.
mtime_of() {
  local m
  m=$(stat -c %Y "$1" 2>/dev/null) || m=$(stat -f %m "$1" 2>/dev/null) || m=0
  case "$m" in ''|*[!0-9]*) m=0 ;; esac
  echo "$m"
}
last_write=0
for f in "${LOTL_DB}-wal" "${LOTL_DB}"; do
  if [ -f "$f" ]; then
    m=$(mtime_of "$f")
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
