# vexp index optimization — "over the nodes" (2026-06-11)

## Symptom
vexp qmd index: **2,015 nodes / 2,162 edges / 143 files**. Reported as over the node budget.

## Root cause
Index bloat from non-source files, **not** app size. graphify (production-only graph)
sees just **60 files / 526 nodes** — the app is lean.

Breakdown of the 143 indexed files (`.vexp/manifest.json`):
- `evaluate/` — 37 files (32 in `evaluate/scripts`, dense .mjs/.py harnesses)
- `devnotes/` — ~30 files (sessions, architecture, metrics — markdown)
- `docs/` — 6, `coverage/` — 3 (generated JS), `setup/` — 3, `skills/` — 2
- `CHANGELOG.md` — 94 KB single file
- ~60 real `src/**.ts` files (the part worth indexing)

≈ 69 of 143 indexed files are non-source ≈ **48% dead weight**.

### Why they leaked in
vexp honors `.gitignore` + `.ignore` (ripgrep-style) and has built-in skips for
`node_modules/ dist/ .git/ test/ target/`. It does **not** read `.graphifyignore`.
`evaluate/ devnotes/ docs/ coverage/ setup/ skills/` are tracked in git (correctly),
so nothing excluded them from vexp.

### Structural quirk
Real git project lives at `qmd/UsersDavidGillotProjectsqmd/` (mangled-path dir).
The outer `qmd/` wrapper is what `CLAUDE_PROJECT_DIR` resolves to, so the vexp daemon
roots at the wrapper and also indexes `.claude/ .codex/ AGENTS.md`. `daemons.json` had
stale + case-duplicate registry entries (`c:` vs `C:`, plus a dead nested-daemon PID) —
cosmetic, not real duplicate processes.

## Fix applied
- `UsersDavidGillotProjectsqmd/.ignore` — excludes evaluate, devnotes, docs, skills,
  coverage, setup, scripts, hooks, CHANGELOG.md, graphify-out. **Does not touch git.**
- `qmd/.ignore` — excludes wrapper noise (.claude, .codex, .vscode, AGENTS.md).

Expected after clean rebuild: ~74 files indexed, nodes **est. ~1,100–1,400** (−30…45%).
(Estimate — markdown is node-sparse, but the 32 eval scripts + CHANGELOG were dense.)

## Applying the trim (needs ONE clean rebuild)
`.ignore` only affects fresh walks; the live daemon kept its incremental index.db.
The db file is lock-held by the running MCP server, so an in-session delete fails.
**To apply:** reload the VS Code window (Ctrl+Shift+P → "Reload Window"), OR with VS Code
closed: `rm -f .vexp/index.db*` and reopen. The daemon then re-walks honoring `.ignore`.
Verify with `index_status` → file/node count should drop.

## Not done (open)
- App-side dead-code pass (unused exports in `src/`) — separate reviewed change.
- Stop other-project daemons (Jobspy, WM-Job-Hunter) if a global node budget applies.
