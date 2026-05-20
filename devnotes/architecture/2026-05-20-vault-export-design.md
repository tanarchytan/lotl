# Vault Export + Web Viewer — Design

**Date:** 2026-05-20
**Status:** Design — approved sections 1-5, pending user spec review
**Author:** David Gillot (with Claude)
**Targets:** lotl v1.2.0 (proposed)

---

## Problem

Lotl ships strong agent-memory retrieval (BM25 + vec RRF + rerank, beats published baselines on LoCoMo / LongMemEval). Two ergonomic gaps remain:

1. **No human-browsable view.** Storage is SQLite blobs. To "see what the agent remembers," the user must call MCP tools or run CLI queries. Competitor framing (SwarmVault, Basic Memory) makes this concrete: drop a markdown vault, open in Obsidian, browse + visualize for free.
2. **No synthesis surface.** Knowledge graph triples (`subject / predicate / object` with temporal windows) sit in SQLite. Even when populated, there's no derived view that aggregates "everything Lotl knows about entity X."

A second agent proposed bolting SwarmVault on as a second MCP server. Rejected: two writers over overlapping concept-space ships a sync / identity-reconciliation problem masked as "routes by tool name." The honest fix is a one-way export from Lotl's KG to a markdown vault + a standalone viewer, both derived from the same SQLite source of truth.

## Goals

- **Browse**: `~/.local/share/lotl/vault/<scope>/` opens in Obsidian, grep, or any editor. Renders entity pages and an orphan-memory inbox.
- **Visualize**: `lotl vault serve` exposes a force-directed graph (cytoscape) over HTTP. Live from KG.
- **Automate**: Entity extraction and vault rebuild happen on `session_end` dream consolidation. Zero per-capture latency, zero new cron.
- **Stay agent-first**: Lotl retains write-primacy on memories and KG. No dual-writer sync. Vault and viewer are derived; regenerate cheaply.

## Non-goals

- Bi-directional sync with Obsidian (no round-trip edits).
- LLM-quality benchmarking of the extraction step (covered by separate eval if needed).
- Visualization beyond a force-directed graph (no timeline view, no 3D, etc.) in v1.
- Sub-entity dirty bits for incremental export (per-scope hash gate ships in v1; per-entity is v2).

---

## Architecture

Two surfaces, one source.

```
                    SQLite (`knowledge` + `memories` tables)
                            │
              ┌─────────────┴─────────────┐
              │                           │
              ▼                           ▼
    Dream pass (session_end)      lotl vault serve
    1. consolidate (existing)     ── HTTP, port from 7000-7999
    2. extract entities → KG      ── GET / → static viewer
    3. lotl vault export          ── GET /graph.json → live KG query
              │                           │
              ▼                           ▼
    ~/.local/share/lotl/vault/    Browser (cytoscape)
      global/                     Force-directed graph,
      project-foo/                always fresh from KG
      agent-bar/
        entities/<slug>.md
        inbox.md
        .lotl-export.json
              │
              ▼
    Obsidian / grep / editor
```

KG is the single source of truth. Files are derived. Viewer is derived. Both regenerate cheaply.

## Scope decomposition

Three independently shippable subsystems, one design doc, shipped in order:

1. **Vault export** — KG → .md files + CLI (`lotl vault export`). Ships alone, gives Obsidian browse with whatever's in the KG today.
2. **Entity extraction + dream hook** — fills the KG from memory text on session end. Makes the vault not-sparse.
3. **Web viewer** — `lotl vault serve` + HTTP + cytoscape. Adds standalone visualization.

Each is testable on its own. They share the KG contract, so a single spec keeps the contract from drifting between three sub-specs.

---

## Framework references

This spec wraps existing Lotl framework primitives, not standalone re-implementations. Authoritative documentation: `docs/ARCHITECTURE.md` (lines 68, 143, 153-163, 380-400).

| Concept | Existing framework piece | Vault usage |
|---|---|---|
| Knowledge triples | `knowledge` table — schema: `subject, predicate, object, valid_from, valid_until, scope, confidence, source_memory_id` (the last from `src/store/db-init.ts:248-267`; not listed in arch summary but present in schema) | Source of truth for entity pages |
| Triple writes | `knowledgeStore(db, triple)` in `src/memory/knowledge.ts` — auto-invalidates contradictions via `valid_until = now` | Vault never writes the table directly |
| Entity-text synthesis (downstream) | `consolidateEntityFacts(db, storeFn, opts)` driven by `LOTL_INGEST_SYNTHESIS` (default `on`) — reads triples, writes synthesis MEMORIES (not triples) | Out of vault scope. Vault reads the raw `knowledge` table directly for entity pages; does not consume synthesized memories. |
| Triple extraction from memory text | `extractWithLLM` / `extractAndStore` in `src/memory/extractor.ts` — opportunistic, only fires when LLM emits `|||` suffixes on extracted memories; raw `memory_add` paths bypass it | Subsystem 2 `runEnrichment` adds **new** extraction over orphan memories (no `knowledge.source_memory_id` link). Mirrors the existing `extractWithLLM` + `extractHeuristic` fallback pattern; writes via `knowledgeStore`. Not a wrapper around `consolidateEntityFacts` (different direction of dataflow). |
| KG-in-recall gating | `LOTL_MEMORY_KG=on` + proper-noun entity + weak top score | Out of vault scope; vault is read-side only |
| Memory provenance | `knowledge.source_memory_id` (nullable FK to memories) | Orphan-memory detection: `WHERE source_memory_id IS NULL` |

