# Vexp → Lotl Feature Roadmap

**Date:** 2026-05-20
**Status:** Draft for brainstorming (not yet committed to milestones)
**Author:** David Gillot (with Claude)

## Premise

Vexp ships several patterns that materially change how agents interact with the indexed code/data. Some translate directly to Lotl; some don't. This roadmap ranks them by leverage for Lotl specifically (doc + memory search + KG, not code indexing).

Cross-ref: Vexp's own design in `~/.claude/CLAUDE.md` (MCP tool routing block), Lotl's MCP tools in `src/mcp/server.ts`, existing skill install path in `src/cli/skill-commands.ts`.

---

## v1.3 — small, high leverage (target: ~3 days work)

### 1. PreToolUse hook for tool routing enforcement

**What:** Ship a Claude Code hook in `~/.claude/hooks/` (via `lotl skill install`) that blocks raw `cat` / `Read` calls against paths under an indexed Lotl collection, suggesting `doc_get` / `doc_search` instead. Mirrors vexp's "block Grep/Glob when daemon is running" pattern (see `.claude/CLAUDE.md` in the project root, `MANDATORY: use vexp pipeline` block).

**Why ship:** Highest-leverage item on the list. Agents today fall back to grep + Read on indexed content because nothing forces them not to. A hook flips the default and recovers the 60-90% token savings the existing tools already provide. Zero code in Lotl itself — pure install-side ergonomics.

**Mechanism:**
- Hook script reads the tool call's target path.
- If path is under any registered Lotl collection (resolve via `lotl collection list --json`), reject with a message pointing to `doc_get` / `doc_search`.
- Otherwise allow the call through.

**Effort:** 1-2 days. New file `hooks/pre-tool-use.sh`, wired into `lotl skill install --global`. Add an `--enforce-routing` flag so users can opt out.

**Files:** `hooks/pre-tool-use.sh` (new), `src/cli/skill-commands.ts` (extend installer), `skills/lotl/SKILL.md` (document).

### 2. Daemon-by-default in install flow

**What:** When the user runs `lotl skill install` (or the standalone `setup/setup-qmd.sh`), spawn `lotl mcp --http --daemon` automatically and register a supervisor (PM2 on Linux/macOS, Windows Service or scheduled task on Windows).

**Why ship:** The HTTP daemon mode already exists (`src/mcp/server.ts`). Today users have to start it manually, which means first query of every session is cold-start latency. Promoting daemon-by-default fixes this with near-zero code change.

**Effort:** ~0.5 day. Mostly install-script work. Risk: cross-platform supervisor logic is fiddly — Windows users get a different setup than Linux.

**Files:** `setup/setup-qmd.sh`, `setup/install-daemon.sh` (new), README install section.

---

## v1.4 — mid-effort (target: ~6 days work)

### 3. `doc_skeleton` MCP tool

**What:** New MCP tool returning a compressed view of a document — headers only + first-line excerpts per section + a token count. Three detail levels: `minimal` (just title + h1/h2 headers), `standard` (+ first paragraph per section), `detailed` (+ short sections inlined verbatim, long sections truncated). Mirrors vexp's `get_skeleton` (70-90% token savings vs full Read).

**Why ship:** Long markdown files in indexed collections are expensive to `doc_get` in full when an agent only wants to know what's there. Skeleton view lets agents skim cheaply, then `doc_get` only the section they need.

**Mechanism:**
- Reuse existing chunking output (chunks are already structured per `src/store/chunking.ts`).
- Build a skeleton from chunk metadata (level, heading, byte offset) without reading the full doc text.
- Format as Markdown so agent output stays readable.

**Effort:** 3-4 days. New tool in `src/mcp/server.ts`, new helper in `src/store/`. Tests in `test/`.

**Files:** `src/mcp/server.ts` (new tool registration), `src/store/skeleton.ts` (new helper), `test/skeleton.test.ts` (new).

### 4. `compress` flag on response formatters

**What:** Add `compress: "lite" | "full" | "ultra"` parameter to `doc_search` / `memory_search` / `knowledge_search`. At `full` and above, replace verbatim snippet text with `[V-REF:hash]` placeholders that can be expanded on demand via a sibling `expand_ref` tool. Saves significant tokens when agents return 20+ hits with long snippets.

**Why ship:** Search responses can be 10-30 KB of text when ranking 20+ hits. Lite compression removes prose filler; full compression hashes snippets. Agents who only need the top-3 hits don't pay for the bottom-17.

**Mechanism:**
- Hash table maintained per-MCP-session (in-memory).
- `expand_ref(hash)` returns the original snippet.
- Hash collisions are session-scoped, so cheap to clear on session end.

**Effort:** 2-3 days. Mostly response-formatter work + new tool. No deep model changes.

**Files:** `src/mcp/server.ts` (compress param + expand_ref tool), `src/mcp/formatters.ts` (new), `test/mcp-compression.test.ts` (new).

---

## Explicitly skipped (with reasons)

| Idea from vexp | Why not adopted |
|---|---|
| Auto-intent detection (debug/modify/refactor/explore) | Lotl's RRF + rerank pipeline is already tuned to beat published baselines (LoCoMo, LongMemEval). Adding intent classification risks regression with unclear ROI. Revisit only if a specific user-visible win emerges. |
| Change coupling / co-changed files via git history | Vexp is code-indexing; Lotl is doc-and-memory. The "files changed together" signal doesn't map cleanly to memory + KG + markdown vault. Could maybe re-cast as "memories created together in same session" but unclear value. |
| Free vs paid call budget (e.g. 8 `run_pipeline`/day) | Vexp gates expensive embedded LLM calls. Lotl's queries hit local SQLite — no expensive path to gate. Budget gating would be over-engineering. |
| LSP bridge (capture type-resolved call edges from VS Code) | Lotl doesn't index code. N/A. |
| `run_pipeline` (single mega-tool combining capsule + impact + memory) | Vexp's strength is consolidating *code* analysis steps. Lotl's MCP surface is already CRUD-aligned (`doc_*`, `memory_*`, `knowledge_*`) which maps cleanly to agent intent. A mega-tool would mix concerns. |

---

## Recommended first PR

**v1.3.0:** Ship items 1 + 2 together (PreToolUse hook + daemon-by-default). ~2-3 days work. Biggest user-visible impact — agents actually start using Lotl's tools instead of falling back to grep, and queries become consistently fast.

v1.4 items get their own cycle once v1.3 has been in the wild for a week or two.

---

## Open questions

1. **Hook UX on rejection.** Should the hook *block* the Read call, or *warn and pass through*? Strict block is more vexp-like; warn-and-pass is friendlier. Recommend: block on enforce mode, warn-and-pass on suggest mode, env var to toggle.
2. **Daemon supervisor on Windows.** PM2 works but is npm-only. Native Windows Service requires elevated install. Maybe just a scheduled task on user login as the default? Worth a small spike.
3. **Skeleton chunking re-use.** Does existing chunking output preserve enough structure to rebuild headers, or do we need a separate parse pass? Recommend: investigate before committing to v1.4 estimate.
