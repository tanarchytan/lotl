# Session 2026-11-10 — install-realistic stress test of 1.2.0-alpha.2

Goal: test what users get after today's dependency majors (better-sqlite3 13 /
SQLite 3.53, transformers 4.3.2 / onnxruntime-node 1.30 / sharp 0.35,
web-tree-sitter 0.27 + Go/Python grammars 0.25, MCP SDK 1.32.2, zod 4.6,
vitest 5, TS 7) and the new CLI flags, hooks and recall relevance gate.
Unit suite was green before this (994 passed, 7 skipped); this is about load,
concurrency, crashes and a real tarball install.

## Method

- `npm run build`, `npm pack`, `npm i --prefix <scratch>/prefix -g <tgz>` with
  npm 11 defaults (install scripts of tree-sitter-*, onnxruntime-node,
  protobufjs, sharp were skipped). Every command ran `<prefix>/bin/lotl` under
  Node 26.13.
- Isolation: every process got `INDEX_PATH` under scratch plus scratch
  `HOME`, `LOTL_CONFIG_DIR`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`; inherited
  `LOTL_*`/`XDG_*` vars were stripped. The real `~/.cache/lotl/index.sqlite`
  was only ever file-copied (scenario 11). The real model download cache
  (`~/.cache/lotl/transformers`) was reused read/write through
  `LOTL_TRANSFORMERS_CACHE_DIR`; all models were already present, no download
  happened.
- Harness: stdlib Python under the session scratchpad (`stress/harness/`,
  `run_all.py` runs everything and prints the table). Not added to the repo;
  the regressions that belong in the suite are vitest tests (below).
- Corpus: seeded generator, every item has a unique marker so expected counts
  are exact. ~45% short, 25% medium, 22% long (8-40 lines, all over the
  600-char OKF floor), 4% FTS-hostile / unicode (quotes, parentheses,
  `AND OR NOT NEAR`, `*`, `:`, `-`, `$(...)`, CJK, emoji, ZWJ, RTL, NUL),
  2% single tokens of 2k-12k chars, 2% `<private>` spans; 7 scopes (including
  `ünïcödé-scope` and `scope with spaces`), 6 categories.

## Scenario table

All numbers are measured on this machine (16 cores) unless marked inferred.
Recall latency is wall time of a full CLI process (spawn, open, query), which
is what the hooks pay.

| # | Scenario | Result | Key numbers |
|---|---|---|---|
| 1 | Volume, 25k memories FTS-only + 20k with ONNX | PASS (after fixes) | MCP batch ingest ~10k memories/s FTS-only, 31/s with ONNX embedding. DB 121 MB at 25k (FTS-only), 133 MB at 20k with 384-d vectors. CLI recall p50/p95: 0.13/0.14 s at 1k, 0.11/0.12 s at 5k, 0.14/0.15 s at 25k; gate on is the same or faster (0.12/0.13 s at 25k). ONNX on: 1.1-1.5 s p50 at 1k/5k/20k (model load per process). CLI `memory store` p50 0.11 s. 200 CLI stores + 25k batch = exact count; `memory stats` total equals sqlite count. No `<private>` text in memories, metadata or history. integrity_check + FTS integrity ok |
| 2 | Concurrency: 12 CLI writers x 60, 8 CLI readers looping, 1 MCP stdio client, 4 MCP HTTP sessions, one index | PASS | 22 s, 0 SQLITE_BUSY / locked, 0 failed ops; writes in = rows stored (720 CLI, 2200 stdio, 2000 HTTP); 50 shared texts written 132 times by all writers -> 50 rows (no dedup race hit). WAL peak 11.7 MB, 0 after. 16 processes creating one fresh DB at once: all ok |
| 3 | Crash safety: 30 x kill -9 (MCP batch writer, CLI store loop, compact --apply, decay + vacuum), 40% with ONNX | PASS | quick_check ok and memories == FTS rows after every kill; killed batches all-or-nothing (no partial 400-row batch); 0 vec rows without a memory; `lotl status`, `lotl cleanup`, reopen + store + recall fine; final 79.6k rows integrity ok |
| 4 | ONNX on the tarball install | PASS (vsearch at default `--min-score 0.3` misses the paraphrase; at 0.05 it ranks the doc first) | onnxruntime-node 1.30.0, sharp 0.35.5 (libvips 8.18.7), better-sqlite3 13 (SQLite 3.53.4), sqlite-vec 0.1.9 all load although npm skipped their scripts. 401 vec rows, dim 384. Near-duplicate -> `Duplicate:` (cosine dedup). Paraphrase with no shared keywords -> target top-1 at score 1.00 (FTS-only: 0.01). Profile shows embed 156 ms, vec 11 ms, rerank+post 233 ms. `lotl embed` + `vsearch` ok |
| 5 | AST chunking + doc commands | PASS (after fixes; two first-run failures were harness bugs: JS UTF-16 offsets read as Python code points, and a shared config dir) | `lotl status`: typescript, tsx, javascript, python, go, rust all available. Direct `getASTBreakPoints` from the installed dist: 82/94/77/52/32/46 points (ts/tsx/js/py/go/rs), every one lands exactly on a declaration with CJK/emoji before it (no byte vs UTF-16 offset drift on the new grammars). `embed --chunk-strategy auto`: chunk cuts on AST points ts 4/4, tsx 4/4, js 3/3, go 3/3, rs 2/2, py 1/3 (other 2 on the blank/comment line just above the `def`); regex cuts on AST points: 0. update, embed, search, vsearch, query, get, multi-get, cleanup, vacuum all exit 0 |
| 6 | MCP protocol, SDK 1.32, stdio + HTTP | PASS except DNS-rebinding guard (not fixed) | 31 tools on both transports; every tool succeeds with valid input; every schema-invalid call (missing required, wrong types) returns a structured error; non-JSON line / unknown method / unknown tool: server stays up. 3000 mixed calls: 0 errors, 443 calls/s stdio, 350 calls/s HTTP. RSS: stdio read mix (search/okf_recall/list on 25k) plateaus at ~300 MB from call 3000 to 15000; 80k `memory_add` grow it 304 -> 454 MB as the DB grows by 80k rows (consistent with the 64 MB page cache + 256 MB mmap filling, inferred, not proven bounded); HTTP with DELETE flat at ~350 MB over 1500 sessions; abandoned HTTP sessions are never freed (see defects) |
| 7 | OKF on 25k | FAIL on 2 checks (not fixed, design) | Write path: 3058-char text stored as 413-char body, `metadata.original` exact, `[draft]` in index; `okf get` returns the full original. `okf index` / `recall` 0.09-0.12 s, `okf_timeline` 10 ms, paged `okf_index` (500 rows) 15 ms. `memory compact` on 7965 over-budget rows: dry-run 0.2 s, `--apply` 1.9 s (all flagged draft), `--apply --force` 3.2 s, every row keeps `metadata.original`, FTS mirrors the new text, idempotent. 0 concept-id prefix collisions in 25k |
| 8 | Knowledge graph | FAIL on 3 window checks (not fixed, design) | 3600 adds at 1820/s, stats exact (400 entities, 1200 active, 2400 expired); re-add returns same id; double invalidate safe; 3 concurrent writers x 200 on 20 subject+predicate pairs: never two active facts |
| 9 | Decay, export/import, memory serve | PASS except DNS-rebinding guard (not fixed) | `memory decay` on 25.2k: 0.15 s. Export 25,204 (33 MB JSON) in 0.27 s, import into a fresh DB 1.4 s, counts and per-scope counts equal, re-import all duplicates. After the fix the round trip keeps `metadata.original`, verification, draft, actor. `memory serve`: UI + `/api/stats`, `/api/memories` (list, `q=`, scope + offset), `/api/memory/:id` all 200 in 1-60 ms, 404s correct, stops on SIGINT |
| 10 | Hooks end to end (installed `hooks/`) | PASS | Recall hook: 4 branch/gate combos x 14 prompts incl. `$(...)`, backticks, quote breaks, `${IFS}`, NUL, `--min-relevance=...`, `--index=...`, markdown bullet, `--help`: exit 0 + valid JSON every time, canary file never created, no usage/help text injected. Malformed stdin, `{}`, empty, null/number prompt, short prompt, binary, `.lotl-norecall`, 50 KB, 200 KB: all `{}`. 100 prompts: p50 0.127 s / p95 0.139 s (OKF branch), 0.129 / 0.140 s (memory branch); with `.env` `LOTL_ONNX=on`: p95 0.142 s. Save hook blocks at 15 and 31, corrupt state file ok. PreCompact: block, block, release after a write, new cycle blocks, auto never blocks, in both the default and the `INDEX_PATH`/`XDG_CACHE_HOME` layout (after the fix) |
| 11 | Upgrade: copy of the real DB opened by the new build | PASS | 1626 memories in the pristine copy (read-only sqlite3) == copy after the new build opened it == `memory stats`. No schema change needed (56 objects before and after). integrity_check + FTS integrity ok, 1482 vec rows dim 384, 0 orphans. stats/status/okf index/recall/gated recall 0.11-0.23 s. System sqlite3 3.54 reads the file (3.54 is newer, so this does not prove downgrade safety) |

Final verification: after the last code change the whole harness ran again
against the final tarball (scenario 1 with `--skip-onnx`; its ONNX half above
was measured on an earlier build from this session, before the batch slicing
change, which only regroups the INSERTs). Remaining failed checks are exactly
the not-fixed items below: KG windows (3 checks), DNS-rebinding guard on both
HTTP servers (2), OKF compaction dedup and forced-draft (2).

## Defects

### Fixed (each with a regression test; suite green)

1. **HIGH — OpenCode plugin was a silent no-op under OpenCode.** It called
   Bun's `$` as `$({ env })`; Bun throws "Please use '$' as a tagged template
   function" and the fail-open catch swallowed it, so no recall and no save
   ever happened. Also had no FTS-only env (a `.env` `LOTL_ONNX=on` loads
   models per prompt) and no relevance gate. Repro: `bun -e 'Bun.$({env:{}})'`.
   Fix in `hooks/opencode-lotl-memory.mjs`; test `test/opencode-plugin.test.ts`
   (fake Bun `$` that throws unless used as a tagged template; fails 3/5 on the
   old file).
2. **HIGH — `memory import` lost `metadata`.** Export writes the metadata
   column, import ignored it: a backup/restore round trip dropped
   `metadata.original` (the only full copy of an OKF-compacted memory),
   verifications, draft status and actor. Repro: store a 3 KB memory (gets
   compacted), `memory export x.json`, `memory import x.json` into a fresh
   index, the row has no `original`. Fix `src/memory/import.ts`; test
   `test/memory-import-roundtrip.test.ts`. Still reset on import: `created_at`,
   tier, access/used counts (not fixed; needs a batch API change).
3. **MEDIUM — `memory_add_batch` with 4096+ items failed as a whole** with
   "too many SQL variables" (8 params per row, SQLite cap 32766; exactly 4095
   passes). Repro: one `memory_add_batch` call with 4096 items. Fix: slice the
   IN lookup and the multi-row INSERTs at 500 rows (`src/memory/index.ts`).
4. **MEDIUM — same text twice in one batch stored twice** (hash dedup only
   looked at existing rows). Repro: `memory_add_batch` with `[{text:"a b c"},
   {text:"a b c"}]` -> "2 created". Fix in the same function: later copies
   resolve to the first copy's id. Test for 3+4: `test/memory-batch-limits.test.ts`.
5. **MEDIUM — PreCompact manual gate never released when the index is not at
   `~/.cache/lotl/index.sqlite`** (`INDEX_PATH` or `XDG_CACHE_HOME`): every
   `/compact` blocked again. Fix: resolve the path like `getDefaultDbPath()`.
   Test `test/hooks-precompact.test.ts` (fails 2/3 on the old loop).
6. **LOW (perf) — `lotl mcp --http` ran the startup decay pass on every new
   session** (one McpServer per session). `runDecayPass` on 25k memories:
   21 ms warm / 49 ms cold, synchronous (blocks the event loop) and a write
   transaction, per session. Now once per database per process; after the
   fix a new session's `initialize` takes 3.4 ms p50 on a 105k-row index.
   Test `test/mcp-decay-once.test.ts`.
7. **LOW — prompts starting with `-` recalled nothing** in the recall hook and
   OpenCode plugin (a markdown bullet or `--help ...` parsed as flags, CLI
   printed usage, hook emitted `{}`). Fix: options, then `--`, then the prompt.
   Measured in scenario 10 (bullet prompt now injects).
8. **LOW — `lotl memory store "   "` / all-`<private>` text printed a Node stack
   trace.** Now `Error: ...`, exit 1. Test in `test/cli.test.ts`.
9. **LOW — `okf get` "not found" for memories whose scope contains `/`**
   (`team/backend`), although `okf index` lists that id. Fix in
   `SqliteConceptSource.getMemoryRow`; test in `test/okf-source.test.ts`.
10. **LOW — `lotl multi-get a/x.md,a/y.md`** (comma list of `collection/path`,
    the form `lotl get` takes) printed "File not found" for each and exited 0.
    Now resolves, and nothing found exits 1. Tests in `test/cli.test.ts`.
11. **LOW — `lotl mcp --http` returned a bare 500 for a malformed JSON body.**
    Now 400 with JSON-RPC `-32700` on `/mcp`, 400 JSON on `/query`. Test in
    `test/mcp.test.ts`.

### Not fixed (design decision or bigger than a contained fix)

1. **HIGH — OKF write-time compaction makes dedup lossy.** `memoryStore`
   hashes the compacted body (first 6 non-empty lines, max 500 chars), so two
   different long memories with the same head are treated as duplicates and
   the second one is dropped (the caller sees `Duplicate:`; its text is not
   kept anywhere). Repro:
   ```sh
   H=$(for k in 0 1 2 3 4 5; do echo "shared header line $k for the nightly backup job report"; done)
   lotl memory store "$H
   UNIQUE TAIL A: backup FAILED on vol-a $(printf 'pad %.0s' $(seq 150))"   # Stored: X
   lotl memory store "$H
   UNIQUE TAIL B: backup ok on vol-b $(printf 'pad %.0s' $(seq 150))"       # Duplicate: X
   ```
   Templated memories (handoff notes, session logs with fixed headers) hit
   this. Options: hash the pre-compaction text, or salt the body hash with a
   hash of `metadata.original`. Touches dedup semantics, so not changed here.

   **FIXED 2026-11-11.** Rule: a store may answer `duplicate` only when the
   full incoming text (after `<private>` redaction) is already recoverable
   from the existing row. `content_hash` is now the hash of the full text,
   `metadata.original` when the row has one, else `text`, through one helper
   (`memoryRowHash` in `src/memory/hash.ts`) used by single store, batch,
   import, `memoryUpdate`, `memory compact` and the LLM merge. Cosine dedup
   (and the LLM conflict step behind it) only runs between two uncompacted
   texts: it is skipped when the new memory was compacted and never matches a
   compacted row, so those are stored as new rather than merged. Existing
   compacted rows get their hash recomputed from `metadata.original` on open
   (watermarked on rowid in `store_config`; writes only `content_hash`, with
   the FTS update trigger dropped for that UPDATE; no unique index on the
   hash, so rows with identical originals are all kept). Repro above now
   prints `Stored:` twice and `okf get` returns each full text. Tests:
   `test/memory-dedup-full-text.test.ts`, `test/memory-dedup-cosine.test.ts`.
   Side finding: before this fix the same long text stored via `memory_add`
   and via `memory_add_batch` or import never deduped either (body hash vs
   full-text hash).
2. **MEDIUM — KG validity windows.** `knowledgeStore` closes the previous fact
   with `valid_until = now` (wall clock), not the new fact's `valid_from`.
   Backdated facts overlap: after `lives_in Lisbon (from -300d)` then
   `lives_in Porto (from -60d)`, `knowledge_search as_of=-30d` returns both.
   Future-dated facts open a gap: adding `Faro (from +30d)` closes Porto now,
   so `as_of=+10d` returns nothing. Same overlap on every bulk subject
   (`as_of -150d` returns value-0 and value-1).
3. **MEDIUM — no DNS-rebinding guard on the two local HTTP servers.**
   `lotl mcp --http` accepts `initialize` with `Host: attacker.example` and
   `Origin: http://attacker.example` (200), and `lotl memory serve` (no token
   by default) answers any Host. A web page that rebinds its name to
   127.0.0.1 can read, edit and delete memories while either runs. Fix
   options: SDK transport `enableDnsRebindingProtection` + `allowedHosts`, and
   a Host allowlist in `memory serve`. Behaviour change, so left for a decision.
