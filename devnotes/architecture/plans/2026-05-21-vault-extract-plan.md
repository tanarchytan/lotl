# Vault Subsystem 2 — Entity Extraction + Dream Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retroactively extract subject-predicate-object triples from memories that never went through `extractAndStore`, plug the extractor into the dream pass, and ship `lotl vault enrich` as a manual escape hatch.

**Architecture:** New `src/vault/extract.ts` walks "orphan" memories (no row in `knowledge.source_memory_id`) per scope, calls `chatComplete` with a strict zod-validated triple prompt, writes triples through the existing `knowledgeStore` path, and falls back to `patterns.ts` regex on LLM failure. `runEnrichment(db, scope)` is invoked from a new step in `runCleanupPass` gated by `LOTL_VAULT_ENRICH_ON_DREAM`. A file-based advisory lock at `~/.cache/lotl/locks/<scope>.lock` prevents concurrent runs. CLI handler `lotl vault enrich` lives in `src/cli/vault-commands.ts` (created by Subsystem 1; this plan only adds a function).

**Tech Stack:** TypeScript (ESM), Node 22+, Vitest, better-sqlite3, zod (existing dep), the existing `chatComplete` LLM abstraction via `getRemoteLLM()`, the existing `knowledgeStore` writer, the existing `classifyMemory` / `hasMemorySignal` regex fallback.

> **Pacing note (Vanguard profile):** Tasks 1 and 7 are the slow "patience phase" — Task 1 forces an investigation pass against the real database before you write a line of `extract.ts`, and Task 7 hand-tunes the LLM prompt against fixture memories until parse rates clear ≥80%. Resist the urge to skip into Task 4. The whole subsystem ships sparse trash without those two steps.

---

## Ground truth vs spec — naming reconciliation

The spec (Section "Data flow", line 134-137) writes:

> `orphan_memories = SELECT id FROM memories WHERE id NOT IN (SELECT DISTINCT provenance FROM kg_triples WHERE provenance IS NOT NULL)`

The actual schema (verified by reading `src/store/db-init.ts:248-267`) uses:
- Table: `knowledge` (not `kg_triples`)
- Column: `source_memory_id` (not `provenance`)
- Scope column: `knowledge.scope TEXT NOT NULL DEFAULT 'global'`

The plan uses the real schema names throughout. Spec text is treated as design intent, not literal SQL.

Memories table (`src/store/db-init.ts:182-198`) has its own `scope TEXT NOT NULL DEFAULT 'global'` column and `idx_memories_scope` index — both joins can stay scope-local.

There is **no `extracted` boolean column on `knowledge`**. The spec's "extracted=true" flag is also absent in code. The plan does NOT add this column (out of scope; Subsystem 1's `export.ts` should not require it either — entity provenance is already inferable from `source_memory_id IS NOT NULL`).

---

## File structure

### Files this plan creates

| Path | LOC est. | Responsibility |
|---|---|---|
| `src/vault/extract.ts` | ~180 | Public entry: `runEnrichment(db, opts)`. Internal: orphan query, LLM call with zod, regex fallback via `patterns.ts`, triple insert via `knowledgeStore`. |
| `src/vault/lock.ts` | ~60 | Tiny file-based advisory lock (mkdir-atomic) with `acquire()` / `release()` / `withLock()` wrapper. Shared by enrichment + future export. Even though export was Subsystem 1's job, the spec said the lock comes from "existing pattern in decay.ts" which doesn't exist — owning it here is the smallest safe move. |
| `test/vault/extract.test.ts` | ~280 | Unit tests for `runEnrichment`: orphan selection, LLM happy path, malformed JSON fallback, regex fallback, truncation, env-var gate. |
| `test/vault/integration/dream-to-vault.test.ts` | ~120 | End-to-end: seed memories → call `runCleanupPass` with enrichment on → assert KG rows materialize → (if Subsystem 1 has shipped) assert vault files written. Test skips file-write assertions if `src/vault/export.ts` is absent. |
| `test/vault/integration/concurrency.test.ts` | ~80 | Two `runEnrichment` calls race on same scope → second is rejected, first completes cleanly. |
| `test/vault/lock.test.ts` | ~60 | Unit tests for the lock module (acquire / release / stale lock auto-recovery). |
| `test/fixtures/vault-memories.json` | — | 10 seed memories. 5 with `source_memory_id` already populated in a paired `knowledge` row (existing-link case). 5 truly orphan (no row in `knowledge` referencing their id). |

### Files this plan modifies

| Path | Change |
|---|---|
| `src/memory/decay.ts` | Extend `CleanupOptions` with `runEnrichment?: boolean` + `enrichmentScope?: string`. Extend `runCleanupPass` to call `runEnrichment(db, {scope})` after decay + eviction, gated by both the new option and `LOTL_VAULT_ENRICH_ON_DREAM` env var (default `on`). Add `enrichment` field to `CleanupResult`. |
| `src/cli/vault-commands.ts` | Add `vaultEnrich(opts: { scope?: string })` exported handler. Assumes Subsystem 1 has shipped this file with `vaultExport`. If absent, this plan creates the file with only the `vaultEnrich` handler. |
| `src/cli/lotl.ts` | Register `vault enrich [--scope X]` subcommand pointing at `vaultEnrich`. Only modify if Subsystem 1 hasn't already registered the `vault` command group. |
| `vitest.config.ts` | If Subsystem 1 has not introduced the `src/vault/**` 100%-coverage gate, this plan adds it (mirroring spec). Otherwise no-op. |
| `package.json` | Bump `version` to `1.2.0-alpha.2`. No new deps. |
| `CHANGELOG.md` | Add `Unreleased` entry. |

### Config env vars introduced

| Var | Default | Read in |
|---|---|---|
| `LOTL_VAULT_ENRICH_ON_DREAM` | `on` | `src/memory/decay.ts` (gate inside `runCleanupPass`) |
| `LOTL_VAULT_EXTRACT_MAX_TOKENS` | `4000` | `src/vault/extract.ts` (per-memory truncation, char-budget = 4 × tokens) |
| `LOTL_VAULT_LOCK_DIR` | `~/.cache/lotl/locks` | `src/vault/lock.ts` (override for tests) |
| `LOTL_VAULT_LOCK_STALE_MS` | `600000` (10 min) | `src/vault/lock.ts` (auto-recover crashed lock holders) |

OpenClaw plugin (`src/openclaw/plugin.ts`) already maps `plugins.entries.tanarchy-lotl.config.vault.*` → `LOTL_VAULT_*` env vars on register — no code change needed; just document in spec section.

---

## Critical investigation — gap between spec and reality

This is **Task 1**. Non-negotiable.

Call-site map of `extractAndStore` vs `memoryStore`:

| Hot path | Function used | Triples? |
|---|---|---|
| `memory_add` MCP (`src/mcp/server.ts:564`) | `memoryStore` | **NO** |
| `memory_add_batch` MCP | `memoryStoreBatch` | NO |
| `memory_extract` MCP (`src/mcp/server.ts:805`) | `extractAndStore` | opportunistic only |
| OpenClaw auto-capture | mix | partial |
| `lotl memory store` CLI | `memoryStore` | NO |
| `lotl memory extract` CLI | `extractAndStore` | opportunistic only |

`extractAndStore` only writes triples when the LLM emits a `subject|predicate|object` suffix; heuristic fallback never emits triples. Raw-storage paths (`memory_add`, `memory store`) bypass extraction entirely. So Subsystem 2 fills two real gaps:
1. **Retroactive** — historical backlog from raw paths.
2. **Continuous** — coverage for raw paths going forward, via dream hook.