**Any divergence between this spec and `docs/ARCHITECTURE.md` is a bug in this spec.** Spec was reconciled against arch docs on 2026-05-20 after Subsystem 2 plan investigation surfaced four schema/integration drifts.

---

## Components

New files in `src/vault/`:

| File | Purpose | LOC est. |
|---|---|---|
| `export.ts` | KG → .md generator. Walks triples per scope, groups by subject, writes entity pages + inbox. Atomic write via tmp dir + rename. Also implements `vault status` subcommand reporting (path, per-scope last-export, KG row counts). | ~280 |
| `templates.ts` | Entity page template, inbox template, frontmatter schema, slug normalizer + collision disambiguation, scope-name sanitizer (for folder names). | ~120 |
| `extract.ts` | New triple-extraction over orphan memories (memories with no `knowledge.source_memory_id` link). Mirrors the existing `extractWithLLM` + `extractHeuristic` fallback pattern in `src/memory/extractor.ts` (does NOT call `extractAndStore` directly — that path expects different inputs). Writes triples via `knowledgeStore` (existing primitive, auto-invalidates contradictions). Distinct from `consolidateEntityFacts`, which is downstream synthesis (triples → memory text). | ~180 |
| `serve.ts` | Hono HTTP server. Routes: `GET /` (static viewer), `GET /graph.json?scope=X` (live KG → cytoscape JSON), `GET /assets/*`. Port discovery over 7000-7999. | ~150 |

Modified files:

| File | Change |
|---|---|
| `src/memory/decay.ts` | Add `runEnrichment(scope)` and `vaultExport(scope)` calls to the dream pass after existing consolidation step. |
| `src/cli/lotl.ts` | Register `vault export`, `vault serve [--port N]`, `vault enrich [--scope X]` subcommands. |
| `vitest.config.ts` | Add `coverage: { provider: 'v8', thresholds: { 100: true }, include: ['src/vault/**'] }`. |

New static assets:

| Path | Purpose |
|---|---|
| `assets/vault-viewer/index.html` | Cytoscape force-directed graph, fetches `/graph.json`, scope dropdown filter, "current facts only" toggle. |
| `assets/vault-viewer/viewer.js` | Cytoscape init, `cose-bilkent` layout, click → open entity .md file path. |

Vault file outputs (per scope folder):

```
~/.local/share/lotl/vault/<scope>/
  entities/
    <kebab-slug>.md       ← one per KG subject
  inbox.md                 ← flat list of memories with zero entity links
  .lotl-export.json        ← metadata: last-export timestamp, KG row count, scope hash
```

`.lotl-export.json` lets the next export be **incremental** — skip scopes whose KG hash hasn't changed since last export.

---

## Data flow

**Capture (unchanged)**

```
memory_add(text)   → memories table + FTS5 + vec
knowledge_add(spo) → knowledge table (via knowledgeStore)
```

**Dream pass (modified — runs on `session_end`)**

```
1. Existing consolidation
2. runEnrichment(scope):
     orphan_memories = SELECT id FROM memories
                       WHERE id NOT IN (SELECT DISTINCT source_memory_id
                                        FROM knowledge
                                        WHERE source_memory_id IS NOT NULL)
     for each orphan:
       → extractWithLLM-style call (chatComplete + zod parse)
                                              [extractHeuristic fallback on failure]
       → knowledgeStore(db, triple)           [source_memory_id = memory.id; existing
                                              primitive auto-invalidates contradictions]
3. vaultExport(scope):
     hash = hash(knowledge_count, max(updated_at))
     if hash == .lotl-export.json.hash: noop
     else: walk KG → render templates → write files → update .lotl-export.json
```

**Viewer**

```
Browser → GET /                   → static cytoscape SPA
       → GET /graph.json?scope=X  → live SELECT from KG
                                  → transform → cytoscape JSON
                                  → force-directed render
```

**KG → cytoscape transform**

KG row:

```js
{subject:"David", predicate:"works_on", object:"Lotl", valid_until:null, scope:"global"}
```