4. **MEDIUM — abandoned HTTP MCP sessions are never freed.** Sessions only go
   away on DELETE; there is no idle timeout. 1500 sessions without DELETE took
   the server from 350 MB to 1.09 GB RSS (~500 KB each); with DELETE it stayed
   flat at ~350 MB. Clients that crash or reconnect without DELETE grow it
   without bound. Needs an idle TTL.
5. **LOW — batch vs single inconsistencies.** `memory_add_batch` reports a
   whitespace-only item as `duplicate` with id `""` (no error) while
   `memory_add` errors; an all-`<private>` item fails the whole batch.
   The batch path also skips the OKF write-time budget, so long memories
   stored by batch (and by import) are not compacted until `memory compact`.
6. **LOW — `memory compact --apply --force` (heuristic, low confidence)
   clears `draft`**, while the write path marks the same heuristic compaction
   `draft`. 7965/7965 forced rows ended without `draft`.
7. **LOW — `memory compact` prints every review id on one line**: 131 KB of
   stdout for 7965 rows, dry run and `--apply` alike.
8. **LOW — `lotl vsearch --min-score 0` is ignored**: `vectorSearch` does
   `minScore: opts.minScore || 0.3`. No test infra for vsearch without models,
   so left.
9. **LOW — no input size caps on MCP writes**: `memory_add` takes a 2 MB text
   (stored whole in `metadata.original`), `knowledge_add` a 200 KB subject.