It does NOT replace inline extraction in `extractAndStore`.

`consolidateEntityFacts` (`src/memory/knowledge.ts:170-239`) synthesizes profile/timeline memories *from* existing triples — reads `knowledge`, never writes to it. Cannot fill orphans. Runs downstream of this subsystem.

---

## Task list

### Task 0: Branch + version bump

**Files:**
- Modify: `package.json` (version field only)

- [ ] **Step 1:** Create branch from `dev`:
  ```bash
  git checkout dev
  git pull
  git checkout -b feature/vault-extract-subsystem-2
  ```

- [ ] **Step 2:** Bump version in `package.json`:
  ```json
  "version": "1.2.0-alpha.2"
  ```

- [ ] **Step 3:** Add `Unreleased` skeleton entry to `CHANGELOG.md`:
  ```markdown
  ## [Unreleased]

  ### Added
  - `src/vault/extract.ts` — orphan-memory entity extraction (Subsystem 2 of vault export).
  - `lotl vault enrich [--scope X]` CLI escape hatch for manual triple extraction.
  - `LOTL_VAULT_ENRICH_ON_DREAM` env gate (default `on`).
  - `LOTL_VAULT_EXTRACT_MAX_TOKENS` per-memory truncation (default `4000`).
  - File-based advisory lock at `~/.cache/lotl/locks/<scope>.lock`.

  ### Changed
  - `runCleanupPass` now invokes entity extraction after decay/eviction when enabled.
  ```

- [ ] **Step 4:** Commit:
  ```bash
  git add package.json CHANGELOG.md
  git commit -m "chore: bump to 1.2.0-alpha.2 + changelog skeleton for vault subsystem 2"
  ```

---

### Task 1: Investigation — measure actual orphan rate (DO NOT SKIP)

**Patience phase.** Diagnostic script against the live DB; numbers drive scope.

**Files:**
- Create: `scripts/diagnostic-orphan-rate.mjs` (committed, not built).

- [ ] **Step 1: Write the diagnostic script.**

```js
// scripts/diagnostic-orphan-rate.mjs
// Reports orphan-memory rate by scope. Run with: node scripts/diagnostic-orphan-rate.mjs
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dbPath = process.env.LOTL_DB_PATH || join(homedir(), '.cache', 'lotl', 'index.sqlite');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const totalMems = db.prepare(`SELECT COUNT(*) AS n FROM memories`).get().n;
const totalKnowledge = db.prepare(`SELECT COUNT(*) AS n FROM knowledge`).get().n;
const linkedMems = db.prepare(
  `SELECT COUNT(DISTINCT source_memory_id) AS n FROM knowledge WHERE source_memory_id IS NOT NULL`
).get().n;
const orphanMems = db.prepare(
  `SELECT COUNT(*) AS n FROM memories WHERE id NOT IN
     (SELECT DISTINCT source_memory_id FROM knowledge WHERE source_memory_id IS NOT NULL)`
).get().n;

console.log(`Total memories: ${totalMems}`);
console.log(`Total knowledge rows: ${totalKnowledge}`);
console.log(`Memories with at least one KG link: ${linkedMems}`);
console.log(`Orphan memories: ${orphanMems} (${(100 * orphanMems / Math.max(1, totalMems)).toFixed(1)}%)`);

console.log('\nBy scope:');
const rows = db.prepare(`
  SELECT
    m.scope AS scope,
    COUNT(*) AS total,
    SUM(CASE WHEN m.id NOT IN (SELECT source_memory_id FROM knowledge WHERE source_memory_id IS NOT NULL) THEN 1 ELSE 0 END) AS orphan
  FROM memories m
  GROUP BY m.scope
  ORDER BY total DESC
`).all();
for (const r of rows) {
  const pct = (100 * r.orphan / Math.max(1, r.total)).toFixed(1);
  console.log(`  ${r.scope.padEnd(24)} ${String(r.orphan).padStart(6)} / ${String(r.total).padStart(6)} orphan (${pct}%)`);
}

console.log('\nCategory breakdown of orphans:');
const cats = db.prepare(`
  SELECT category, COUNT(*) AS n FROM memories
  WHERE id NOT IN (SELECT source_memory_id FROM knowledge WHERE source_memory_id IS NOT NULL)
  GROUP BY category ORDER BY n DESC
`).all();
for (const c of cats) console.log(`  ${c.category.padEnd(12)} ${c.n}`);
```

- [ ] **Step 2: Run it.**

```bash
node scripts/diagnostic-orphan-rate.mjs
```

- [ ] **Step 3: Paste the output as a comment inline in the script** (as `// RUN 2026-05-21:` block at top). Commit the script with results.

- [ ] **Step 4: Decision gate.**
  - **>50% orphan:** proceed as planned.
  - **5-50%:** proceed; same code.
  - **<5%:** STOP. Reduce subsystem to "route `memory_add` MCP / `memory store` CLI through `extractAndStore`". Open divergence ticket, pause.

- [ ] **Step 5: Commit.**

```bash
git add scripts/diagnostic-orphan-rate.mjs
git commit -m "chore: add diagnostic script for orphan-memory rate (subsystem 2 baseline)"
```

---

### Task 2: Advisory lock module

**Files:**
- Create: `src/vault/lock.ts`
- Create: `test/vault/lock.test.ts`

#### Test first

- [ ] **Step 1: Write the failing test.**

```ts
// test/vault/lock.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock, withLock, LockBusyError } from '../../src/vault/lock.js';

let lockDir: string;

beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), 'vault-lock-'));
  process.env.LOTL_VAULT_LOCK_DIR = lockDir;
});

afterEach(() => {
  delete process.env.LOTL_VAULT_LOCK_DIR;
  rmSync(lockDir, { recursive: true, force: true });
});

describe('vault lock', () => {
  it('acquires + releases a fresh lock', () => {
    const token = acquireLock('global');
    expect(token).toBeDefined();
    expect(existsSync(join(lockDir, 'global.lock'))).toBe(true);
    releaseLock('global', token);
    expect(existsSync(join(lockDir, 'global.lock'))).toBe(false);
  });

  it('throws LockBusyError on contention', () => {
    acquireLock('global');
    expect(() => acquireLock('global')).toThrow(LockBusyError);
  });

  it('auto-recovers a stale lock past LOTL_VAULT_LOCK_STALE_MS', () => {
    process.env.LOTL_VAULT_LOCK_STALE_MS = '50';
    acquireLock('global');
    // Wait > 50ms then re-acquire
    const start = Date.now();
    while (Date.now() - start < 80) { /* spin */ }
    const token = acquireLock('global');
    expect(token).toBeDefined();
    delete process.env.LOTL_VAULT_LOCK_STALE_MS;
  });

  it('withLock releases on exception', async () => {
    await expect(withLock('global', async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    expect(existsSync(join(lockDir, 'global.lock'))).toBe(false);
  });

  it('withLock returns inner result', async () => {
    const r = await withLock('global', async () => 42);
    expect(r).toBe(42);
  });

  it('sanitises scope name for filesystem (slashes, dots)', () => {
    const token = acquireLock('project/foo.bar');
    expect(token).toBeDefined();
    expect(existsSync(join(lockDir, 'project-foo-bar.lock'))).toBe(true);
    releaseLock('project/foo.bar', token);
  });
});
```

- [ ] **Step 2: Run — expect failure.**

```bash
npx vitest run --reporter=verbose test/vault/lock.test.ts
```
Expected: FAIL with "Cannot find module '../../src/vault/lock.js'".

- [ ] **Step 3: Implement.**

