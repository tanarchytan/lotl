# Handover: lotl update session, 2026-11-10 to 2026-11-11

For the next agent picking this up. Repo `/home/tanarchy/Projects/lotl`, branch `dev`,
package `@tanarchy/lotl` 1.2.0-alpha.2. Owner: David Gillot (tanarchytan), creator of lotl.

## State in one paragraph

Dependencies, version, hooks, CLI flags, the recall relevance gate, eleven stress-test defect
fixes and the OKF dedup fix are done, tested (1039 passed, 7 skipped, 0 failed at the last
full run) and installed globally from a tarball. **Nothing is committed.** About 35 files are
modified or new on `dev`. No commit, push, tag or publish has been authorized. A study on
using the local Gemma 4 E2B model for lotl's LLM operations was started and stopped early
(see "In progress").

## Rules David set (keep applying)

- **Agent gates:** Fable main session plans, orchestrates, decides. Opus agents do analysis
  and bigger builds. Sonnet agents implement code and run installs/tests. Haiku for watchers.
  One agent at a time in the same tree. Agents never commit or push.
  Recorded in `~/.claude/CLAUDE.md` (`# model routing`) and the project memory.
- **No commit / push / tag / publish without David saying so.** A `v*` tag triggers
  `publish.yml` to npm dist-tag `alpha`.
- **Global install = packed tarball, never `npm link`:**
  `npm run build` -> `npm pack` -> `npm i -g <tgz>` -> `mise reshim`.
- **Never touch the real index** `~/.cache/lotl/index.sqlite` from tests or agents. Use a
  scratch copy (`sqlite3 -readonly ... ".backup ..."`), `INDEX_PATH=<copy>`,
  `LOTL_RECALL_NO_TOUCH=on`. Never write to the DB with sqlite3.
- Never auto-run `lotl collection add / embed / update` on the real index.
- Always `npm run build`, never bare `node scripts/build.mjs`. Keep files LF.
  Run `graphify update .` after code changes.
- Replies in caveman mode (terse), execute immediately.
- Nothing from the memory index or repo goes to a cloud API without David's say-so.

## What is installed and running

- Global `lotl 1.2.0-alpha.2`, installed 2026-11-11 about 10:30 from the "gate2" tarball,
  sha256 `0eb545ffbd09b51a747b2f2b21d7d19304f73a0da6f2c63c177b551796372e10`.
  The tarball lived in a session scratch dir under `/tmp` and may be gone; rebuild with
  `npm run build && npm pack` if needed.
- Hooks in `~/.config/lotl/hooks/` are identical to repo `hooks/` (checked 2026-11-11).
- Real index: 1630 memories at last check, `quick_check` ok.
- Backups: `~/.cache/lotl/backup-20261110/` (before everything),
  `~/.cache/lotl/backup-20261111/` (after hash migration),
  `~/.cache/lotl/backup-20261111b/` (before the gate2 install).
- `lotl mcp` processes started before the gate2 install still run the previous build
  (PIDs 3932670 and 4025359 on 2026-11-11). Restarting Claude Code windows fixes that.
- npm printed an install-scripts warning on the global install (scripts for
  `onnxruntime-node`, tree-sitter grammars and others did not run). CLI and FTS recall work.
  **Not re-checked on the global install:** local ONNX embedding and AST chunking.

## Why memory was broken (root causes, all fixed)

1. `lotl` was installed under node 26.12.0; mise moved to 26.13.0, so CLI, MCP and hooks
   were dead. The hook fails open, so this was silent. A mise node bump drops global npm
   packages.
2. Repo `.mcp.json` used `lotl.cmd` (Windows) and a private empty `INDEX_PATH`.
3. `LOTL_OKF=off` in `~/.claude/settings.json` versus `LOTL_OKF=on` in `.mcp.json`
   ("half OKF, half database").
4. `~/.config/lotl/.env` sets `LOTL_ONNX=on` and `.env` wins over process env, so the hook
   loaded models on every prompt.

## Work done (all uncommitted)

- **Deps:** better-sqlite3 13, vitest 5.1, MCP SDK 1.32.2, transformers 4.3.2,
  web-tree-sitter 0.27.2, zod 4.6.7, TypeScript 7.0.2, @types/node 26, and others.
  `engines` still `>=22`; CI on Node 22/23 has not been run with these.