Cytoscape:

```json
{
  "nodes": [
    {"data":{"id":"David","label":"David","memory_count":12}},
    {"data":{"id":"Lotl","label":"Lotl","memory_count":8}}
  ],
  "edges": [
    {"data":{"source":"David","target":"Lotl","label":"works_on","active":true}}
  ]
}
```

Expired facts (`valid_until != null`) render as faded edges. UI toggle: "current facts only."

**Incremental rebuild**

- Per-scope hash gate skips no-op exports.
- Per-entity dirty bit deferred to v2.

**Port discovery**

- Default range: 7000-7999.
- Bind-test each port in order; first that succeeds wins.
- Print actual port to stdout on serve startup.
- `--port N` flag overrides with single port (hard fail if unavailable).
- `LOTL_VAULT_PORT_RANGE` env override (e.g. `8000-8999`).

**Concurrency**

- Dream pass holds advisory lock per scope. **NEW module:** `src/vault/lock.ts` — file-based lock at `~/.cache/lotl/locks/<scope>.lock` (mkdir-style atomic acquisition, stale-lock detection via PID + timestamp). No prior pattern exists in `decay.ts` — Subsystem 2 introduces this.
- `vault serve` reads only — SQLite WAL handles concurrent reads.
- Manual `vault enrich` checks lock, refuses if dream active.

---

## Error handling

| Severity | Component | Failure | Behavior |
|---|---|---|---|
| **INFO** | `export` | `.lotl-export.json` corrupt/missing | Treat as first export → full rebuild. Self-healing. |
| **INFO** | `export` | Triple references entity outside current scope | Render as greyed external node, no backlinks. |
| **INFO** | `export` | Slug collision (two entities → same slug) | Disambiguate as `<scope>-<slug>.md`. Frontmatter keeps original subject. |
| **INFO** | `extract` | Two enrichments race on same scope | Advisory lock; second waits or skips. Designed concurrency. |
| **INFO** | `serve` | Started, KG empty | Friendly empty state in viewer ("No entities yet. Run a dream pass."). |
| **WARN** | `extract` | LLM unavailable (`chatComplete` throws) | Fall back to regex extractor (`patterns.ts`). Dream continues. Quality degraded, not blocked. |
| **WARN** | `extract` | Malformed JSON from LLM | Parse with zod, skip invalid triples, log skip count. Don't poison KG. |
| **WARN** | `extract` | Memory text > extractor context window | Truncate to `LOTL_VAULT_EXTRACT_MAX_TOKENS` (default 4000). Log truncation count. |
| **WARN** | `extract` | Manual `vault enrich` while dream active | Refuse with message: "dream pass holds lock on scope X, retry after". User-recoverable. |
| **ERROR** | `export` | Vault export fails mid-write (disk full, perms) | Atomic via `<scope>/.tmp/` + rename. Keep last good vault. User must fix disk/perms. |
| **ERROR** | `serve` | Port range 7000-7999 fully occupied | Hard fail: "set `LOTL_VAULT_PORT_RANGE` or `--port`". User must act. |

**Log format:** `[vault:<component>] <SEVERITY>: <message>`

```
[vault:extract] WARN: LLM chatComplete failed (timeout), falling back to regex extractor (scope=global)
[vault:export] INFO: .lotl-export.json missing, rebuilding from scratch (scope=project-foo)
[vault:serve] ERROR: no port available in 7000-7999, set LOTL_VAULT_PORT_RANGE or --port
```

Three vault-side components: `extract`, `export`, `serve`. Matches `src/vault/` file layout.

**Logging conventions:**
- CLI-facing paths (`vault export`, `vault status`, `vault enrich` commands) use existing helpers from `src/cli/terminal.ts` (`info`, `warn`, `success`).
- Backend paths (called from dream pass, MCP server, plugin) use `console.info` / `console.warn` / `console.error` directly. Matches existing pattern in `src/memory/index.ts` and `src/memory/import.ts`.
- All emissions prefixed with `[vault:<component>]` regardless of channel.

No silent failures: every fallback emits at its severity level. ERROR rows include actionable next step in message.

---

## Testing

Framework: existing Vitest. Tests in `test/vault/`.

**Coverage target: 100% line + branch on `src/vault/`** via `vitest.config.ts` thresholds. Some defensive `catch` branches will need explicit error-injection tests.

**Unit (`test/vault/*.test.ts`)**

| File | Covers |
|---|---|
| `templates.test.ts` | Snapshot tests for entity page + inbox render, frontmatter schema, slug normalizer. |
| `export.test.ts` | KG → file walk, scope filtering, hash gating (no-op skip), atomic write + rename, error paths. |
| `extract.test.ts` | LLM mock with valid + malformed S-P-O JSON, zod rejection, regex fallback path, truncation at max-tokens. |
| `serve.test.ts` | Port discovery (mock `net` to occupy first N ports), KG → cytoscape transform, route handlers, empty-state response, port exhaustion. |
| `slug.test.ts` | Slug normalization (unicode, spaces, casing), collision disambiguation with scope prefix. |