```ts
// src/vault/lock.ts
// File-based advisory lock for vault enrichment / export concurrency.
// Atomic via mkdirSync (POSIX + Win32 both treat mkdir as atomic on success).
// Stale-recovery via mtime check + LOTL_VAULT_LOCK_STALE_MS env var.

import { mkdirSync, rmdirSync, statSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class LockBusyError extends Error {
  constructor(scope: string, holderPid?: number) {
    super(`[vault:lock] busy on scope=${scope}${holderPid ? ` (held by pid ${holderPid})` : ''}`);
    this.name = 'LockBusyError';
  }
}

function lockDir(): string {
  return process.env.LOTL_VAULT_LOCK_DIR || join(homedir(), '.cache', 'lotl', 'locks');
}

function sanitiseScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function lockPath(scope: string): string {
  return join(lockDir(), `${sanitiseScope(scope)}.lock`);
}

function staleMs(): number {
  const raw = process.env.LOTL_VAULT_LOCK_STALE_MS;
  const n = raw ? parseInt(raw, 10) : 600_000;
  return Number.isFinite(n) && n > 0 ? n : 600_000;
}

export function acquireLock(scope: string): string {
  const dir = lockDir();
  mkdirSync(dir, { recursive: true });
  const path = lockPath(scope);

  if (existsSync(path)) {
    try {
      const st = statSync(path);
      if (Date.now() - st.mtimeMs > staleMs()) {
        unlinkSync(path);
      } else {
        let holderPid: number | undefined;
        try { holderPid = parseInt(readFileSync(path, 'utf8'), 10); } catch { /* ignore */ }
        throw new LockBusyError(scope, holderPid);
      }
    } catch (err) {
      if (err instanceof LockBusyError) throw err;
      // statSync race — file vanished between exists and stat. Treat as free.
    }
  }

  const token = randomUUID();
  try {
    writeFileSync(path, `${process.pid}\n${token}\n`, { flag: 'wx' });
  } catch {
    throw new LockBusyError(scope);
  }
  return token;
}

export function releaseLock(scope: string, token: string): void {
  const path = lockPath(scope);
  if (!existsSync(path)) return;
  try {
    const contents = readFileSync(path, 'utf8');
    const onDisk = contents.split('\n')[1]?.trim();
    if (onDisk && onDisk !== token) {
      console.warn(`[vault:lock] WARN: refusing to release lock owned by other token (scope=${scope})`);
      return;
    }
    unlinkSync(path);
  } catch {
    // best effort
  }
}

export async function withLock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  const token = acquireLock(scope);
  try {
    return await fn();
  } finally {
    releaseLock(scope, token);
  }
}
```

- [ ] **Step 4: Run — expect pass.**

```bash
npx vitest run --reporter=verbose test/vault/lock.test.ts
```
Expected: PASS (6/6).

- [ ] **Step 5: Commit.**

```bash
git add src/vault/lock.ts test/vault/lock.test.ts
git commit -m "feat(vault): add file-based advisory lock module"
```

---

### Task 3: Fixture — `test/fixtures/vault-memories.json`

**Files:**
- Create: `test/fixtures/vault-memories.json`

- [ ] **Step 1: Author the fixture.**

```json
{
  "memories": [
    { "id": "mem-linked-001", "text": "David works on Lotl as the primary maintainer.", "category": "entity", "scope": "global", "importance": 0.7 },
    { "id": "mem-linked-002", "text": "Sarah lives in Berlin and prefers vegetarian food.", "category": "entity", "scope": "global", "importance": 0.6 },
    { "id": "mem-linked-003", "text": "We decided to use PostgreSQL for the new project.", "category": "decision", "scope": "project-alpha", "importance": 0.8 },
    { "id": "mem-linked-004", "text": "ACME Corp acquired BetaSoft in March 2024.", "category": "fact", "scope": "global", "importance": 0.6 },
    { "id": "mem-linked-005", "text": "Marie is a software engineer at Google.", "category": "entity", "scope": "global", "importance": 0.7 },

    { "id": "mem-orphan-001", "text": "David enjoys hiking on the weekends with his dog Bilbo.", "category": "preference", "scope": "global", "importance": 0.5 },
    { "id": "mem-orphan-002", "text": "The user prefers TypeScript over JavaScript for new projects.", "category": "preference", "scope": "project-alpha", "importance": 0.6 },
    { "id": "mem-orphan-003", "text": "ChatGPT was launched by OpenAI in November 2022.", "category": "fact", "scope": "global", "importance": 0.5 },
    { "id": "mem-orphan-004", "text": "I usually go for coffee at 9am with the team.", "category": "preference", "scope": "global", "importance": 0.4 },
    { "id": "mem-orphan-005", "text": "the the the the the the the the the the.", "category": "other", "scope": "global", "importance": 0.1 }
  ],
  "knowledge": [
    { "id": "k-001", "subject": "david", "predicate": "works_on", "object": "Lotl", "source_memory_id": "mem-linked-001", "scope": "global" },
    { "id": "k-002", "subject": "sarah", "predicate": "lives_in", "object": "Berlin", "source_memory_id": "mem-linked-002", "scope": "global" },
    { "id": "k-003", "subject": "sarah", "predicate": "prefers", "object": "vegetarian food", "source_memory_id": "mem-linked-002", "scope": "global" },
    { "id": "k-004", "subject": "team", "predicate": "decided_on", "object": "PostgreSQL", "source_memory_id": "mem-linked-003", "scope": "project-alpha" },
    { "id": "k-005", "subject": "acme_corp", "predicate": "acquired", "object": "BetaSoft", "source_memory_id": "mem-linked-004", "scope": "global" },
    { "id": "k-006", "subject": "marie", "predicate": "occupation", "object": "software engineer", "source_memory_id": "mem-linked-005", "scope": "global" }
  ]
}
```

Note: `mem-orphan-005` is intentionally garbage (regex-fallback should produce zero triples) — covers the "no signal" branch.

- [ ] **Step 2: Commit.**

```bash
git add test/fixtures/vault-memories.json
git commit -m "test(vault): add orphan-memory fixture (10 memories, 5 with KG links)"
```

---

### Task 4: `src/vault/extract.ts` — zod schema + orphan query (skeleton)

**Files:**
- Create: `src/vault/extract.ts`
- Create: `test/vault/extract.test.ts`

#### Test first — zod schema rejection

- [ ] **Step 1: Write the failing test for the zod schema.**

```ts
// test/vault/extract.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ExtractionResponseSchema, parseTriples, selectOrphans, runEnrichment } from '../../src/vault/extract.js';
import { initStore } from '../../src/store/db-init.js';

let dbPath: string;
let db: any;
let fixtureDir: string;

function seed(db: any, fixture: any) {
  const memStmt = db.prepare(`INSERT INTO memories (id, text, content_hash, category, scope, importance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const m of fixture.memories) {
    memStmt.run(m.id, m.text, `hash-${m.id}`, m.category, m.scope, m.importance, Date.now());
  }
  const kStmt = db.prepare(`INSERT INTO knowledge (id, subject, predicate, object, confidence, source_memory_id, scope, created_at) VALUES (?, ?, ?, ?, 1.0, ?, ?, ?)`);
  for (const k of fixture.knowledge) {
    kStmt.run(k.id, k.subject, k.predicate, k.object, k.source_memory_id, k.scope, Date.now());
  }
}

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'vault-extract-'));
  dbPath = join(fixtureDir, 'test.sqlite');
  db = new Database(dbPath);
  initStore(db);
  const fixture = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'vault-memories.json'), 'utf8'));
  seed(db, fixture);
  process.env.LOTL_VAULT_LOCK_DIR = join(fixtureDir, 'locks');
});