- **CLI:** `memory store --scope/--category/--importance`,
  `memory recall --scope/--limit/--min-relevance`, `okf recall --min-relevance`.
- **Hooks:** recall hook forces embed and rerank off, passes
  `--min-relevance=$LOTL_RECALL_MIN_RELEVANCE` (default 0.6, `off` disables), skips prompts
  under 8 characters; precompact hook resolves the index path like lotl does;
  opencode plugin fixed.
- **Recall relevance gate** (`src/memory/relevance.ts`, constants in
  `src/store/constants.ts`): opt-in, default recall byte-identical.
  - Coverage rule: at least 2 informative terms, IDF-weighted coverage >= R.
  - Specificity floor (2026-11-11): on indexes of 100+ memories, sum of IDF of matched
    terms >= ln(N) + 1.0; two-word prompts get a 2.5 credit when exactly one memory holds
    both words adjacent.
  - Numbers and limits: `devnotes/metrics/recall-relevance-gate-2026-11-10.md`.
- **Stress test:** `devnotes/sessions/session-2026-11-10-stress-test.md`, 11 defects fixed.
- **OKF dedup:** `src/memory/hash.ts`; `content_hash` is the hash of the full original
  text; migration with rowid watermark in `src/store/db-init.ts`.
- **Test isolation:** `test/vault/smoke/cli.test.ts` now sets `INDEX_PATH`. Before that fix
  the suite opened the real index once and ran the hash migration on it (no data lost).

## In progress: Gemma 4 E2B as lotl's LLM

Finding: with no LLM provider configured, `memory_extract` uses a heuristic that stored one
useless fragment from a nine-paragraph summary. The Stop hook tells every session to use
`memory_extract`, so automatic saving currently captures very little. Workaround used this
session: `memory_add_batch`.

David's decision: the local 26B model is too slow. Options are E2B locally or cloud.

What is known:
- `llm-light.service` (user unit) serves Gemma 4 E2B via llama.cpp on
  `http://127.0.0.1:8081/v1`, model id `light`. Shared service: do not restart it, one
  request at a time.
- lotl can use it with no code change:
  ```
  LOTL_QUERY_EXPANSION_PROVIDER=api
  LOTL_QUERY_EXPANSION_URL=http://127.0.0.1:8081/v1
  LOTL_QUERY_EXPANSION_API_KEY=local
  LOTL_QUERY_EXPANSION_MODEL=light
  ```
  These are **not** set in `~/.config/lotl/.env` yet.
- One probe on a scratch index: 17 memories in 12 s. Problems: facts too atomic and without
  context, one fabricated detail, one paragraph dropped, two filler reflections.
- The same provider also drives conflict resolution (can update or delete memories),
  OKF compaction and query expansion. E2B is untested on those.

An Opus agent was asked to map the LLM callers, build labelled eval sets, measure and tune
extraction, measure conflict resolution and compaction, and add guards (likely a
per-operation provider switch). It was asked to stop early on 2026-11-11.
Its checkpoint: see "E2B agent checkpoint" at the end of this file and
`devnotes/metrics/local-llm-e2b-2026-11-11.md`.

## Open defects (not fixed)

- MEDIUM: no Host/Origin (DNS rebinding) guard on `lotl mcp --http` and `lotl memory serve`;
  abandoned HTTP sessions are never freed (350 MB to 1.09 GB in the stress test).
- MEDIUM: knowledge-graph validity windows close the old fact at now, not at the new
  `valid_from`.
- MEDIUM: heuristic `memory_extract` is close to useless on structured summaries (above).
- LOW: batch path skips OKF compaction; `compact --force` clears draft; `compact` prints a
  huge id line; `vsearch --min-score 0` ignored; no MCP write size caps; collection config
  shared across `INDEX_PATH`; `vault export --scope X --force` flags never reach vault;
  recall hook bumps `access_count`; 144 real memories lack vectors; near-dup search only
  checks top-5 vectors; stale `metadata.original` after a text-only `memoryUpdate`.
- Gate limits: three-word chatter meeting in one long memory still injects; "deploy to
  prod" returns nothing (22 memories hold the phrase); single-project indexes of 100+
  memories return nothing for "<project> <word>".

## Decisions waiting on David

1. Commit / push / tag the work on `dev`.
2. Enable E2B in `~/.config/lotl/.env`, and whether conflict resolution may use it.
3. Which open defects to fix next.

## Security note

