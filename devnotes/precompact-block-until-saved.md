# PreCompact hook: block-until-saved (not block-forever)

**Date:** 2026-06-22

## Problem
`hooks/lotl_precompact_hook.sh` was hardcoded to **always** emit
`{"decision":"block"}` (comment literally said *"Always blocks"*). Because Claude
Code re-runs the PreCompact hook on every `/compact` attempt and there was no
release condition, **`/compact` could never complete** — the hook permanently
wedged compaction. Saving via `memory_extract`/`memory_add` made no difference;
the hook ignored it and blocked again.

## Fix
Keep it a hard forcing-function, but **release once a save is recorded**:

- **Save signal** = mtime of the lotl WAL `~/.cache/lotl/index.sqlite-wal`.
  A real write (`memory_add` / `memory_extract` / `knowledge_add`) commits and
  bumps the WAL; read-only recall does **not** append to the WAL, so it won't
  spuriously release the gate.
- **State** = one marker file `~/.config/lotl/hook_state/precompact.flag`
  holding the epoch of the first block.
- **Logic:**
  - marker absent → write `marker = now`, **block** (forces a save).
  - marker present and `wal_mtime > marker` → a write landed after the block →
    `rm marker`, **exit 0 (allow)**; the gate re-arms for the next compaction.
  - marker present and no newer write → **block** (keep waiting).

Net behaviour: the first `/compact` blocks and tells the agent to save; after any
memory write lands, the retry passes; then it re-arms.

## Files
- `hooks/lotl_precompact_hook.sh` — updated to the block-until-saved logic (this
  is the source that installs to `~/.config/lotl/hooks/`).
- Installed copy `~/.config/lotl/hooks/lotl_precompact_hook.sh` updated to match.
- Relies on the lotl SQLite DB at `~/.cache/lotl/index.sqlite` (WAL mode → the
  `-wal`/`-shm` sidecars; the `-wal` mtime is the write signal).

## Gotcha
`-shm` mtime can update on reads (WAL shared-memory index); `-wal` mtime tracks
commits, so the hook keys on `-wal` (falling back to the main `.sqlite`).