afterEach(() => {
  db.close();
  rmSync(fixtureDir, { recursive: true, force: true });
  delete process.env.LOTL_VAULT_LOCK_DIR;
  vi.restoreAllMocks();
});

describe('ExtractionResponseSchema', () => {
  it('accepts valid triples payload', () => {
    const ok = ExtractionResponseSchema.parse({ triples: [{ subject: 'David', predicate: 'works_on', object: 'Lotl' }] });
    expect(ok.triples).toHaveLength(1);
  });

  it('rejects empty subject', () => {
    expect(() => ExtractionResponseSchema.parse({ triples: [{ subject: '', predicate: 'works_on', object: 'Lotl' }] })).toThrow();
  });

  it('rejects upper-case predicate', () => {
    expect(() => ExtractionResponseSchema.parse({ triples: [{ subject: 'David', predicate: 'WorksOn', object: 'Lotl' }] })).toThrow();
  });

  it('rejects more than 5 triples', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ subject: 'X', predicate: 'p_' + i, object: 'Y' }));
    expect(() => ExtractionResponseSchema.parse({ triples: six })).toThrow();
  });
});

describe('parseTriples', () => {
  it('returns [] on non-JSON', () => {
    expect(parseTriples('not json at all')).toEqual([]);
  });

  it('extracts JSON wrapped in code fences', () => {
    const r = parseTriples('```json\n{"triples":[{"subject":"A","predicate":"is_a","object":"B"}]}\n```');
    expect(r).toHaveLength(1);
  });

  it('returns [] on malformed schema', () => {
    expect(parseTriples('{"triples":[{"subject":"","predicate":"is_a","object":"B"}]}')).toEqual([]);
  });
});

describe('selectOrphans', () => {
  it('returns memories with no KG link (global scope)', () => {
    const orphans = selectOrphans(db, 'global');
    const ids = orphans.map(o => o.id).sort();
    expect(ids).toEqual(['mem-orphan-001', 'mem-orphan-003', 'mem-orphan-004', 'mem-orphan-005']);
  });

  it('returns orphans for a specific scope only', () => {
    const orphans = selectOrphans(db, 'project-alpha');
    expect(orphans.map(o => o.id)).toEqual(['mem-orphan-002']);
  });

  it('returns all orphans when scope=undefined', () => {
    const orphans = selectOrphans(db);
    expect(orphans.length).toBe(5);
  });
});
```

- [ ] **Step 2: Run — expect failure.**

```bash
npx vitest run --reporter=verbose test/vault/extract.test.ts
```
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement minimum.**

```ts
// src/vault/extract.ts
// Subsystem 2: retroactive entity extraction over orphan memories.
// Walks memories that have no row in knowledge.source_memory_id, calls chatComplete
// with a strict zod-validated triple prompt, writes triples through knowledgeStore.
// Falls back to patterns.ts heuristic when LLM unavailable / malformed.

import { z } from 'zod';
import type { Database } from '../db.js';
import { knowledgeStore } from '../memory/knowledge.js';
import { classifyMemory, hasMemorySignal } from '../memory/patterns.js';
import { withLock, LockBusyError } from './lock.js';

export const TripleSchema = z.object({
  subject: z.string().min(1).max(200),
  predicate: z.string().regex(/^[a-z_][a-z0-9_]*$/).max(50),
  object: z.string().min(1).max(200),
});

export const ExtractionResponseSchema = z.object({
  triples: z.array(TripleSchema).max(5),
});

export type Triple = z.infer<typeof TripleSchema>;

export type OrphanMemory = {
  id: string;
  text: string;
  category: string;
  scope: string;
  importance: number;
};

export function selectOrphans(db: Database, scope?: string): OrphanMemory[] {
  const base = `
    SELECT id, text, category, scope, importance FROM memories
    WHERE id NOT IN (SELECT source_memory_id FROM knowledge WHERE source_memory_id IS NOT NULL)
  `;
  if (scope) {
    return db.prepare(`${base} AND scope = ? ORDER BY created_at ASC`).all(scope) as OrphanMemory[];
  }
  return db.prepare(`${base} ORDER BY created_at ASC`).all() as OrphanMemory[];
}

const EXTRACTION_SYSTEM_PROMPT = `You extract subject-predicate-object triples from a single memory text.
Return ONLY valid JSON matching this exact shape — no prose, no code fences:
{"triples": [{"subject": str, "predicate": str, "object": str}]}

Rules:
- Lowercase predicates in snake_case (e.g. "works_on", "is_a", "owns", "lives_in", "prefers").
- Preserve original casing for subject/object (proper nouns stay capitalized).
- Return {"triples": []} if no clear S-P-O is present.
- Maximum 5 triples per memory. Skip vague generalities.
- One memory text per call. Do not combine across memories.`;

export function parseTriples(raw: string): Triple[] {
  if (!raw) return [];
  // Strip code fences if present
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Salvage: find first { ... } block
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return [];
  const candidate = stripped.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    const validated = ExtractionResponseSchema.safeParse(parsed);
    if (!validated.success) return [];
    return validated.data.triples;
  } catch {
    return [];
  }
}

function truncate(text: string): { text: string; truncated: boolean } {
  const maxTokens = parseInt(process.env.LOTL_VAULT_EXTRACT_MAX_TOKENS || '4000', 10);
  const budget = Math.max(100, maxTokens) * 4;
  if (text.length <= budget) return { text, truncated: false };
  return { text: text.slice(0, budget), truncated: true };
}

async function callExtractor(memText: string): Promise<{ triples: Triple[]; ok: boolean }> {
  try {
    const { getRemoteLLM } = await import('../remote-config.js');
    const remote = getRemoteLLM();
    if (!remote) return { triples: [], ok: false };
    const prompt = `${EXTRACTION_SYSTEM_PROMPT}\n\nMEMORY:\n${memText}`;
    const response = await remote.chatComplete(prompt);
    const triples = parseTriples(response ?? '');
    return { triples, ok: true };
  } catch {
    return { triples: [], ok: false };
  }
}

// Regex fallback: emit one triple iff entity signal present.
// Subject = first proper-noun token; predicate from category; object = remainder.
// Coarse on purpose — better than zero coverage on LLM failure.
function regexFallback(memText: string): Triple[] {
  if (!hasMemorySignal(memText)) return [];
  const category = classifyMemory(memText);
  if (category === 'other') return [];

  const properMatch = memText.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
  if (!properMatch) return [];
  const subject = properMatch[1];

  const predicateMap: Record<string, string> = {
    preference: 'prefers',
    decision: 'decided',
    fact: 'is_associated_with',
    entity: 'is_a',
    reflection: 'reflected_on',
  };
  const predicate = predicateMap[category] || 'mentioned';

  const remainder = memText.replace(properMatch[0], '').replace(/[.!?]+$/, '').trim().slice(0, 180);
  if (remainder.length < 3) return [];
  return [{ subject, predicate, object: remainder }];
}

export type EnrichmentResult = {
  scope: string;
  considered: number;
  llmHits: number;
  regexHits: number;
  triplesWritten: number;
  truncated: number;
  malformed: number;
  skipped: number;
};

export type EnrichmentOptions = {
  scope?: string;
  limit?: number;
  /** Skip the advisory lock — internal use only (e.g. when caller already holds it). */
  skipLock?: boolean;
};