10. **LOW (design) — collection config lives in the config dir, not the
    index.** With a per-project `INDEX_PATH`, `lotl status` lists and
    `lotl update` indexes every collection in `~/.config/lotl/index.yml`.
    Seen in the harness, where scratch indexes shared one config dir.
11. **INFO — recall writes.** Already known (recall bumps `access_count`).
    Two side effects seen here: the `memories_au` trigger fires on any UPDATE,
    so each bump rewrites the row's FTS entry (105 recalls: 1050 bumps, DB
    +0.5 MB, FTS data did not grow); and a recall that injects something
    writes the WAL, which can release the PreCompact gate without a save
    (the hook comment says recall does not write).
12. **INFO — 144 of 1626 memories in the real index have no vector** (stored
    while ONNX was off), so semantic recall never sees them. Measured on the
    copy; whether a backfill command exists was not checked.

## Not tested / inconclusive

- OpenCode itself (not installed): the plugin was tested with real Bun `$`
  semantics in a probe and with a `$` stub that enforces them, plus the
  `execFile` fallback against a fake `lotl`.
- First-run model download: models were already cached and the cache was
  reused.
- Downgrade readability: the only other SQLite here is 3.54 (newer).
- LLM compaction / conflict resolution paths (no LLM configured).
- macOS, Windows, Codex hooks.
- `lotl vault` (known dispatcher issue, skipped).

## Repo changes

- `hooks/opencode-lotl-memory.mjs` — Bun `$` tagged-template call, timeout, FTS-only env, gate, OKF branch, `--`.
- `hooks/lotl_recall_hook.sh` — prompt after `--`.
- `hooks/lotl_precompact_hook.sh` — index path resolution.
- `src/memory/index.ts` — batch slicing + in-batch dedup.
- `src/memory/import.ts` — keep metadata on import.
- `src/cli/lotl.ts` — clean error for empty store text; multi-get `collection/path` + exit 1.
- `src/okf/source.ts` — slash scopes in `getMemoryRow`.
- `src/mcp/server.ts` — 400 on malformed JSON; decay once per DB.
- Tests: `test/opencode-plugin.test.ts`, `test/memory-batch-limits.test.ts`,
  `test/memory-import-roundtrip.test.ts`, `test/hooks-precompact.test.ts`,
  `test/mcp-decay-once.test.ts`, additions to `test/cli.test.ts`,
  `test/okf-source.test.ts`, `test/mcp.test.ts`.
- `CHANGELOG.md` — bullets under Unreleased / Fixed.