A bearer token for the `lab-mcp` server was printed into this session's transcript by
mistake on 2026-11-10. Rotate it if the transcript is shared. `~/.config/lotl/.env` also
notes a Poe API key pasted in chat on 2026-04-17.

## Suggested first steps for the next agent

1. `git status --short` and `npx vitest run test/` to confirm the tree is as described.
2. Read the E2B checkpoint, then ask David whether to resume it.
3. Check ONNX embedding and AST chunking on the global install.

## E2B agent checkpoint

The agent was hard-stopped on 2026-11-11 about 11:10 before it wrote a checkpoint or a
devnote. `devnotes/metrics/local-llm-e2b-2026-11-11.md` does **not** exist. What follows
was read from the tree and its scratch files by the main session afterwards.

**Its last words:** "Letting the in-flight held-out run finish. Meanwhile, wiring the
conflict mode into `memoryStore` so the tree is consistent." So the wiring in
`src/memory/index.ts` may be incomplete. Review that diff first.

**Files it changed or added (uncommitted, unreviewed):**
- `src/memory/extractor.ts` (about +297 lines: a new "notes" extraction path for the LLM)
- `src/memory/conflict.ts` (new, 121 lines: `LOTL_MEMORY_CONFLICT` = `llm` | `guarded` |
  `off`, with `resolveConflict`, `guardConflict`, `conflictMode`)
- `src/memory/index.ts` (about +187/-84: imports and uses the conflict mode near line 695)
- `test/memory-extract-notes.test.ts`, `test/memory-conflict-guard.test.ts`,
  `test/memory-conflict-mode.test.ts` (new)

**Verified after the stop:**
- `npm run typecheck` passes.
- The three new test files pass (32 tests).
- **Not verified:** the full suite (last known good 1039 passed / 7 skipped was before
  these edits), `npm run build`, CHANGELOG, `.env.example`, CLAUDE.md, `graphify update .`.
  The global install does not contain any of this.

**Extraction numbers it measured with E2B** (from its `final-extract.log`; `fbase1` is the
original prompt, `fnotes1` is its new notes prompt):

| Split | Prompt | Recall of required facts | Standalone | Unsupported | Filler | Memories per input | p50 latency |
|---|---|---|---|---|---|---|---|
| dev (16 inputs) | original | 74.5% | 43.8% | 3.7% | 10.0% | 13.7 | 6.4 s |
| dev (16 inputs) | notes | 96.2% | 100% | 0.0% | 0.0% | 6.9 | 3.0 s |
| held-out (8 inputs) | original | 74.1% | 42.0% | 2.0% | 4.0% | 12.5 | 5.8 s |
| held-out (8 inputs) | notes | 87.9% | 100% | 9.2% | 1.5% | 8.1 | 2.7 s |

Read with care: the held-out unsupported rate went up from 2.0% to 9.2% with the new
prompt, the metric definitions were never written down, and the agent tuned through seven
prompt rounds on dev. No JSON parse failures in any run.

**Not measured or unknown:** conflict resolution and compaction accuracy with E2B (labelled
sets were written and hashed, but no result files exist for them), whether the
`guarded` mode's rules match any evidence, query expansion with E2B.

**Scratch files** (under `/tmp`, session-specific, will not survive a reboot):
`/tmp/claude-1000/-home-tanarchy-Projects-lotl/3cb5817e-417a-469f-b2e1-9d54bde7153d/scratchpad/e2b/`
holds `runs/*.json` (per-run results), `final-extract.log`, `final-extract.sh`,
`labels-frozen.sha256` and `real-copy.sqlite` (a copy of the real index: delete it when
done). The eval sets `extraction-set.mjs`, `conflict-set.mjs`, `compaction-set.mjs` are
named in `labels-frozen.sha256` but their location was not confirmed. If they are lost,
the eval must be rebuilt.

**Real index:** mtimes of `index.sqlite`, `-wal`, `-shm` were identical before and after
the agent's work (08:46:21, 10:30:20, 10:30:20).

**To resume:** review the three source files, run the full suite and build, then either
finish the study (conflict and compaction measurements, devnote, CHANGELOG, docs) or revert
those six files with `git checkout -- src/memory/extractor.ts src/memory/index.ts` plus
deleting the four new files. Note `git checkout` on `index.ts` and `extractor.ts` would
also drop this session's earlier uncommitted edits to those files, so prefer reviewing
over reverting.