async function runEnrichmentImpl(db: Database, opts: EnrichmentOptions): Promise<EnrichmentResult> {
  const scope = opts.scope ?? 'global';
  const result: EnrichmentResult = {
    scope, considered: 0, llmHits: 0, regexHits: 0, triplesWritten: 0,
    truncated: 0, malformed: 0, skipped: 0,
  };

  const orphans = selectOrphans(db, opts.scope);
  const subset = opts.limit ? orphans.slice(0, opts.limit) : orphans;
  result.considered = subset.length;

  for (const mem of subset) {
    const { text: clipped, truncated } = truncate(mem.text);
    if (truncated) {
      result.truncated++;
      console.info(`[vault:extract] INFO: truncated memory ${mem.id} to ${clipped.length} chars`);
    }

    let triples: Triple[] = [];
    const llm = await callExtractor(clipped);
    if (llm.ok && llm.triples.length > 0) {
      triples = llm.triples;
      result.llmHits++;
    } else if (llm.ok && llm.triples.length === 0) {
      console.warn(`[vault:extract] WARN: malformed JSON from LLM, fell back to regex (memory_id=${mem.id})`);
      result.malformed++;
      triples = regexFallback(clipped);
      if (triples.length > 0) result.regexHits++;
    } else {
      triples = regexFallback(clipped);
      if (triples.length > 0) result.regexHits++;
    }

    if (triples.length === 0) {
      result.skipped++;
      continue;
    }

    for (const t of triples) {
      try {
        knowledgeStore(db, {
          subject: t.subject,
          predicate: t.predicate,
          object: t.object,
          scope: mem.scope,
          source_memory_id: mem.id,
        });
        result.triplesWritten++;
      } catch (err) {
        console.warn(`[vault:extract] WARN: knowledgeStore rejected triple for ${mem.id}: ${(err as Error).message}`);
      }
    }
  }

  return result;
}

export async function runEnrichment(db: Database, opts: EnrichmentOptions = {}): Promise<EnrichmentResult> {
  const scope = opts.scope ?? 'global';
  if (opts.skipLock) {
    return runEnrichmentImpl(db, opts);
  }
  try {
    return await withLock(scope, () => runEnrichmentImpl(db, opts));
  } catch (err) {
    if (err instanceof LockBusyError) {
      console.warn(`[vault:extract] WARN: ${err.message}, refusing to run`);
      throw err;
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run — expect zod + parseTriples + selectOrphans tests to pass.**

```bash
npx vitest run --reporter=verbose test/vault/extract.test.ts -t "ExtractionResponseSchema|parseTriples|selectOrphans"
```
Expected: PASS (10/10 subtests).

- [ ] **Step 5: Commit.**

```bash
git add src/vault/extract.ts test/vault/extract.test.ts test/fixtures/vault-memories.json
git commit -m "feat(vault): add extract.ts skeleton — zod schema, orphan selector, parseTriples"
```

---

### Task 5: `runEnrichment` LLM happy path + fallback

**Files:**
- Modify: `test/vault/extract.test.ts` — append new describe block.

#### Test first

- [ ] **Step 1: Append the happy-path + fallback test blocks.**

```ts
// Append to test/vault/extract.test.ts
import * as remoteConfig from '../../src/remote-config.js';

function mockLLM(impl: (p: string) => Promise<string> | string) {
  vi.spyOn(remoteConfig, 'getRemoteLLM').mockReturnValue({ chatComplete: vi.fn(impl) } as any);
}

describe('runEnrichment', () => {
  it('writes LLM-returned triples', async () => {
    mockLLM(async () => JSON.stringify({ triples: [{ subject: 'David', predicate: 'enjoys', object: 'hiking' }] }));
    const r = await runEnrichment(db, { scope: 'global' });
    expect(r.considered).toBe(4);
    expect(r.llmHits).toBeGreaterThan(0);
    expect(r.triplesWritten).toBeGreaterThan(0);
    expect(db.prepare(`SELECT 1 FROM knowledge WHERE source_memory_id = 'mem-orphan-001'`).all().length).toBeGreaterThan(0);
  });

  it('counts malformed and falls back to regex', async () => {
    mockLLM(async () => 'not even close to JSON');
    const r = await runEnrichment(db, { scope: 'global' });
    expect(r.malformed).toBeGreaterThan(0);
    expect(r.regexHits).toBeGreaterThan(0);
  });

  it('uses regex fallback when LLM not configured', async () => {
    vi.spyOn(remoteConfig, 'getRemoteLLM').mockReturnValue(null);
    const r = await runEnrichment(db, { scope: 'global' });
    expect(r.llmHits).toBe(0);
    expect(r.regexHits).toBeGreaterThan(0);
  });

  it('skips memories with no signal (garbage mem-orphan-005)', async () => {
    vi.spyOn(remoteConfig, 'getRemoteLLM').mockReturnValue(null);
    const r = await runEnrichment(db, { scope: 'global' });
    expect(db.prepare(`SELECT 1 FROM knowledge WHERE source_memory_id = 'mem-orphan-005'`).all()).toHaveLength(0);
    expect(r.skipped).toBeGreaterThan(0);
  });

  it('handles chatComplete throwing as LLM-unavailable', async () => {
    mockLLM(async () => { throw new Error('network'); });
    const r = await runEnrichment(db, { scope: 'global' });
    expect(r.llmHits).toBe(0);
  });

  it('respects limit option', async () => {
    vi.spyOn(remoteConfig, 'getRemoteLLM').mockReturnValue(null);
    const r = await runEnrichment(db, { scope: 'global', limit: 2 });
    expect(r.considered).toBe(2);
  });

  it('truncates long memory text', async () => {
    process.env.LOTL_VAULT_EXTRACT_MAX_TOKENS = '10';
    db.prepare(`INSERT INTO memories (id, text, content_hash, category, scope, importance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('mem-long', 'x'.repeat(500), 'hash-long', 'other', 'global', 0.5, Date.now());
    const llm = vi.fn(async () => '{"triples":[]}');
    vi.spyOn(remoteConfig, 'getRemoteLLM').mockReturnValue({ chatComplete: llm } as any);
    const r = await runEnrichment(db, { scope: 'global' });
    expect(r.truncated).toBeGreaterThanOrEqual(1);
    const longCall = (llm as any).mock.calls.find((c: any[]) => c[0].includes('xxxx'));
    expect(longCall[0].length).toBeLessThan(500);
    delete process.env.LOTL_VAULT_EXTRACT_MAX_TOKENS;
  });

  it('logs warn when knowledgeStore throws', async () => {
    mockLLM(async () => JSON.stringify({ triples: [{ subject: 'X', predicate: 'p', object: 'Y' }] }));
    db.exec(`DROP TABLE knowledge`);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runEnrichment(db, { scope: 'global' });
    expect(r.triplesWritten).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — they should already pass given Task 4's implementation.**

```bash
npx vitest run --reporter=verbose test/vault/extract.test.ts
```
Expected: all subtests PASS. If any fail, the implementation in `src/vault/extract.ts` has a bug — fix it before continuing.

- [ ] **Step 3: Commit.**

```bash
git add test/vault/extract.test.ts
git commit -m "test(vault): cover LLM happy-path, malformed, fallback, truncation, limit"
```

---

### Task 6: Concurrency integration test

**Files:**
- Create: `test/vault/integration/concurrency.test.ts`

- [ ] **Step 1: Write the test.**

```ts
// test/vault/integration/concurrency.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runEnrichment } from '../../../src/vault/extract.js';
import { LockBusyError } from '../../../src/vault/lock.js';
import { initStore } from '../../../src/store/db-init.js';
import * as remoteConfig from '../../../src/remote-config.js';

let db: any;
let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'vault-concur-'));
  db = new Database(join(fixtureDir, 'test.sqlite'));
  initStore(db);
  process.env.LOTL_VAULT_LOCK_DIR = join(fixtureDir, 'locks');
  const fixture = JSON.parse(readFileSync(join(__dirname, '..', '..', 'fixtures', 'vault-memories.json'), 'utf8'));
  const memStmt = db.prepare(`INSERT INTO memories (id, text, content_hash, category, scope, importance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const m of fixture.memories) {
    memStmt.run(m.id, m.text, `hash-${m.id}`, m.category, m.scope, m.importance, Date.now());
  }
});

afterEach(() => {
  db.close();
  rmSync(fixtureDir, { recursive: true, force: true });
  delete process.env.LOTL_VAULT_LOCK_DIR;
  vi.restoreAllMocks();
});

describe('runEnrichment concurrency', () => {
  it('rejects second concurrent run with LockBusyError', async () => {
    // Slow LLM so first run is in-flight when second starts
    const fakeLLM = {
      chatComplete: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 150));
        return '{"triples":[]}';
      }),
    };
    vi.spyOn(remoteConfig, 'getRemoteLLM').mockReturnValue(fakeLLM as any);

    const first = runEnrichment(db, { scope: 'global' });
    // Give first a moment to acquire the lock
    await new Promise(r => setTimeout(r, 20));

    await expect(runEnrichment(db, { scope: 'global' })).rejects.toThrow(LockBusyError);

    // First should still complete cleanly
    const r1 = await first;
    expect(r1.considered).toBeGreaterThan(0);
  });

  it('different scopes do not contend', async () => {
    const fakeLLM = { chatComplete: vi.fn(async () => '{"triples":[]}') };
    vi.spyOn(remoteConfig, 'getRemoteLLM').mockReturnValue(fakeLLM as any);

    const [a, b] = await Promise.all([
      runEnrichment(db, { scope: 'global' }),
      runEnrichment(db, { scope: 'project-alpha' }),
    ]);
    expect(a.scope).toBe('global');
    expect(b.scope).toBe('project-alpha');
  });

  it('skipLock bypasses lock acquisition', async () => {
    const fakeLLM = { chatComplete: vi.fn(async () => '{"triples":[]}') };
    vi.spyOn(remoteConfig, 'getRemoteLLM').mockReturnValue(fakeLLM as any);

    const [a, b] = await Promise.all([
      runEnrichment(db, { scope: 'global', skipLock: true }),
      runEnrichment(db, { scope: 'global', skipLock: true }),
    ]);
    expect(a.scope).toBe('global');
    expect(b.scope).toBe('global');
  });
});
```

- [ ] **Step 2: Run.**

```bash
npx vitest run --reporter=verbose test/vault/integration/concurrency.test.ts
```
Expected: PASS (3/3).

- [ ] **Step 3: Commit.**

```bash
git add test/vault/integration/concurrency.test.ts
git commit -m "test(vault): integration test for advisory lock race rejection"
```

---

### Task 7: Prompt iteration — manual eval against fixtures (PATIENCE PHASE)

Slow design loop. Run extractor against fixtures with real LLM, tune prompt until threshold holds.

**Files:**
- Create: `scripts/eval-extract-prompt.mjs` (committed, not built)

- [ ] **Step 1: Write the eval script.**

```js
// scripts/eval-extract-prompt.mjs
// Eval the extraction prompt against test fixtures.
// Usage: node --experimental-vm-modules scripts/eval-extract-prompt.mjs
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const distExtract = await import('../dist/vault/extract.js'); // run after `npm run build`
const distInit = await import('../dist/store/db-init.js');

