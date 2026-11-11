# Handover 2: lotl, 2026-11-11 afternoon

Follows `session-2026-11-11-handover.md`. Repo `/home/tanarchy/Projects/lotl`, branch `dev`,
package `@tanarchy/lotl` 1.2.0-alpha.2.

## State in one paragraph

Everything from the first handover is committed and pushed, the E2B study is finished, the
review findings are fixed, the two defects David picked (HTTP guard plus session leak,
heuristic `memory_extract`) are fixed, the global install is rebuilt from `c457f3c`, and
E2B is switched on in `~/.config/lotl/.env` for extraction with conflicts in `guarded` mode.
`origin/dev` is at `c457f3c` plus this note. One directory is deliberately untracked:
`evaluate/local-llm/` (see "Waiting on David").

## Rules (changes since handover 1)

- David allowed push to `origin/dev` and global install without asking, for this work.
- Still not allowed without David: `v*` tags and npm publish (a tag triggers `publish.yml`).
- The repo is **public**. Nothing modelled on David's private notes goes into tracked files.
- All other rules in handover 1 stand (real index, `npm run build`, tarball install, LF).

## Commits on `dev` this session

| Hash | Title |
|---|---|
| `2b7abf1` | chore(deps): bump dependencies, pin typescript, version 1.2.0-alpha.2 |
| `65c6138` | feat(memory): opt-in recall relevance gate |
| `b9cefb3` | feat(cli): flags on memory store, memory recall and okf recall |
| `b94f651` | fix(hooks): recall, precompact and opencode plugin |
| `c43a22c` | fix(okf): dedup on the full text, not the compacted body |
| `536e549` | fix(cli,mcp,okf): multi-get, slash scopes and http transport defects |
| `5eb0ecc` | test: keep the suite off the real index and the parent env |
| `799acb6` | docs: changelog and devnotes for the 2026-11-10/11 work |
| `9c875f5` | fix(memory): keep cosine dedup inside the scope |
| `a4e49e3` | feat(memory): conflict modes, notes extraction and expansion switch |
| `f5893d8` | docs(devnotes): Gemma 4 E2B study and the review behind the fixes |
| `b921e6e` | fix(http): host and origin guard, and free abandoned mcp sessions |
| `9d95592` | fix(http): never close a session in use, and review follow-ups |
| `c457f3c` | fix(memory): notes heuristic for memory_extract without an LLM |

Verification at `c457f3c`: `npm run typecheck` passes; `npx vitest run test/` gives 1152
passed, 7 skipped, 0 failed. `799acb6` was also checked out clean and tested on its own
(1039 passed). The commits in between were not built one by one.

## E2B verdicts (details: `devnotes/metrics/local-llm-e2b-2026-11-11.md`)

| Operation | Verdict | Setting |
|---|---|---|
| Extraction, notes prompt | use | `LOTL_EXTRACT_PROMPT=auto` |
| Conflict resolution, `llm` | do not use (10 of 22 rows rewritten wrongly) | - |
| Conflict resolution, `guarded` | use (0 rewritten, 0 of 17 facts lost; near-duplicates kept as extra rows) | `LOTL_MEMORY_CONFLICT=guarded` |
| OKF compaction | do not use; not reachable today | none |
| Query expansion | do not use (20-query sample) | `LOTL_QUERY_EXPANSION=off` |
| Reflection pass, LLM rerank | not measured | - |

## Installed and configured

- Global `lotl 1.2.0-alpha.2` from `c457f3c`, tarball sha256
  `8708989962f2fac62cc85388c3c294c397a3e93b156480b662a776af41c2b2f7` (in a session scratch
  dir, may be gone; rebuild with `npm run build && npm pack`).
- `~/.config/lotl/.env`: seven lines appended (provider `api` at
  `http://127.0.0.1:8081/v1`, model `light`, `LOTL_MEMORY_CONFLICT=guarded`,
  `LOTL_EXTRACT_PROMPT=auto`, `LOTL_QUERY_EXPANSION=off`). Previous file saved as
  `~/.config/lotl/.env.bak-20261111`.
- Checked end to end on a scratch index with that `.env`: `lotl memory extract` on a
  five-line summary stored 4 subject-prefixed memories and dropped the closing thanks
  line; storing a near-duplicate with a changed version number kept both rows.
- Backup before install: `~/.cache/lotl/backup-20261111c/` (1630 memories, `quick_check` ok).
- Real index: `index.sqlite` and `-wal` modification times unchanged all session.
  `-shm` changed at 12:29, at the time of the read-only backup.
- Hooks in `~/.config/lotl/hooks/` are identical to repo `hooks/` (the config dir also
  holds three `.bak` files; `opencode-lotl-memory.mjs` is only in the repo).
- npm skipped install scripts for 8 packages (tree-sitter grammars, `onnxruntime-node`,
  `protobufjs`, lotl's own `prepare`). The ONNX binding loads. AST chunking and a real
  embedding run on the global install are still **not checked**.
- `lotl mcp` processes started before the install keep the old build until their Claude
  Code windows restart.
- The leftover copy of the real index in the first session's scratch dir
  (`real-copy.sqlite`) was deleted.

## Waiting on David

1. `evaluate/local-llm/` (harness plus labelled sets). Untracked on purpose: the fixtures
   are modelled on private notes and the repo is public. Options: keep local and add to
   `.gitignore`; push as is; rewrite to neutral topics and re-measure. `CHANGELOG.md`
   mentions the directory, so that line needs to follow the decision.
2. Tag and publish of `1.2.0-alpha.2`.
3. Restart the Claude Code windows that hold old `lotl mcp` processes.

## Open defects

- MEDIUM: knowledge-graph validity windows close the old fact at now, not at the new
  `valid_from`.
- LOW, from the reviews this session:
  - conflict UPDATE in `llm` mode rewrites the text but not the vector; only the text
    survives in `memory_history`;
  - exact-hash dedup still matches across scopes (cosine dedup no longer does);
  - a new MCP HTTP session is not counted as busy during its own `initialize`;
  - three HTTP failure-path cleanups have no test;
  - the notes heuristic cannot tell routine status from a decision (not measured on
    chatty notes) and misses a title with a date in the middle;
  - the OpenClaw nightly reflection would store E2B reflections unreviewed (unmeasured).
- LOW, carried over: batch path skips OKF compaction; `compact --force` clears draft;
  `compact` prints a huge id line; `vsearch --min-score 0` ignored; no MCP write size
  caps; collection config shared across `INDEX_PATH`; `vault export --scope X --force`
  flags never reach vault; recall hook bumps `access_count`; 144 real memories lack
  vectors; near-dup search only checks top-5 vectors; stale `metadata.original` after a
  text-only `memoryUpdate`.
- Gate limits: unchanged from handover 1.
- Housekeeping: `core.hooksPath` in this clone points at a stale Windows path, so git
  hooks do not run; GitHub reports 29 Dependabot alerts on the default branch `main`
  (not re-checked against the bumps on `dev`); CI on Node 22/23 has not run with the new
  dependencies.

## Security note

Unchanged from handover 1: a `lab-mcp` bearer token and a Poe API key were pasted into
earlier transcripts. Rotate them if those transcripts are shared.