**Integration (`test/vault/integration/*.test.ts`)**

| File | Covers |
|---|---|
| `dream-to-vault.test.ts` | Full flow: seed memories → run dream → assert KG triples written → assert files materialized → assert `.lotl-export.json` updated. |
| `serve-live.test.ts` | Boot `vault serve` with OS-assigned port, GET `/` returns SPA, GET `/graph.json?scope=X` returns valid cytoscape shape. |
| `incremental.test.ts` | Second export with no KG changes → assert zero file writes, hash unchanged. |
| `concurrency.test.ts` | Two dream passes on same scope → second blocks/skips on advisory lock. |

**Smoke (`test/vault/smoke/*.test.ts`)**

| File | Covers |
|---|---|
| `cli.test.ts` | Spawn `lotl vault export`, `lotl vault serve --port 0`, `lotl vault enrich`. Assert exit codes + stdout patterns. |

**Fixtures**

- `test/fixtures/vault-kg.json` — canonical seed KG (5 entities, 12 triples, mixed scopes, mixed `valid_until`).
- `test/fixtures/vault-memories.json` — 10 sample memories (5 with entities, 5 orphan).
- Mock `chatComplete` via `vi.mock('../../src/llm.js')` for deterministic extraction.
- `tmpdir()` for all vault outputs, auto-cleanup in `afterEach`.

**Out of scope for tests**

- Cytoscape browser rendering (third-party concern).
- Obsidian wikilink interpretation (third-party).
- LLM extraction quality benchmarks (separate eval, not unit-test territory).

**CI**

- Runs under existing `npm test`. No new workflow.
- Node 22/23 + Ubuntu/macOS already covered by `.github/workflows/ci.yml`.

---

## Configuration

New env vars (all optional, defaults shown):

| Var | Default | Purpose |
|---|---|---|
| `LOTL_VAULT_PATH` | `~/.local/share/lotl/vault` | Vault root directory. |
| `LOTL_VAULT_PORT_RANGE` | `7000-7999` | Range scanned by `vault serve` for first available port. |
| `LOTL_VAULT_EXTRACT_MAX_TOKENS` | `4000` | Per-memory truncation limit for entity extraction. |
| `LOTL_VAULT_ENRICH_ON_DREAM` | `on` | Set `off` to skip extraction step in dream pass (export still runs). |
| `LOTL_VAULT_EXPORT_ON_DREAM` | `on` | Set `off` to skip vault export in dream pass. |

OpenClaw plugin maps `plugins.entries.tanarchy-lotl.config.vault.*` → `LOTL_VAULT_*` env vars on register (existing pattern from `plugin.ts`).

---

## CLI surface

```sh
lotl vault export [--scope X]               # Manual rebuild of vault files. Honors hash gate.
lotl vault export --force [--scope X]       # Skip hash gate, full rebuild.
lotl vault serve [--port N]                 # HTTP viewer. Default: scan 7000-7999.
lotl vault enrich [--scope X]               # Manual entity extraction over orphan memories.
lotl vault status                           # Print vault path, last-export per scope, KG row counts.
```

---

## Shipping order (proposed)

1. **v1.2.0-alpha.1** — Subsystem 1: `vault export` + `vault status` + `templates.ts` + `export.ts`. Vault is sparse but real. Obsidian browse works.
2. **v1.2.0-alpha.2** — Subsystem 2: `extract.ts` + dream-hook integration. Vault becomes rich. `vault enrich` ships as escape hatch.
3. **v1.2.0** — Subsystem 3: `serve.ts` + cytoscape assets. Standalone viewer ships. Release as v1.2.0 stable.

Each alpha is testable end-to-end. Stable release gates on all three landing + 100% coverage on `src/vault/`.

---

## Open questions deferred to writing-plans

- Exact LLM extraction prompt format (system + few-shot examples).
- Cytoscape layout tuning (cose-bilkent default — may need refinement for KGs > 500 nodes).
- Whether to ship a `lotl vault open` command that detects Obsidian + opens vault folder (nice-to-have, deferred).

---

## References

- Original ask: "visualization and auto wiki would be great" (this session)
- Other agent's comparison table: Lotl vs SwarmVault / Basic Memory / Ar9av
- Existing modules touched: `src/memory/decay.ts`, `src/cli/lotl.ts`, `src/memory/extractor.ts`, `src/memory/patterns.ts`
- Existing eval baselines: `evaluate/SNAPSHOTS.md`, `docs/EVAL.md`