const dir = mkdtempSync(join(tmpdir(), 'eval-extract-'));
const db = new Database(join(dir, 'eval.sqlite'));
distInit.initStore(db);

const fx = JSON.parse(readFileSync('test/fixtures/vault-memories.json', 'utf8'));
const stmt = db.prepare(`INSERT INTO memories (id, text, content_hash, category, scope, importance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
for (const m of fx.memories) stmt.run(m.id, m.text, `h-${m.id}`, m.category, m.scope, m.importance, Date.now());

process.env.LOTL_VAULT_LOCK_DIR = join(dir, 'locks');
const r = await distExtract.runEnrichment(db, { scope: 'global' });
console.log(JSON.stringify(r, null, 2));

const rows = db.prepare(`SELECT source_memory_id, subject, predicate, object FROM knowledge WHERE id NOT LIKE 'k-%'`).all();
console.log('\nNew triples:');
for (const t of rows) console.log(`  [${t.source_memory_id}] ${t.subject} -[${t.predicate}]-> ${t.object}`);

rmSync(dir, { recursive: true, force: true });
```

- [ ] **Step 2: Build + run with a real provider configured.**

```bash
npm run build
node scripts/eval-extract-prompt.mjs
```

- [ ] **Step 3: Inspect.** Pass criteria:
  - `llmHits / considered ≥ 0.5` for non-garbage orphans (excl. `mem-orphan-005`).
  - `malformed / considered ≤ 0.2`.
  - `mem-orphan-001` → `David` subject + sane predicate.
  - `mem-orphan-003` → `ChatGPT` / `OpenAI` / `november_2022`.

- [ ] **Step 4:** If fail, edit `EXTRACTION_SYSTEM_PROMPT` in `src/vault/extract.ts`, add inline examples, re-run. Max 3 iterations.

- [ ] **Step 5: Record pass rates in `devnotes/architecture/2026-05-21-vault-extract-prompt-eval.md`** (gitignored). Commit script:

```bash
git add scripts/eval-extract-prompt.mjs
git commit -m "chore(vault): add prompt eval script + record fixture pass rates"
```

If you adjusted the prompt:

```bash
git add src/vault/extract.ts
git commit -m "feat(vault): tune extraction prompt to clear ≥50% fixture pass rate"
```

---

### Task 8: Hook into `runCleanupPass`

**Files:**
- Modify: `src/memory/decay.ts`
- Create/modify: `test/vault/integration/dream-to-vault.test.ts`

#### Test first

- [ ] **Step 1: Write the failing integration test.**

```ts
// test/vault/integration/dream-to-vault.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runCleanupPass } from '../../../src/memory/decay.js';
import { initStore } from '../../../src/store/db-init.js';
import * as remoteConfig from '../../../src/remote-config.js';

let db: any;
let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'dream-'));
  db = new Database(join(fixtureDir, 'test.sqlite'));
  initStore(db);
  process.env.LOTL_VAULT_LOCK_DIR = join(fixtureDir, 'locks');
  const fixture = JSON.parse(readFileSync(join(__dirname, '..', '..', 'fixtures', 'vault-memories.json'), 'utf8'));
  const memStmt = db.prepare(`INSERT INTO memories (id, text, content_hash, category, scope, importance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const m of fixture.memories) memStmt.run(m.id, m.text, `hash-${m.id}`, m.category, m.scope, m.importance, Date.now());
});

afterEach(() => {
  db.close();
  rmSync(fixtureDir, { recursive: true, force: true });
  delete process.env.LOTL_VAULT_LOCK_DIR;
  delete process.env.LOTL_VAULT_ENRICH_ON_DREAM;
  vi.restoreAllMocks();
});

describe('runCleanupPass with enrichment', () => {
  it('runs enrichment step when option is true and env=on', async () => {
    process.env.LOTL_VAULT_ENRICH_ON_DREAM = 'on';
    vi.spyOn(remoteConfig, 'getRemoteLLM').mockReturnValue(null);

    const r = await runCleanupPass(db, { runEnrichment: true, enrichmentScope: 'global' });
    expect(r.enrichment).toBeDefined();
    expect(r.enrichment!.considered).toBeGreaterThan(0);
  });

  it('skips enrichment when LOTL_VAULT_ENRICH_ON_DREAM=off', async () => {
    process.env.LOTL_VAULT_ENRICH_ON_DREAM = 'off';
    vi.spyOn(remoteConfig, 'getRemoteLLM').mockReturnValue(null);

    const r = await runCleanupPass(db, { runEnrichment: true, enrichmentScope: 'global' });
    expect(r.enrichment).toBeNull();
  });

  it('skips enrichment when runEnrichment option is false', async () => {
    vi.spyOn(remoteConfig, 'getRemoteLLM').mockReturnValue(null);
    const r = await runCleanupPass(db, { runEnrichment: false });
    expect(r.enrichment).toBeNull();
  });

  it('continues cleanup even if enrichment fails (lock busy)', async () => {
    process.env.LOTL_VAULT_ENRICH_ON_DREAM = 'on';
    vi.spyOn(remoteConfig, 'getRemoteLLM').mockReturnValue(null);

    // Pre-occupy the lock
    const { acquireLock } = await import('../../../src/vault/lock.js');
    acquireLock('global');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runCleanupPass(db, { runEnrichment: true, enrichmentScope: 'global' });
    // Cleanup result still populated; enrichment field reports the failure
    expect(r.decay).toBeDefined();
    expect(r.enrichment).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect failure (signature mismatch).**

```bash
npx vitest run --reporter=verbose test/vault/integration/dream-to-vault.test.ts
```
Expected: FAIL — `runCleanupPass` does not yet accept `runEnrichment` / `enrichmentScope` and does not return `enrichment` field.

- [ ] **Step 3: Modify `src/memory/decay.ts` — extend `CleanupOptions` + `CleanupResult` + `runCleanupPass`.**

Current types live at `src/memory/decay.ts:191-203`. Replace as follows:

```ts
// Add near the top of src/memory/decay.ts, after the existing CleanupOptions definition:
import type { EnrichmentResult } from '../vault/extract.js';

export type CleanupOptions = EvictionOptions & {
  minMemoriesForEviction?: number;
  skipDecay?: boolean;
  /** When true AND LOTL_VAULT_ENRICH_ON_DREAM !== 'off', run vault entity extraction. */
  runEnrichment?: boolean;
  /** Scope for enrichment pass. Defaults to 'global'. */
  enrichmentScope?: string;
};

export type CleanupResult = {
  decay: DecayResult | null;
  eviction: EvictionResult | null;
  enrichment: EnrichmentResult | null;
  totalMemoriesBefore: number;
  totalMemoriesAfter: number;
};
```

Replace the existing `runCleanupPass`:

```ts
// Decay always; eviction only past minMemoriesForEviction (avoid churn on small DBs).
// Enrichment is opt-in: requires options.runEnrichment AND LOTL_VAULT_ENRICH_ON_DREAM != 'off'.
// Made async to await enrichment. All existing callers must `await` going forward.
export async function runCleanupPass(
  db: Database,
  options: CleanupOptions = {}
): Promise<CleanupResult> {
  const before = (db.prepare(`SELECT COUNT(*) as n FROM memories`).get() as { n: number }).n;

  const decay = options.skipDecay ? null : runDecayPass(db);

  const minForEviction = options.minMemoriesForEviction ?? 1000;
  const eviction = before >= minForEviction
    ? runEvictionPass(db, options)
    : null;

  let enrichment: EnrichmentResult | null = null;
  const enrichFlag = process.env.LOTL_VAULT_ENRICH_ON_DREAM ?? 'on';
  if (options.runEnrichment && enrichFlag !== 'off') {
    try {
      const { runEnrichment } = await import('../vault/extract.js');
      enrichment = await runEnrichment(db, { scope: options.enrichmentScope ?? 'global' });
    } catch (err) {
      console.warn(`[vault:extract] WARN: enrichment failed during dream pass: ${(err as Error).message}`);
      enrichment = null;
    }
  }

  const after = (db.prepare(`SELECT COUNT(*) as n FROM memories`).get() as { n: number }).n;

  return {
    decay,
    eviction,
    enrichment,
    totalMemoriesBefore: before,
    totalMemoriesAfter: after,
  };
}
```

- [ ] **Step 4: Add `await` at every `runCleanupPass` call site.**

Known: `src/mcp/server.ts:953` — change `runCleanupPass(db, ...)` → `await runCleanupPass(db, ...)`. Confirm no others via `grep -rn "runCleanupPass" src/`.

- [ ] **Step 5: Add an MCP-facing option to enable enrichment in `memory_dream`.** In `src/mcp/server.ts`, extend the `inputSchema` for `memory_dream`:

```ts
inputSchema: {
  scope: z.string().optional().describe("Scope (default: global)"),
  windowDays: z.number().optional().describe("Reflection window (default: 7)"),
  minMemoriesForEviction: z.number().optional().describe("Threshold for LRU eviction (default: 1000)"),
  runEnrichment: z.boolean().optional().describe("Run vault entity extraction over orphan memories (default: false; OpenClaw enables this via LOTL_VAULT_ENRICH_ON_DREAM)"),
},
```

And pass it through:

```ts
async ({ scope, windowDays, minMemoriesForEviction, runEnrichment: enrich }) => {
  const db = store.internal.db;
  const cleanup = await runCleanupPass(db, {
    minMemoriesForEviction: minMemoriesForEviction ?? 1000,
    maxAgeDays: 30,
    minImportance: 0.4,
    minAccessCount: 2,
    lruWindowDays: 7,
    runEnrichment: enrich ?? false,
    enrichmentScope: scope ?? 'global',
  });
  // ... existing response building, also append enrichment summary if present
}
```

Then in the response builder, append:

```ts
if (cleanup.enrichment) {
  lines.push(
    `Enrichment: ${cleanup.enrichment.considered} orphan memories, ` +
    `${cleanup.enrichment.llmHits} LLM hits, ${cleanup.enrichment.regexHits} regex hits, ` +
    `${cleanup.enrichment.triplesWritten} triples written, ${cleanup.enrichment.skipped} skipped`
  );
}
```

- [ ] **Step 6: Run the integration test.**

```bash
npx vitest run --reporter=verbose test/vault/integration/dream-to-vault.test.ts
```
Expected: PASS (4/4).

- [ ] **Step 7: Regression check.**

```bash
npx vitest run --reporter=verbose test/decay.test.ts test/memory test/mcp 2>&1 | tail -60
```
Expected: green. Add `await` at any newly-broken sync call site in the same commit.

- [ ] **Step 8: Commit.**

```bash
git add src/memory/decay.ts src/mcp/server.ts test/vault/integration/dream-to-vault.test.ts
git commit -m "feat(vault): hook runEnrichment into runCleanupPass + memory_dream MCP"
```

---

### Task 9: CLI `lotl vault enrich`

**Files:**
- Modify or create: `src/cli/vault-commands.ts` (assumed shipped in Subsystem 1; if not, create minimal).
- Modify: `src/cli/lotl.ts` (only if `vault` cmd group not yet registered).
- Create: `test/vault/smoke/cli.test.ts`.

- [ ] **Step 1: Check existence.** `ls -la src/cli/vault-commands.ts`

- [ ] **Step 2: Append (or create) `vaultEnrich`.**

```ts
import type { Database } from '../db.js';
import { runEnrichment } from '../vault/extract.js';
import { LockBusyError } from '../vault/lock.js';
import { info, success, warn } from './terminal.js';

export type VaultEnrichOptions = {
  scope?: string;
  limit?: number;
};

export async function vaultEnrich(db: Database, opts: VaultEnrichOptions = {}): Promise<number> {
  const scope = opts.scope ?? 'global';
  console.log(info(`Enriching scope=${scope}…`));
  try {
    const r = await runEnrichment(db, { scope, limit: opts.limit });
    console.log(success(
      `Enrichment complete: ${r.considered} memories considered, ` +
      `${r.llmHits} LLM hits, ${r.regexHits} regex hits, ` +
      `${r.triplesWritten} triples written, ${r.skipped} skipped` +
      (r.truncated ? `, ${r.truncated} truncated` : '') +
      (r.malformed ? `, ${r.malformed} malformed LLM responses` : '')
    ));
    return 0;
  } catch (err) {
    if (err instanceof LockBusyError) {
      console.error(warn(`Cannot enrich: ${err.message}. Retry after the dream pass completes.`));
      return 2;
    }
    console.error(warn(`Enrichment failed: ${(err as Error).message}`));
    return 1;
  }
}
```

- [ ] **Step 3: Register subcommand in `src/cli/lotl.ts`.** Append to existing `vault` cmd block:

```ts
.command('enrich')
.description('Manually extract entity triples from orphan memories')
.option('--scope <scope>', 'Limit to a specific scope', 'global')
.option('--limit <n>', 'Limit number of memories to process', parseInt)
.action(async (opts) => {
  const { vaultEnrich } = await import('./vault-commands.js');
  const store = await openStore();
  const code = await vaultEnrich(store.internal.db, { scope: opts.scope, limit: opts.limit });
  process.exit(code);
});
```

If `vault` parent doesn't exist, create it: `const vaultCmd = program.command('vault').description('Vault'); vaultCmd.command('enrich')...` (rest identical).

- [ ] **Step 4: Write smoke test.**

```ts
// test/vault/smoke/cli.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'lotl-cli-'));
  process.env.LOTL_CACHE_DIR = cacheDir;
  process.env.LOTL_VAULT_LOCK_DIR = join(cacheDir, 'locks');
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env.LOTL_CACHE_DIR;
  delete process.env.LOTL_VAULT_LOCK_DIR;
});

describe('lotl vault enrich smoke', () => {
  it('runs against an empty DB and reports zero', () => {
    const out = execSync(
      `npx tsx src/cli/lotl.ts vault enrich --scope global`,
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
    ).toString();
    expect(out).toMatch(/Enrichment complete: 0 memories considered/);
  });

  it('exits 2 when lock is busy', () => {
    // Pre-create a fresh lock file
    const { acquireLock } = require('../../../src/vault/lock.js');
    acquireLock('global');
    let code = 0;
    try {
      execSync(`npx tsx src/cli/lotl.ts vault enrich --scope global`, { env: process.env });
    } catch (e: any) {
      code = e.status;
    }
    expect(code).toBe(2);
  });
});
```

- [ ] **Step 5: Run.**

```bash
npx vitest run --reporter=verbose test/vault/smoke/cli.test.ts
```
Expected: PASS (2/2).

- [ ] **Step 6: Commit.**

```bash
git add src/cli/vault-commands.ts src/cli/lotl.ts test/vault/smoke/cli.test.ts
git commit -m "feat(vault): add lotl vault enrich CLI"
```

---

### Task 10: Coverage gate

**Files:**
- Modify: `vitest.config.ts` (if Subsystem 1 didn't add it).

- [ ] **Step 1: Inspect current config.**

```bash
cat vitest.config.ts
```

- [ ] **Step 2: Ensure coverage block exists.** If missing:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/vault/**'],
      thresholds: {
        100: true,
      },
    },
  },
});
```

If Subsystem 1 added it, confirm `src/vault/**` is in `include`.

- [ ] **Step 3: Run coverage.**

```bash
npx vitest run --coverage 2>&1 | tail -40
```
Expected: 100% lines + branches on `src/vault/extract.ts` + `src/vault/lock.ts`. Iterate on uncovered branches.

Anticipated gaps: `regexFallback` no-proper-noun, `regexFallback` short-remainder, `releaseLock` file-gone, `acquireLock` stat-race, `parseTriples` empty-fence.

- [ ] **Step 4: Commit.**

```bash
git add vitest.config.ts test/vault/
git commit -m "test(vault): close coverage gaps to clear 100% on src/vault/**"
```

---

### Task 11: Self-review against spec

Read-only. No code unless gap found.

- [ ] **Step 1: Walk spec at `devnotes/architecture/2026-05-20-vault-export-design.md`, map every Subsystem-2 requirement to a task.**

| Spec requirement | Source line(s) | Implemented in |
|---|---|---|
| `runEnrichment(scope)` callable from dream pass | 130-137 | Task 8 |
| Orphan-memory SQL query | 132-135 | Task 4 (`selectOrphans`) |
| LLM call via `chatComplete` | 136, 85 | Task 4 (`callExtractor`) |
| Regex fallback via `patterns.ts` | 207 | Task 4 (`regexFallback`) |
| Zod parse of LLM response with skip-on-invalid | 208 | Task 4 (`parseTriples`) |
| Truncation at `LOTL_VAULT_EXTRACT_MAX_TOKENS` | 209, 292 | Task 4 (`truncate`) |
| Advisory lock per scope | 192-194 | Task 2 |
| `vault enrich` CLI escape hatch | 306 | Task 9 |
| Manual enrich refused while dream lock held | 210 | Task 9 (exit code 2) |
| `LOTL_VAULT_ENRICH_ON_DREAM=on/off` | 293 | Task 8 |
| Logging prefix `[vault:extract]` | 215-218 | Task 4 (every log call) |
| CLI uses `terminal.ts` helpers | 225 | Task 9 |
| Backend uses `console.info/warn/error` | 226 | Task 4 |
| 100% coverage gate on `src/vault/**` | 237 | Task 10 |

- [ ] **Step 2: Placeholder scan.** `grep -nE "TBD|fill in|appropriate|similar to Task" devnotes/architecture/plans/2026-05-21-vault-extract-plan.md`. Expected: empty.

- [ ] **Step 3: Type consistency check.**
  - `EnrichmentResult` fields used in Task 8 match Task 4 definition.
  - `EnrichmentOptions` fields passed by Task 9 match Task 4.
  - `LockBusyError` import (Task 6 + 9) matches Task 2 export.
  - `runCleanupPass` is `async`; every call site `await`s.

- [ ] **Step 4:** If gap found, add `Task Nb` inline at appropriate position. No re-review.

- [ ] **Step 5: Full suite.** `npx vitest run --reporter=verbose 2>&1 | tail -30`. Expected: green.

- [ ] **Step 6: Final commit if any gap-fix ran.** `git status` — clean → no commit.

---

## Open questions / divergences from spec

1. **Schema names.** Spec `kg_triples.provenance` → real `knowledge.source_memory_id`. Plan uses real names.
2. **No `extracted` flag column.** `source_memory_id IS NOT NULL` is sufficient. v2 migration if strict marker needed later.
3. **`extractAndStore` overlap.** Opportunistic only. Subsystem 2 fills raw-storage + LLM-miss + backlog gap. Task 1 quantifies.
4. **Lock owned here, not in `decay.ts`.** Spec line 192's "existing pattern" doesn't exist. Lock lives in `src/vault/lock.ts`.
5. **`runCleanupPass` becomes `async`.** Breaking for external SDK consumers — acceptable in `1.2.0-alpha.2`. Task 8 Step 4 updates all call sites.
6. **MCP `memory_dream` enrichment is opt-in.** OpenClaw uses env gate; manual MCP callers pass `runEnrichment: true`. Keeps the tool cheap.
7. **Prompt finalised in this plan, not deferred.** Task 7 eval validates against fixtures; results recorded in gitignored devnotes.

---

**Total: 12 tasks (0-11).**
