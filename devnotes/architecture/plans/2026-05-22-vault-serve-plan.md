# Vault Serve (Subsystem 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `lotl vault serve` — a zero-dep HTTP server that exposes the live KG as a cytoscape force-directed graph viewer in the browser, with port discovery, scope filtering, and an empty-state path. Lands as v1.2.0 stable.

**Architecture:** Subsystem 3 of the vault-export design (see `devnotes/architecture/2026-05-20-vault-export-design.md`). Pure read-side: queries `knowledge` table via `knowledgeQuery` on every `GET /graph.json` request — no caching, no .md dependency, no shared state with Subsystems 1/2. Uses raw `node:http` (same as MCP HTTP server in `src/mcp/server.ts`) — zero new deps. Static SPA in `assets/vault-viewer/`, cytoscape via pinned CDN with SRI hashes, offline-vendor escape hatch.

**Tech Stack:** TypeScript 5.9, Node 22+ ESM, `node:http`, `node:fs/promises`, `node:net`, better-sqlite3 (existing), cytoscape 3.30.0 + cytoscape-cose-bilkent 4.1.0 (browser-side via CDN). Vitest 3.2 for tests. No new npm dependencies.

---

## HTTP framework decision: `node:http` (not Hono)

**Decision:** raw `node:http.createServer`.

**Why:**

1. **Zero new deps.** `hono` and `@hono/node-server` currently appear only under `overrides` in `package.json` — adding them as real `dependencies` would bring ~30 transitive packages. The project's stated value is lean deps (`@modelcontextprotocol/sdk`, `better-sqlite3`, `sqlite-vec` are the heavy hitters; everything else is small).
2. **Consistency.** `src/mcp/server.ts:1301` already builds its HTTP transport on raw `node:http` with `createServer` + manual route matching. Reusing that pattern keeps the codebase mono-stylistic; an engineer reading both files learns one routing idiom, not two.
3. **Trivial routing.** Subsystem 3 has 4 routes total (`GET /`, `GET /scopes`, `GET /graph.json`, `GET /assets/*`). Pattern matching is ~25 LOC of `if (pathname === ...)` ladders. Hono's middleware machinery is unjustified for that shape.
4. **No streaming, no SSE, no auth.** Viewer is localhost-only and returns small JSON / static files in one `res.end()` call. The features Hono shines at (middleware, validators, contexts) are unused here.

**Escape hatch:** if a follow-up adds websockets, server-sent events, or auth, Hono can be revisited then — and at that point it's a real dependency for a real reason, not premature.

---

## File structure

**Create:**

| Path | Responsibility | LOC est. |
|---|---|---|
| `src/vault/serve.ts` | HTTP server: port discovery loop, route table, KG → cytoscape transform, scopes endpoint, empty-state handling. Exports `startVaultServer({db, port?, range?, viewerDir?})` returning `{port, stop}`. | ~180 |
| `assets/vault-viewer/index.html` | Static SPA shell. CDN script tags with SRI, scope dropdown, current-only toggle, `<div id="cy">`. | ~80 |
| `assets/vault-viewer/viewer.js` | Cytoscape init + fetch lifecycle (`/scopes` on load, `/graph.json` on change), expired-edge styling, empty-state DOM. | ~140 |
| `assets/vault-viewer/styles.css` | Plain CSS for layout (header bar + cy fullscreen + empty-state overlay). No Tailwind, no build step. | ~60 |
| `test/vault/serve.test.ts` | Unit: KG → cytoscape transform, scope filter, current-only filter, empty-state shape, port discovery happy path + exhaustion path with occupied ports, 404 handler. | ~280 |
| `test/vault/integration/serve-live.test.ts` | Boot real server on `port: 0` (OS-assigned), HTTP GET `/`, `/scopes`, `/graph.json`, `/graph.json?scope=X`, `/assets/viewer.js`. Asserts content-types + shapes. | ~160 |

**Modify:**

| Path | Change |
|---|---|
| `src/cli/vault-commands.ts` | Add `runVaultServe({port?, range?, quiet?})` handler. Parses `--port N` and `LOTL_VAULT_PORT_RANGE`. On startup prints `[vault:serve] listening on http://localhost:<port>` via `info()` helper. SIGINT/SIGTERM → graceful shutdown. |
| `src/cli/lotl.ts` | Already dispatches `vault serve` (per spec). If not yet wired: add `case "serve": await runVaultServe(rest); break;` in the `vault` subcommand switch. |
| `vitest.config.ts` | Add `coverage` block: `provider: 'v8'`, `include: ['src/vault/**']`, `exclude: ['assets/vault-viewer/**', 'test/**']`, `thresholds: { 100: true }`. |
| `package.json` | No change (decision above). Document in PR description that `hono` stays in `overrides` only. |

**Coverage exclusion rationale (must appear in `vitest.config.ts` comment):**
`assets/vault-viewer/**` is browser-side markup + a thin cytoscape config. No Node code paths, no test framework can meaningfully exercise it without a headless browser. Smoke test asserts the HTML contains the cytoscape init token; full DOM/render testing is third-party concern (see spec §Testing → "Out of scope for tests").

---

## Vendor offline escape hatch

`LOTL_VAULT_VIEWER_OFFLINE=on` switches the viewer from CDN imports to locally-served vendor JS at `assets/vault-viewer/vendor/cytoscape.min.js` and `assets/vault-viewer/vendor/cytoscape-cose-bilkent.js`. v1 default is CDN-on. The offline files are downloaded + committed as a separate task (Task 12). The SPA reads a server-injected `<meta name="lotl-viewer-mode" content="cdn|offline">` to pick which script source to fetch.

**Why a meta tag and not two HTML files:** keeps one source of truth for the markup; offline mode is a 1-line server flag, not a forked file.

---

## CDN URLs and SRI hashes

```
https://unpkg.com/cytoscape@3.30.0/dist/cytoscape.min.js
  integrity="sha384-PLACEHOLDER_CYTOSCAPE_330"
  crossorigin="anonymous"

https://unpkg.com/cytoscape-cose-bilkent@4.1.0/cytoscape-cose-bilkent.js
  integrity="sha384-PLACEHOLDER_COSE_BILKENT_410"
  crossorigin="anonymous"
```

**SRI placeholder note (read before Task 4):** the engineer must run `curl -s <URL> | openssl dgst -sha384 -binary | openssl base64 -A` for each URL and substitute the real hash in `index.html`. Placeholder strings above ship as-is would cause the browser to refuse the script — failing closed is the desired behavior. Task 4 step 3 contains the exact two `curl` commands and an `Edit` step to swap them in.

---

## Task list

### Task 1: vitest coverage scaffold

**Files:**
- Modify: `vitest.config.ts`

- [ ] **Step 1: Replace the file contents**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // assets/vault-viewer/** is browser-only markup + cytoscape config — no Node
      // code paths to test. See devnotes plan 2026-05-22-vault-serve-plan.md §coverage.
      include: ["src/vault/**"],
      exclude: ["assets/vault-viewer/**", "test/**", "**/*.d.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
```

- [ ] **Step 2: Run the coverage tool to confirm it parses**

Run: `npx vitest run --coverage --reporter=verbose test/store.test.ts`
Expected: PASS (or whatever the existing test reports). Coverage output appears at the bottom. Do not assert on coverage % yet — `src/vault/serve.ts` does not exist.

- [ ] **Step 3: Commit**

```bash
git add vitest.config.ts
git commit -m "chore(vault): scaffold v8 coverage gate on src/vault/**"
```

---

### Task 2: Port discovery — failing test first

**Files:**
- Create: `test/vault/serve.test.ts`
- Test: `test/vault/serve.test.ts` (same file)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { findAvailablePort } from "../../src/vault/serve.js";

const occupied: Server[] = [];

afterEach(async () => {
  await Promise.all(occupied.map(s => new Promise<void>(r => s.close(() => r()))));
  occupied.length = 0;
});

async function occupy(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const s = createServer().listen(port, "127.0.0.1", () => {
      occupied.push(s);
      resolve();
    });
    s.on("error", reject);
  });
}

describe("findAvailablePort", () => {
  it("returns the first port when it is free", async () => {
    // Pick a high range likely to be free in CI.
    const port = await findAvailablePort({ start: 27400, end: 27410 });
    expect(port).toBeGreaterThanOrEqual(27400);
    expect(port).toBeLessThanOrEqual(27410);
  });

  it("skips occupied ports and returns the next free one", async () => {
    await occupy(27420);
    const port = await findAvailablePort({ start: 27420, end: 27430 });
    expect(port).toBe(27421);
  });

  it("throws when the entire range is occupied", async () => {
    await occupy(27440);
    await occupy(27441);
    await expect(findAvailablePort({ start: 27440, end: 27441 }))
      .rejects.toThrow(/no port available in 27440-27441/);
  });

  it("validates start <= end", async () => {
    await expect(findAvailablePort({ start: 30, end: 10 }))
      .rejects.toThrow(/invalid port range/);
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: FAIL — `Cannot find module '../../src/vault/serve.js'`.

- [ ] **Step 3: Create the minimal implementation**

Create `src/vault/serve.ts`:

```ts
// Vault serve — HTTP viewer over the live KG. See devnotes plan
// 2026-05-22-vault-serve-plan.md.

import { createServer, type Server } from "node:http";

export type PortRange = { start: number; end: number };

export async function findAvailablePort(range: PortRange): Promise<number> {
  if (range.start > range.end) {
    throw new Error(`invalid port range: ${range.start}-${range.end}`);
  }
  for (let p = range.start; p <= range.end; p++) {
    const ok = await tryBind(p);
    if (ok) return p;
  }
  throw new Error(
    `no port available in ${range.start}-${range.end}; ` +
    `set LOTL_VAULT_PORT_RANGE or pass --port`
  );
}

function tryBind(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const s: Server = createServer();
    const settle = (ok: boolean) => {
      s.removeAllListeners();
      try { s.close(); } catch { /* already closed */ }
      resolve(ok);
    };
    s.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        settle(false);
      } else {
        settle(false);
      }
    });
    s.listen(port, "127.0.0.1", () => settle(true));
  });
}
```

- [ ] **Step 4: Run the test, expect PASS**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/serve.ts test/vault/serve.test.ts
git commit -m "feat(vault): findAvailablePort with EADDRINUSE skipping"
```

---

### Task 3: Parse `LOTL_VAULT_PORT_RANGE`

**Files:**
- Modify: `src/vault/serve.ts`
- Modify: `test/vault/serve.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `test/vault/serve.test.ts`:

```ts
import { parsePortRange } from "../../src/vault/serve.js";

describe("parsePortRange", () => {
  it("parses 'a-b' form", () => {
    expect(parsePortRange("7000-7999")).toEqual({ start: 7000, end: 7999 });
  });

  it("parses a single port as a 1-wide range", () => {
    expect(parsePortRange("8080")).toEqual({ start: 8080, end: 8080 });
  });

  it("trims whitespace", () => {
    expect(parsePortRange("  7000 - 7010 ")).toEqual({ start: 7000, end: 7010 });
  });

  it("rejects non-numeric", () => {
    expect(() => parsePortRange("abc")).toThrow(/invalid LOTL_VAULT_PORT_RANGE/);
  });

  it("rejects negative", () => {
    expect(() => parsePortRange("-1-100")).toThrow(/invalid LOTL_VAULT_PORT_RANGE/);
  });

  it("rejects > 65535", () => {
    expect(() => parsePortRange("70000-80000")).toThrow(/invalid LOTL_VAULT_PORT_RANGE/);
  });

  it("rejects inverted range", () => {
    expect(() => parsePortRange("8000-7000")).toThrow(/invalid LOTL_VAULT_PORT_RANGE/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: FAIL — `parsePortRange is not exported`.

- [ ] **Step 3: Implement**

Append to `src/vault/serve.ts`:

```ts
export function parsePortRange(spec: string): PortRange {
  const s = spec.trim();
  const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(s);
  if (!m) throw new Error(`invalid LOTL_VAULT_PORT_RANGE: "${spec}"`);
  const start = Number(m[1]);
  const end = m[2] !== undefined ? Number(m[2]) : start;
  if (!Number.isInteger(start) || !Number.isInteger(end)
    || start < 1 || end < 1 || start > 65535 || end > 65535 || start > end) {
    throw new Error(`invalid LOTL_VAULT_PORT_RANGE: "${spec}"`);
  }
  return { start, end };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/serve.ts test/vault/serve.test.ts
git commit -m "feat(vault): parsePortRange validator"
```

---

### Task 4: KG → cytoscape transform — pure function

**Files:**
- Modify: `src/vault/serve.ts`
- Modify: `test/vault/serve.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `test/vault/serve.test.ts`:

```ts
import { kgToCytoscape } from "../../src/vault/serve.js";
import type { KnowledgeEntry } from "../../src/memory/knowledge.js";

function entry(partial: Partial<KnowledgeEntry> & {
  subject: string; predicate: string; object: string;
}): KnowledgeEntry {
  return {
    id: partial.id ?? crypto.randomUUID(),
    subject: partial.subject,
    predicate: partial.predicate,
    object: partial.object,
    valid_from: partial.valid_from ?? null,
    valid_until: partial.valid_until ?? null,
    confidence: partial.confidence ?? 1,
    source_memory_id: partial.source_memory_id ?? null,
    created_at: partial.created_at ?? Date.now(),
  };
}

describe("kgToCytoscape", () => {
  it("returns empty graph with empty_state flag when no entries", () => {
    const g = kgToCytoscape([]);
    expect(g).toEqual({ nodes: [], edges: [], empty_state: true });
  });

  it("creates nodes for both subject and object", () => {
    const g = kgToCytoscape([
      entry({ subject: "david", predicate: "works_on", object: "lotl" }),
    ]);
    expect(g.nodes.map(n => n.data.id).sort()).toEqual(["david", "lotl"]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].data).toMatchObject({
      source: "david",
      target: "lotl",
      label: "works_on",
      active: true,
    });
    expect(g.empty_state).toBeUndefined();
  });

  it("marks active=false when valid_until is set", () => {
    const g = kgToCytoscape([
      entry({ subject: "a", predicate: "p", object: "b", valid_until: 123 }),
    ]);
    expect(g.edges[0].data.active).toBe(false);
  });

  it("aggregates memory_count from distinct source_memory_id per node", () => {
    const g = kgToCytoscape([
      entry({ subject: "x", predicate: "p", object: "y", source_memory_id: "m1" }),
      entry({ subject: "x", predicate: "q", object: "z", source_memory_id: "m2" }),
      entry({ subject: "x", predicate: "r", object: "y", source_memory_id: "m1" }), // dup
      entry({ subject: "y", predicate: "p", object: "z", source_memory_id: null }), // null skipped
    ]);
    const byId = new Map(g.nodes.map(n => [n.data.id, n.data.memory_count]));
    expect(byId.get("x")).toBe(2);  // m1, m2
    expect(byId.get("y")).toBe(1);  // m1 only (subject side); null skipped
    expect(byId.get("z")).toBe(2);  // m2, null-skipped one not counted -> m2 + (third dup m1) = m1+m2 = 2
  });

  it("filters by current_only — drops edges with valid_until set", () => {
    const g = kgToCytoscape([
      entry({ subject: "a", predicate: "p", object: "b" }),
      entry({ subject: "c", predicate: "p", object: "d", valid_until: 999 }),
    ], { current_only: true });
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].data.source).toBe("a");
  });

  it("returns empty_state when current_only filters everything out", () => {
    const g = kgToCytoscape([
      entry({ subject: "c", predicate: "p", object: "d", valid_until: 999 }),
    ], { current_only: true });
    expect(g.empty_state).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: FAIL — `kgToCytoscape is not exported`.

- [ ] **Step 3: Implement**

Append to `src/vault/serve.ts`:

```ts
import type { KnowledgeEntry } from "../memory/knowledge.js";

export type CytoscapeNode = {
  data: { id: string; label: string; memory_count: number };
};

export type CytoscapeEdge = {
  data: {
    id: string;
    source: string;
    target: string;
    label: string;
    active: boolean;
  };
};

export type CytoscapeGraph = {
  nodes: CytoscapeNode[];
  edges: CytoscapeEdge[];
  empty_state?: true;
};

export type TransformOptions = { current_only?: boolean };

export function kgToCytoscape(
  entries: KnowledgeEntry[],
  options: TransformOptions = {}
): CytoscapeGraph {
  const filtered = options.current_only
    ? entries.filter(e => e.valid_until === null)
    : entries;

  if (filtered.length === 0) {
    return { nodes: [], edges: [], empty_state: true };
  }

  // node id -> set of distinct source_memory_id contributions
  const memorySources = new Map<string, Set<string>>();
  const labels = new Map<string, string>();
  const edges: CytoscapeEdge[] = [];

  for (const e of filtered) {
    for (const v of [e.subject, e.object]) {
      if (!memorySources.has(v)) memorySources.set(v, new Set());
      if (!labels.has(v)) labels.set(v, v);
      if (e.source_memory_id) {
        memorySources.get(v)!.add(e.source_memory_id);
      }
    }
    edges.push({
      data: {
        id: e.id,
        source: e.subject,
        target: e.object,
        label: e.predicate,
        active: e.valid_until === null,
      },
    });
  }

  const nodes: CytoscapeNode[] = [...memorySources.entries()].map(([id, sources]) => ({
    data: { id, label: labels.get(id) ?? id, memory_count: sources.size },
  }));

  return { nodes, edges };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/serve.ts test/vault/serve.test.ts
git commit -m "feat(vault): kgToCytoscape transform with memory_count aggregation"
```

---

### Task 5: Scopes endpoint helper

**Files:**
- Modify: `src/vault/serve.ts`
- Modify: `test/vault/serve.test.ts`

- [ ] **Step 1: Append failing test**

Append to `test/vault/serve.test.ts`:

```ts
import Database from "better-sqlite3";
import { listKnowledgeScopes } from "../../src/vault/serve.js";

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE knowledge (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      valid_from INTEGER,
      valid_until INTEGER,
      confidence REAL NOT NULL DEFAULT 1,
      source_memory_id TEXT,
      scope TEXT NOT NULL DEFAULT 'global',
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

describe("listKnowledgeScopes", () => {
  it("returns ['global'] when table is empty", () => {
    const db = seedDb();
    expect(listKnowledgeScopes(db as any)).toEqual(["global"]);
    db.close();
  });

  it("returns sorted distinct scopes, with 'global' first if present", () => {
    const db = seedDb();
    const ins = db.prepare(`
      INSERT INTO knowledge (id, subject, predicate, object, scope, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    ins.run("1", "a", "p", "b", "project-foo", 1);
    ins.run("2", "c", "p", "d", "agent-bar", 2);
    ins.run("3", "e", "p", "f", "global", 3);
    ins.run("4", "g", "p", "h", "project-foo", 4); // dup

    expect(listKnowledgeScopes(db as any)).toEqual(["global", "agent-bar", "project-foo"]);
    db.close();
  });

  it("returns ['global'] if no rows include 'global'", () => {
    const db = seedDb();
    db.prepare(`
      INSERT INTO knowledge (id, subject, predicate, object, scope, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("1", "a", "p", "b", "project-foo", 1);
    expect(listKnowledgeScopes(db as any)).toEqual(["global", "project-foo"]);
    db.close();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: FAIL — `listKnowledgeScopes is not exported`.

- [ ] **Step 3: Implement**

Append to `src/vault/serve.ts`:

```ts
import type { Database } from "../db.js";

export function listKnowledgeScopes(db: Database): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT scope FROM knowledge ORDER BY scope`
  ).all() as { scope: string }[];
  const set = new Set(rows.map(r => r.scope));
  set.add("global"); // dropdown always shows global
  const sorted = [...set].filter(s => s !== "global").sort();
  return ["global", ...sorted];
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/serve.ts test/vault/serve.test.ts
git commit -m "feat(vault): listKnowledgeScopes — global-first scope dropdown source"
```

---

### Task 6: KG live query wrapper with current_only filter

**Files:**
- Modify: `src/vault/serve.ts`
- Modify: `test/vault/serve.test.ts`

The endpoint reads triples from the DB, including expired (`valid_until != null`) ones so the viewer can show them faded. `knowledgeQuery` with `as_of` filters them out — so for graph.json we use a direct query.

- [ ] **Step 1: Append failing test**

Append to `test/vault/serve.test.ts`:

```ts
import { fetchGraphEntries } from "../../src/vault/serve.js";

describe("fetchGraphEntries", () => {
  it("returns rows for a given scope including expired", () => {
    const db = seedDb();
    const ins = db.prepare(`
      INSERT INTO knowledge (id, subject, predicate, object, valid_from, valid_until, scope, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    ins.run("1", "a", "p", "b", 100, null, "project-foo", 1);
    ins.run("2", "c", "p", "d", 100, 200, "project-foo", 2);  // expired
    ins.run("3", "e", "p", "f", 100, null, "agent-bar", 3);

    const rows = fetchGraphEntries(db as any, "project-foo");
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.id).sort()).toEqual(["1", "2"]);
    db.close();
  });

  it("returns all scopes when scope omitted", () => {
    const db = seedDb();
    const ins = db.prepare(`
      INSERT INTO knowledge (id, subject, predicate, object, scope, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    ins.run("1", "a", "p", "b", "project-foo", 1);
    ins.run("2", "c", "p", "d", "agent-bar", 2);
    expect(fetchGraphEntries(db as any)).toHaveLength(2);
    db.close();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: FAIL — `fetchGraphEntries is not exported`.

- [ ] **Step 3: Implement**

Append to `src/vault/serve.ts`:

```ts
export function fetchGraphEntries(db: Database, scope?: string): KnowledgeEntry[] {
  if (scope) {
    return db.prepare(
      `SELECT id, subject, predicate, object, valid_from, valid_until,
              confidence, source_memory_id, created_at
       FROM knowledge WHERE scope = ?
       ORDER BY created_at ASC`
    ).all(scope) as KnowledgeEntry[];
  }
  return db.prepare(
    `SELECT id, subject, predicate, object, valid_from, valid_until,
            confidence, source_memory_id, created_at
     FROM knowledge ORDER BY created_at ASC`
  ).all() as KnowledgeEntry[];
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/serve.ts test/vault/serve.test.ts
git commit -m "feat(vault): fetchGraphEntries — scope-filtered KG read incl. expired"
```

---

### Task 7: Static asset MIME helper + path safety

**Files:**
- Modify: `src/vault/serve.ts`
- Modify: `test/vault/serve.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `test/vault/serve.test.ts`:

```ts
import { resolveAssetPath, mimeFor } from "../../src/vault/serve.js";

describe("resolveAssetPath", () => {
  it("resolves a normal asset under the viewer dir", () => {
    const out = resolveAssetPath("/base", "/assets/viewer.js");
    // OS-agnostic check via path.sep
    expect(out?.replace(/\\/g, "/")).toBe("/base/viewer.js");
  });

  it("returns null for traversal attempts", () => {
    expect(resolveAssetPath("/base", "/assets/../../etc/passwd")).toBeNull();
    expect(resolveAssetPath("/base", "/assets/..\\..\\etc\\passwd")).toBeNull();
  });

  it("returns null for missing /assets/ prefix", () => {
    expect(resolveAssetPath("/base", "/viewer.js")).toBeNull();
  });

  it("returns null for empty filename", () => {
    expect(resolveAssetPath("/base", "/assets/")).toBeNull();
  });
});

describe("mimeFor", () => {
  it.each([
    [".html", "text/html; charset=utf-8"],
    [".js",   "text/javascript; charset=utf-8"],
    [".css",  "text/css; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".svg",  "image/svg+xml"],
    [".png",  "image/png"],
    [".woff2","font/woff2"],
    [".bin",  "application/octet-stream"],
  ])("maps %s -> %s", (ext, mime) => {
    expect(mimeFor("foo" + ext)).toBe(mime);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: FAIL — `resolveAssetPath is not exported`.

- [ ] **Step 3: Implement**

Append to `src/vault/serve.ts`:

```ts
import { resolve, sep, extname } from "node:path";

export function resolveAssetPath(viewerDir: string, urlPath: string): string | null {
  const m = /^\/assets\/(.+)$/.exec(urlPath);
  if (!m) return null;
  const tail = m[1];
  if (!tail || tail.includes("\0")) return null;
  // Reject traversal sequences in either separator style.
  if (tail.includes("..")) return null;
  const baseAbs = resolve(viewerDir);
  const candidate = resolve(baseAbs, tail);
  if (!candidate.startsWith(baseAbs + sep) && candidate !== baseAbs) return null;
  return candidate;
}

const MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2":"font/woff2",
  ".woff": "font/woff",
};

export function mimeFor(filename: string): string {
  return MIME_MAP[extname(filename).toLowerCase()] ?? "application/octet-stream";
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: PASS, 34 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/serve.ts test/vault/serve.test.ts
git commit -m "feat(vault): asset path safety + MIME map"
```

---

### Task 8: HTTP server boot — `startVaultServer`

**Files:**
- Modify: `src/vault/serve.ts`
- Modify: `test/vault/serve.test.ts`

- [ ] **Step 1: Append failing test**

Append to `test/vault/serve.test.ts`:

```ts
import { startVaultServer } from "../../src/vault/serve.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeViewerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lotl-viewer-"));
  writeFileSync(join(dir, "index.html"),
    `<!doctype html><html><body><div id="cy"></div>` +
    `<script>cytoscape({container:document.getElementById('cy')})</script>` +
    `</body></html>`);
  writeFileSync(join(dir, "viewer.js"), `console.log("viewer")`);
  writeFileSync(join(dir, "styles.css"), `body { margin: 0 }`);
  return dir;
}

// Boot helper — every test below uses the same shape.
async function boot(db: Database.Database, extra: Partial<Parameters<typeof startVaultServer>[0]> = {}) {
  const viewerDir = makeViewerDir();
  const srv = await startVaultServer({ db: db as any, port: 0, viewerDir, quiet: true, ...extra });
  return { srv, viewerDir, base: `http://127.0.0.1:${srv.port}` };
}

describe("startVaultServer", () => {
  it("boots on port:0 and serves /graph.json with cytoscape shape", async () => {
    const db = seedDb();
    db.prepare(`INSERT INTO knowledge (id, subject, predicate, object, scope, created_at)
                VALUES ('e1', 'a', 'p', 'b', 'global', 1)`).run();
    const { srv, base } = await boot(db);
    try {
      const res = await fetch(`${base}/graph.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      const json = await res.json();
      expect(json.nodes.length).toBe(2);
      expect(json.edges.length).toBe(1);
    } finally { await srv.stop(); db.close(); }
  });

  it("serves SPA at / with cytoscape init token", async () => {
    const db = seedDb();
    const { srv, base } = await boot(db);
    try {
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain('id="cy"');
      expect(html).toContain("cytoscape(");
    } finally { await srv.stop(); db.close(); }
  });

  it("serves /scopes including 'global' first", async () => {
    const db = seedDb();
    db.prepare(`INSERT INTO knowledge (id, subject, predicate, object, scope, created_at)
                VALUES ('e1', 'a', 'p', 'b', 'project-foo', 1)`).run();
    const { srv, base } = await boot(db);
    try {
      const json = await (await fetch(`${base}/scopes`)).json();
      expect(json.scopes).toEqual(["global", "project-foo"]);
    } finally { await srv.stop(); db.close(); }
  });

  it("scopes /graph.json with ?scope=", async () => {
    const db = seedDb();
    const ins = db.prepare(`INSERT INTO knowledge (id, subject, predicate, object, scope, created_at) VALUES (?,?,?,?,?,?)`);
    ins.run("1", "a", "p", "b", "project-foo", 1);
    ins.run("2", "c", "p", "d", "agent-bar", 2);
    const { srv, base } = await boot(db);
    try {
      const json = await (await fetch(`${base}/graph.json?scope=project-foo`)).json();
      expect(json.edges.map((e: any) => e.data.id)).toEqual(["1"]);
    } finally { await srv.stop(); db.close(); }
  });

  it("applies ?current_only=1", async () => {
    const db = seedDb();
    const ins = db.prepare(`INSERT INTO knowledge (id, subject, predicate, object, valid_until, scope, created_at) VALUES (?,?,?,?,?,?,?)`);
    ins.run("1", "a", "p", "b", null, "global", 1);
    ins.run("2", "c", "p", "d", 999, "global", 2);
    const { srv, base } = await boot(db);
    try {
      const json = await (await fetch(`${base}/graph.json?current_only=1`)).json();
      expect(json.edges).toHaveLength(1);
      expect(json.edges[0].data.id).toBe("1");
    } finally { await srv.stop(); db.close(); }
  });

  it("returns empty_state when KG empty", async () => {
    const db = seedDb();
    const { srv, base } = await boot(db);
    try {
      const json = await (await fetch(`${base}/graph.json`)).json();
      expect(json).toEqual({ nodes: [], edges: [], empty_state: true });
    } finally { await srv.stop(); db.close(); }
  });

  it("serves /assets/<file> with correct MIME", async () => {
    const db = seedDb();
    const { srv, base } = await boot(db);
    try {
      const res = await fetch(`${base}/assets/viewer.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/javascript/);
      expect(await res.text()).toContain("viewer");
    } finally { await srv.stop(); db.close(); }
  });

  it("rejects /assets/ traversal with 404", async () => {
    const db = seedDb();
    const { srv, base } = await boot(db);
    try {
      expect((await fetch(`${base}/assets/../../etc/passwd`)).status).toBe(404);
    } finally { await srv.stop(); db.close(); }
  });

  it("returns 404 for unknown routes", async () => {
    const db = seedDb();
    const { srv, base } = await boot(db);
    try {
      expect((await fetch(`${base}/wat`)).status).toBe(404);
    } finally { await srv.stop(); db.close(); }
  });

  it("returns 405 for non-GET methods", async () => {
    const db = seedDb();
    const { srv, base } = await boot(db);
    try {
      expect((await fetch(`${base}/graph.json`, { method: "POST" })).status).toBe(405);
    } finally { await srv.stop(); db.close(); }
  });

  it("uses port range when port is undefined", async () => {
    const db = seedDb();
    const { srv } = await boot(db, { port: undefined, range: { start: 27500, end: 27510 } });
    try {
      expect(srv.port).toBeGreaterThanOrEqual(27500);
      expect(srv.port).toBeLessThanOrEqual(27510);
    } finally { await srv.stop(); db.close(); }
  });

  it("hard-fails when explicit port is taken", async () => {
    const taken = await new Promise<Server>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (taken.address() as any).port;
    const db = seedDb();
    const viewerDir = makeViewerDir();
    await expect(
      startVaultServer({ db: db as any, port, viewerDir, quiet: true })
    ).rejects.toThrow(/port \d+ unavailable/);
    await new Promise<void>(r => taken.close(() => r()));
    db.close();
  });

  it("returns 500 when handler throws (closed db)", async () => {
    const db = seedDb();
    const { srv, base } = await boot(db);
    db.close();
    try {
      expect((await fetch(`${base}/graph.json`)).status).toBe(500);
    } finally { await srv.stop(); }
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: FAIL — `startVaultServer is not exported`.

- [ ] **Step 3: Implement**

Append to `src/vault/serve.ts`:

```ts
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL as NodeURL } from "node:url";

export type StartVaultServerOptions = {
  db: Database;
  /** If set, bind exactly this port (hard fail on EADDRINUSE). 0 = OS-assigned. */
  port?: number;
  /** If `port` is undefined, scan this range. Default {start:7000, end:7999}. */
  range?: PortRange;
  /** Directory containing index.html / viewer.js / styles.css. */
  viewerDir: string;
  /** Suppress startup log line (used in tests). */
  quiet?: boolean;
};

export type VaultServer = {
  port: number;
  stop: () => Promise<void>;
};

export async function startVaultServer(
  opts: StartVaultServerOptions
): Promise<VaultServer> {
  const range = opts.range ?? { start: 7000, end: 7999 };

  let boundPort: number;
  if (opts.port !== undefined) {
    const ok = await tryBind(opts.port);
    if (!ok) {
      throw new Error(`[vault:serve] port ${opts.port} unavailable`);
    }
    boundPort = opts.port;
  } else {
    boundPort = await findAvailablePort(range);
  }

  const handler = makeHandler(opts.db, opts.viewerDir);
  const httpServer = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(boundPort, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const actualPort = (httpServer.address() as import("net").AddressInfo).port;

  if (!opts.quiet) {
    console.info(`[vault:serve] listening on http://localhost:${actualPort}`);
  }

  return {
    port: actualPort,
    stop: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

function makeHandler(db: Database, viewerDir: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new NodeURL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("Method Not Allowed");
        return;
      }

      if (pathname === "/" || pathname === "/index.html") {
        const html = await readFile(resolve(viewerDir, "index.html"), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (pathname === "/scopes") {
        const scopes = listKnowledgeScopes(db);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ scopes }));
        return;
      }

      if (pathname === "/graph.json") {
        const scope = url.searchParams.get("scope") ?? undefined;
        const currentOnly = url.searchParams.get("current_only") === "1";
        const rows = fetchGraphEntries(db, scope);
        const graph = kgToCytoscape(rows, { current_only: currentOnly });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(graph));
        return;
      }

      if (pathname.startsWith("/assets/")) {
        const filePath = resolveAssetPath(viewerDir, pathname);
        if (!filePath) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return;
        }
        try {
          const buf = await readFile(filePath);
          res.writeHead(200, { "Content-Type": mimeFor(filePath) });
          res.end(buf);
        } catch {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    } catch (err) {
      console.error(`[vault:serve] handler error:`, err);
      try {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      } catch { /* response already sent */ }
    }
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: PASS, ~46 tests.

- [ ] **Step 5: Commit**

```bash
git add src/vault/serve.ts test/vault/serve.test.ts
git commit -m "feat(vault): startVaultServer with full route table"
```

---

### Task 9: Build the SPA shell (`index.html`)

**Files:**
- Create: `assets/vault-viewer/index.html`

- [ ] **Step 1: Fetch SRI hashes for the CDN scripts**

Run:

```bash
curl -s https://unpkg.com/cytoscape@3.30.0/dist/cytoscape.min.js \
  | openssl dgst -sha384 -binary | openssl base64 -A
curl -s https://unpkg.com/cytoscape-cose-bilkent@4.1.0/cytoscape-cose-bilkent.js \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

Expected: two base64 strings. Write them down — they replace `PLACEHOLDER_CYTOSCAPE_330` and `PLACEHOLDER_COSE_BILKENT_410` in the next step.

- [ ] **Step 2: Create the file**

Create `assets/vault-viewer/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lotl Vault Viewer</title>
  <link rel="stylesheet" href="/assets/styles.css">
  <script src="https://unpkg.com/cytoscape@3.30.0/dist/cytoscape.min.js"
          integrity="sha384-PLACEHOLDER_CYTOSCAPE_330"
          crossorigin="anonymous"></script>
  <script src="https://unpkg.com/cytoscape-cose-bilkent@4.1.0/cytoscape-cose-bilkent.js"
          integrity="sha384-PLACEHOLDER_COSE_BILKENT_410"
          crossorigin="anonymous"></script>
</head>
<body>
  <header id="controls">
    <span class="brand">Lotl Vault</span>
    <label for="scope-filter">Scope:</label>
    <select id="scope-filter"><option value="">(loading…)</option></select>
    <label class="toggle">
      <input type="checkbox" id="current-only">
      current facts only
    </label>
    <span id="stat-count" class="stat"></span>
  </header>
  <div id="cy"></div>
  <div id="empty-state" hidden>
    <h2>No entities yet.</h2>
    <p>Run a dream pass — <code>lotl memory dream</code> — to populate the knowledge graph,
       then refresh this page.</p>
  </div>
  <script src="/assets/viewer.js"></script>
</body>
</html>
```

- [ ] **Step 3: Replace the placeholders with real hashes**

Use the Edit tool twice — once per placeholder — substituting the base64 values captured in Step 1. Verify with:

```bash
grep -c "PLACEHOLDER" assets/vault-viewer/index.html
```

Expected: `0`.

- [ ] **Step 4: Commit**

```bash
git add assets/vault-viewer/index.html
git commit -m "feat(vault-viewer): SPA shell with pinned cytoscape + cose-bilkent CDN"
```

---

### Task 10: Build the SPA styles

**Files:**
- Create: `assets/vault-viewer/styles.css`

- [ ] **Step 1: Create the file**

```css
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; font-family: system-ui, sans-serif; }

#controls {
  position: fixed; top: 0; left: 0; right: 0; z-index: 10;
  display: flex; align-items: center; gap: 12px;
  padding: 8px 12px;
  background: rgba(255,255,255,0.92);
  border-bottom: 1px solid #ddd;
}
#controls .brand { font-weight: 600; }
#controls label.toggle { display: inline-flex; align-items: center; gap: 4px; }
#controls .stat { margin-left: auto; color: #666; font-size: 0.9em; }

#cy { position: absolute; top: 48px; left: 0; right: 0; bottom: 0; }

#empty-state {
  position: absolute; top: 48px; left: 0; right: 0; bottom: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; color: #555; gap: 8px;
}
#empty-state code {
  background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-family: ui-monospace, monospace;
}
```

- [ ] **Step 2: Commit**

```bash
git add assets/vault-viewer/styles.css
git commit -m "feat(vault-viewer): plain CSS layout"
```

---

### Task 11: Build the SPA logic (`viewer.js`)

**Files:**
- Create: `assets/vault-viewer/viewer.js`

- [ ] **Step 1: Create the file**

```js
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const scopeFilter = $("scope-filter");
  const currentOnly = $("current-only");
  const cyEl = $("cy");
  const emptyEl = $("empty-state");
  const statEl = $("stat-count");

  let cy = null;

  const STYLE = [
    {
      selector: "node",
      style: {
        "background-color": "#3a7bd5",
        "label": "data(label)",
        "color": "#222",
        "font-size": "11px",
        "text-valign": "center",
        "text-halign": "center",
        "text-margin-y": -8,
        "width": "mapData(memory_count, 0, 20, 18, 60)",
        "height": "mapData(memory_count, 0, 20, 18, 60)",
      },
    },
    {
      selector: "edge",
      style: {
        "curve-style": "bezier",
        "target-arrow-shape": "triangle",
        "line-color": "#3a7bd5",
        "target-arrow-color": "#3a7bd5",
        "width": 1.5,
        "label": "data(label)",
        "font-size": "9px",
        "color": "#666",
        "text-rotation": "autorotate",
      },
    },
    {
      selector: "edge[active = 0], edge[!active]",
      style: {
        "line-color": "#999",
        "target-arrow-color": "#999",
        "line-style": "dashed",
        "opacity": 0.6,
      },
    },
  ];

  const LAYOUT = {
    name: "cose-bilkent",
    quality: "default",
    nodeDimensionsIncludeLabels: true,
    randomize: true,
    fit: true,
    padding: 30,
    idealEdgeLength: 90,
    edgeElasticity: 0.45,
    nestingFactor: 0.1,
    gravity: 0.25,
    numIter: 2500,
    animate: false,
  };

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  }

  function buildScopeQuery() {
    const params = new URLSearchParams();
    if (scopeFilter.value) params.set("scope", scopeFilter.value);
    if (currentOnly.checked) params.set("current_only", "1");
    const s = params.toString();
    return s ? `/graph.json?${s}` : "/graph.json";
  }

  function showEmpty(show) {
    emptyEl.hidden = !show;
    cyEl.style.display = show ? "none" : "block";
  }

  async function render() {
    const data = await fetchJSON(buildScopeQuery());
    if (data.empty_state) {
      if (cy) { cy.elements().remove(); }
      statEl.textContent = "";
      showEmpty(true);
      return;
    }
    showEmpty(false);
    statEl.textContent = `${data.nodes.length} entities · ${data.edges.length} facts`;
    if (!cy) {
      cy = cytoscape({
        container: cyEl,
        elements: { nodes: data.nodes, edges: data.edges },
        style: STYLE,
        layout: LAYOUT,
        wheelSensitivity: 0.2,
      });
      cy.on("tap", "node", (evt) => {
        const id = evt.target.id();
        // Future: deep-link to entity .md file. v1: console only.
        console.info("[viewer] node clicked:", id);
      });
    } else {
      cy.elements().remove();
      cy.add({ nodes: data.nodes, edges: data.edges });
      cy.layout(LAYOUT).run();
    }
  }

  async function populateScopes() {
    const data = await fetchJSON("/scopes");
    scopeFilter.innerHTML = "";
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "(all scopes)";
    scopeFilter.appendChild(all);
    for (const s of data.scopes) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      scopeFilter.appendChild(opt);
    }
  }

  scopeFilter.addEventListener("change", () => { render().catch(console.error); });
  currentOnly.addEventListener("change", () => { render().catch(console.error); });

  (async () => {
    try {
      await populateScopes();
      await render();
    } catch (err) {
      console.error("[viewer] init failed:", err);
      statEl.textContent = "init failed (see console)";
    }
  })();
})();
```

- [ ] **Step 2: Commit**

```bash
git add assets/vault-viewer/viewer.js
git commit -m "feat(vault-viewer): cytoscape SPA — scope dropdown, current-only toggle, expired-edge styling"
```

---

### Task 12: Vendor offline files (escape hatch)

**Files:**
- Create: `assets/vault-viewer/vendor/cytoscape.min.js`
- Create: `assets/vault-viewer/vendor/cytoscape-cose-bilkent.js`
- Create: `assets/vault-viewer/.gitattributes`

- [ ] **Step 1: Download the vendor files**

Run:

```bash
mkdir -p assets/vault-viewer/vendor
curl -sL https://unpkg.com/cytoscape@3.30.0/dist/cytoscape.min.js \
  -o assets/vault-viewer/vendor/cytoscape.min.js
curl -sL https://unpkg.com/cytoscape-cose-bilkent@4.1.0/cytoscape-cose-bilkent.js \
  -o assets/vault-viewer/vendor/cytoscape-cose-bilkent.js
```

Expected: both files >100KB. Verify with:

```bash
ls -lh assets/vault-viewer/vendor/
```

- [ ] **Step 2: Verify hashes match Task 9**

```bash
openssl dgst -sha384 -binary assets/vault-viewer/vendor/cytoscape.min.js \
  | openssl base64 -A
openssl dgst -sha384 -binary assets/vault-viewer/vendor/cytoscape-cose-bilkent.js \
  | openssl base64 -A
```

Expected: the same two strings used as SRI hashes in `index.html`. If they differ, the CDN file changed under the pinned version — investigate before proceeding.

- [ ] **Step 3: Mark as binary so git doesn't diff them noisily**

Create `assets/vault-viewer/.gitattributes`:

```
vendor/*.js binary
```

- [ ] **Step 4: Commit**

```bash
git add assets/vault-viewer/vendor/ assets/vault-viewer/.gitattributes
git commit -m "feat(vault-viewer): vendor cytoscape + cose-bilkent for LOTL_VAULT_VIEWER_OFFLINE=on"
```

---

### Task 13: Wire `LOTL_VAULT_VIEWER_OFFLINE` into the SPA

**Files:**
- Modify: `src/vault/serve.ts`
- Modify: `assets/vault-viewer/index.html`

- [ ] **Step 1: Append failing test**

Append to `test/vault/serve.test.ts`:

```ts
describe("offline viewer mode", () => {
  it("injects mode=offline meta when env is on", async () => {
    process.env.LOTL_VAULT_VIEWER_OFFLINE = "on";
    const db = seedDb();
    const viewerDir = makeViewerDir();
    // Overwrite index.html to include the marker the rewriter looks for
    writeFileSync(join(viewerDir, "index.html"),
      `<!doctype html><html><head><!--LOTL_VIEWER_MODE--></head>` +
      `<body><div id="cy"></div></body></html>`);
    const srv = await startVaultServer({ db: db as any, port: 0, viewerDir, quiet: true });
    try {
      const html = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();
      expect(html).toContain('<meta name="lotl-viewer-mode" content="offline">');
    } finally {
      await srv.stop();
      delete process.env.LOTL_VAULT_VIEWER_OFFLINE;
      db.close();
    }
  });

  it("injects mode=cdn meta by default", async () => {
    delete process.env.LOTL_VAULT_VIEWER_OFFLINE;
    const db = seedDb();
    const viewerDir = makeViewerDir();
    writeFileSync(join(viewerDir, "index.html"),
      `<!doctype html><html><head><!--LOTL_VIEWER_MODE--></head><body></body></html>`);
    const srv = await startVaultServer({ db: db as any, port: 0, viewerDir, quiet: true });
    try {
      const html = await (await fetch(`http://127.0.0.1:${srv.port}/`)).text();
      expect(html).toContain('<meta name="lotl-viewer-mode" content="cdn">');
    } finally {
      await srv.stop();
      db.close();
    }
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: FAIL — the marker comment isn't replaced.

- [ ] **Step 3: Implement marker substitution**

Edit `src/vault/serve.ts` — in the `/` handler, after reading the HTML:

```ts
      if (pathname === "/" || pathname === "/index.html") {
        const raw = await readFile(resolve(viewerDir, "index.html"), "utf-8");
        const mode = process.env.LOTL_VAULT_VIEWER_OFFLINE === "on" ? "offline" : "cdn";
        const html = raw.replace(
          "<!--LOTL_VIEWER_MODE-->",
          `<meta name="lotl-viewer-mode" content="${mode}">`
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
```

- [ ] **Step 4: Add the marker comment to the real `index.html`**

Use Edit on `assets/vault-viewer/index.html`:

- Replace `<title>Lotl Vault Viewer</title>` with:

```
<title>Lotl Vault Viewer</title>
  <!--LOTL_VIEWER_MODE-->
```

- [ ] **Step 5: Update `viewer.js` and `index.html` to honor the mode**

Edit `assets/vault-viewer/index.html` — add `data-mode="cdn"` to both CDN `<script>` tags so the offline branch can remove them before they fetch:

```html
  <script src="https://unpkg.com/cytoscape@3.30.0/dist/cytoscape.min.js"
          data-mode="cdn"
          integrity="sha384-PLACEHOLDER_CYTOSCAPE_330"
          crossorigin="anonymous"></script>
  <script src="https://unpkg.com/cytoscape-cose-bilkent@4.1.0/cytoscape-cose-bilkent.js"
          data-mode="cdn"
          integrity="sha384-PLACEHOLDER_COSE_BILKENT_410"
          crossorigin="anonymous"></script>
```

(SRI placeholders already real hashes from Task 9.)

Replace the bootstrap IIFE at the bottom of `viewer.js` with:

```js
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  async function ensureCytoscape() {
    const mode = document.querySelector('meta[name="lotl-viewer-mode"]')?.content || "cdn";
    if (mode === "offline") {
      for (const el of document.querySelectorAll('script[data-mode="cdn"]')) el.remove();
      if (!window.cytoscape) await loadScript("/assets/vendor/cytoscape.min.js");
      await loadScript("/assets/vendor/cytoscape-cose-bilkent.js");
      return;
    }
    if (window.cytoscape) return;
    await loadScript("https://unpkg.com/cytoscape@3.30.0/dist/cytoscape.min.js");
    await loadScript("https://unpkg.com/cytoscape-cose-bilkent@4.1.0/cytoscape-cose-bilkent.js");
  }

  (async () => {
    try {
      await ensureCytoscape();
      await populateScopes();
      await render();
    } catch (err) {
      console.error("[viewer] init failed:", err);
      statEl.textContent = "init failed (see console)";
    }
  })();
```

- [ ] **Step 6: Run, expect PASS**

Run: `npx vitest run --reporter=verbose test/vault/serve.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/vault/serve.ts assets/vault-viewer/index.html assets/vault-viewer/viewer.js
git commit -m "feat(vault): LOTL_VAULT_VIEWER_OFFLINE escape hatch via injected mode meta"
```

---

### Task 14: CLI handler — `vault serve [--port N]`

**Files:**
- Modify: `src/cli/vault-commands.ts`

The file was created in Subsystem 1 and already houses `vault export`, `vault status`, `vault enrich`.

- [ ] **Step 1: Append `runVaultServe` to `src/cli/vault-commands.ts`**

```ts
import { startVaultServer, parsePortRange } from "../vault/serve.js";
import { info, warn } from "./terminal.js";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve to the bundled viewer dir alongside `dist/`. In dev (tsx), this also
// works because `__dirname` resolves to `src/cli/` and the relative jump up
// two levels lands at the repo root.
function defaultViewerDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, "..", "..", "assets", "vault-viewer");
}

export async function runVaultServe(argv: string[]): Promise<void> {
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        console.error(warn(`[vault:serve] invalid --port "${argv[i + 1]}"`));
        process.exit(2);
      }
      port = n;
      i++;
    }
  }

  const rangeSpec = process.env.LOTL_VAULT_PORT_RANGE ?? "7000-7999";
  let range;
  try {
    range = parsePortRange(rangeSpec);
  } catch (err) {
    console.error(warn(`[vault:serve] ${(err as Error).message}`));
    process.exit(2);
  }

  // Lazy import keeps cold-start fast for non-serve commands.
  const { default: BetterSqlite3 } = await import("better-sqlite3");
  const { getDefaultDbPath } = await import("../index.js");
  const db = new BetterSqlite3(getDefaultDbPath());

  let srv;
  try {
    srv = await startVaultServer({
      db: db as any,
      port,
      range,
      viewerDir: defaultViewerDir(),
    });
  } catch (err) {
    console.error(warn(`[vault:serve] ${(err as Error).message}`));
    db.close();
    process.exit(1);
    return;
  }

  console.info(info(`vault serve ready — http://localhost:${srv.port}`));
  console.info(info(`press ctrl+c to stop`));

  const shutdown = async (sig: string) => {
    console.info(info(`\n[vault:serve] ${sig} received, shutting down`));
    await srv.stop();
    db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
}
```

- [ ] **Step 2: Confirm the dispatcher wires `vault serve`**

Open `src/cli/lotl.ts` and grep for the vault subcommand dispatcher. If the case for `serve` doesn't exist (it may have been deferred from Subsystem 1), add it. If it already exists from Subsystem 1, this step is a noop.

Expected addition (only if missing):

```ts
      case "serve":
        await runVaultServe(rest);
        break;
```

- [ ] **Step 3: Run the typecheck**

Run: `npm run typecheck`
Expected: no errors. If `BetterSqlite3` typing complains, cast via `as unknown as Database` or import `Database.Database` directly.

- [ ] **Step 4: Commit**

```bash
git add src/cli/vault-commands.ts src/cli/lotl.ts
git commit -m "feat(cli): vault serve handler — --port + LOTL_VAULT_PORT_RANGE + graceful shutdown"
```

---

### Task 15: Integration smoke test (`serve-live.test.ts`)

**Files:**
- Create: `test/vault/integration/serve-live.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { startVaultServer } from "../../../src/vault/serve.js";

describe("vault serve — live smoke", () => {
  let db: Database.Database;
  let viewerDir: string;
  let srv: { port: number; stop: () => Promise<void> };

  beforeAll(async () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE knowledge (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        valid_from INTEGER,
        valid_until INTEGER,
        confidence REAL NOT NULL DEFAULT 1,
        source_memory_id TEXT,
        scope TEXT NOT NULL DEFAULT 'global',
        created_at INTEGER NOT NULL
      );
    `);
    const ins = db.prepare(`
      INSERT INTO knowledge (id, subject, predicate, object, source_memory_id, scope, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    ins.run("e1", "david", "works_on", "lotl", "m1", "global", 1);
    ins.run("e2", "david", "lives_in", "barcelona", "m2", "global", 2);
    ins.run("e3", "lotl", "uses", "sqlite", "m3", "project-foo", 3);

    viewerDir = mkdtempSync(join(tmpdir(), "lotl-viewer-live-"));
    writeFileSync(join(viewerDir, "index.html"),
      `<!doctype html><html><head><!--LOTL_VIEWER_MODE--></head>` +
      `<body><div id="cy"></div>` +
      `<script>cytoscape({container:document.getElementById('cy')})</script>` +
      `</body></html>`);
    writeFileSync(join(viewerDir, "viewer.js"), `// viewer`);
    writeFileSync(join(viewerDir, "styles.css"), `body { margin: 0 }`);

    srv = await startVaultServer({ db: db as any, port: 0, viewerDir, quiet: true });
  });

  afterAll(async () => {
    await srv.stop();
    db.close();
  });

  it("GET / returns HTML with cytoscape init and mode meta", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('id="cy"');
    expect(html).toContain("cytoscape(");
    expect(html).toMatch(/lotl-viewer-mode/);
  });

  it("GET /scopes returns global + project-foo", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/scopes`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.scopes).toEqual(["global", "project-foo"]);
  });

  it("GET /graph.json returns valid cytoscape shape", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/graph.json`);
    const json = await res.json();
    expect(Array.isArray(json.nodes)).toBe(true);
    expect(Array.isArray(json.edges)).toBe(true);
    for (const n of json.nodes) {
      expect(n.data).toMatchObject({
        id: expect.any(String),
        label: expect.any(String),
        memory_count: expect.any(Number),
      });
    }
    for (const e of json.edges) {
      expect(e.data).toMatchObject({
        id: expect.any(String),
        source: expect.any(String),
        target: expect.any(String),
        label: expect.any(String),
        active: expect.any(Boolean),
      });
    }
    expect(json.nodes.length).toBeGreaterThan(0);
  });

  it("GET /graph.json?scope=global excludes project-foo edge", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/graph.json?scope=global`);
    const json = await res.json();
    expect(json.edges.map((e: any) => e.data.id).sort()).toEqual(["e1", "e2"]);
  });

  it("GET /assets/viewer.js returns the viewer JS", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/assets/viewer.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/javascript/);
  });
});
```

- [ ] **Step 2: Run, expect PASS**

Run: `npx vitest run --reporter=verbose test/vault/integration/serve-live.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 3: Commit**

```bash
git add test/vault/integration/serve-live.test.ts
git commit -m "test(vault): live smoke — boot real server, hit every route"
```

---

### Task 16: Layout tuning iteration (patience phase: expect 30-60 min)

> **Vanguard note:** This is the patience phase. cose-bilkent defaults look OK for 5-20 nodes, crowded above 100. Manual visual iteration in a browser. Ugly first attempt is the entire point — that's why this is its own task. **Time-box at 60 minutes**; ship what you have at the cap, file a follow-up issue if still ugly. Do NOT skip this task hoping "the defaults will be fine" — they aren't.

**Files:**
- Modify: `assets/vault-viewer/viewer.js`

- [ ] **Step 1: Seed a realistic KG and boot**

Create `scripts/seed-viewer-test.mjs` (gitignored; do not commit):

```js
import Database from "better-sqlite3";
import { getDefaultDbPath } from "../dist/index.js";
const db = new Database(getDefaultDbPath());
const ins = db.prepare(`INSERT OR REPLACE INTO knowledge VALUES (?,?,?,?,?,?,?,?,?,?)`);
const entities = Array.from({length: 50}, (_, i) => `entity_${i}`);
const preds = ["uses", "depends_on", "owns", "contributes_to", "knows"];
for (let i = 0; i < 150; i++) {
  const s = entities[Math.floor(Math.random()*entities.length)];
  const o = entities[Math.floor(Math.random()*entities.length)];
  const p = preds[Math.floor(Math.random()*preds.length)];
  ins.run(`t${i}`, s, p, o, null, null, 1, `m${i}`, "global", Date.now());
}
```

Run: `node scripts/seed-viewer-test.mjs && node dist/cli/lotl.js vault serve`
Open `http://localhost:<port>` in a browser.

- [ ] **Step 2: Iterate on `LAYOUT` constants in `viewer.js`**

Tunables (cose-bilkent docs):
- `idealEdgeLength` — overlap fix: try 120, 150, 200.
- `edgeElasticity` — 0.1 stiff, 0.45 bouncy, 0.9 jelly.
- `gravity` — 0.05 loose clumps, 0.4 tight ball.
- `numIter` — 2500 fine for <500 nodes; bump for larger.

Try at least 3 combinations. Reload between each. Save screenshots to `devnotes/vault-viewer-layout-iterations/` (gitignored).

- [ ] **Step 3: Commit the chosen LAYOUT**

Add a comment above `const LAYOUT = {` in `viewer.js`:

```js
  // Tuned 2026-05-22 against 50-entity / 150-edge seed.
```

Run: `git add assets/vault-viewer/viewer.js && git commit -m "chore(vault-viewer): tune cose-bilkent layout for typical KG sizes"`

- [ ] **Step 4: Time-box check**

At 60 minutes: commit what you have, open issue `vault-viewer layout iteration needed beyond v1.2.0`, move on. Visual polish never blocks release.

---

### Task 17: Coverage verification

**Files:**
- (no edits — verification only)

- [ ] **Step 1: Run coverage**

Run: `npx vitest run --coverage --reporter=verbose test/vault/`
Expected: PASS, coverage table at the bottom shows 100% lines / functions / branches / statements on `src/vault/serve.ts`.

- [ ] **Step 2: If anything is below 100%, add a targeted test**

The likely gaps:

- The `EACCES` branch in `tryBind` — needs a test that tries to bind a privileged port (skip on non-Linux). Test by occupying-then-binding behavior was covered, but `EACCES` itself is hard to trigger. If coverage fails on that one line, switch the `if (err.code === "EADDRINUSE" || err.code === "EACCES")` collapse to just always-return-false and update the test that asserts errors are swallowed.

- The 500 branch (`catch` inside `makeHandler`) — covered by the "returns 500 when handler throws" test in Task 8. If not, add an explicit test that mocks `readFile` to throw with a thrown-after-headers scenario.

- The `try { res.writeHead(500) } catch { /* response already sent */ }` inner catch — also hard to cover. Acceptable mitigation: refactor to drop the inner try/catch and let any double-write blow up the test, since the outer test catches the 500 anyway.

If after one pass coverage is still <100%, simplify the code (delete the unreachable branch) rather than chase coverage with synthetic tests.

- [ ] **Step 3: Commit coverage tweaks (if any)**

```bash
git add src/vault/serve.ts test/vault/serve.test.ts
git commit -m "test(vault): close coverage gaps in serve.ts"
```

---

### Task 18: Documentation pass

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md` (optional — only if `## Commands` lists vault subcommands)

- [ ] **Step 1: Add to `CHANGELOG.md` under `## [Unreleased]`**

```markdown
### Added
- `lotl vault serve [--port N]` — HTTP viewer of the live knowledge graph at
  http://localhost:<port>. Default port scan: 7000-7999 (override via
  `LOTL_VAULT_PORT_RANGE`). Uses cytoscape + cose-bilkent via pinned CDN; set
  `LOTL_VAULT_VIEWER_OFFLINE=on` to serve locally bundled vendor JS instead.
- `GET /graph.json?scope=X[&current_only=1]` — live KG → cytoscape JSON.
- `GET /scopes` — JSON list of scopes for the dropdown filter.
- Empty-state UI when KG has no triples in the selected scope.
```

- [ ] **Step 2: Append to README "Commands" block (if it lists vault subcommands)**

```sh
lotl vault serve [--port N]                 # HTTP viewer over live KG.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs(vault): document vault serve command + env vars"
```

---

### Task 19: Final verification

**Files:**
- (no edits)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run --reporter=verbose test/`
Expected: all tests pass, no regressions in non-vault tests.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run coverage with the gate**

Run: `npx vitest run --coverage --reporter=verbose test/vault/`
Expected: PASS. Coverage report shows 100% on `src/vault/serve.ts`. The `assets/vault-viewer/**` files are absent from the report (excluded).

- [ ] **Step 4: Manual smoke**

Run:

```bash
npm run build
node dist/cli/lotl.js vault serve
```

Expected: stdout prints `vault serve ready — http://localhost:7000` (or first free port in range). Open in a browser. With an empty KG you see the empty-state. With a populated KG you see the force-directed graph.

Hit `Ctrl+C`. Expected: `[vault:serve] SIGINT received, shutting down` then clean exit.

- [ ] **Step 5: Tag the work as ready for v1.2.0**

This is the third and final subsystem. Per spec §Shipping order, this triggers the v1.2.0 stable release (separate process — use `/release 1.2.0`).

---

## Self-review

**1. Spec coverage**

| Spec requirement | Task |
|---|---|
| `lotl vault serve [--port N]` CLI | 14 |
| Port range scan 7000-7999 | 2, 3, 14 |
| `LOTL_VAULT_PORT_RANGE` env override | 3, 14 |
| Hard fail on range exhaustion | 2 (test 3) |
| `GET /` serves static SPA | 8 (test 2), 9, 13 |
| `GET /graph.json?scope=X` live KG → cytoscape | 4, 6, 8 |
| `GET /assets/*` static files | 7, 8 |
| `GET /scopes` for dropdown | 5, 8 |
| `current_only` toggle | 4, 8 |
| Cytoscape via CDN with SRI | 9 |
| `LOTL_VAULT_VIEWER_OFFLINE` escape hatch | 12, 13 |
| Empty-state UI when KG empty | 4 (test 1, 6), 8, 11 |
| Expired edges faded | 11 (STYLE block) |
| Node click → console log (future deep-link) | 11 |
| 100% coverage gate on `src/vault/serve.ts` | 1, 17, 19 |
| `assets/vault-viewer/**` excluded from coverage | 1 |
| Live smoke test boots OS-assigned port | 8 (test 1), 15 |
| Layout tuning patience phase | 16 |
| CHANGELOG entry | 18 |

No gaps.

**2. Placeholder scan**

- `PLACEHOLDER_CYTOSCAPE_330` / `PLACEHOLDER_COSE_BILKENT_410` in Task 9 are intentional and Task 9 step 1+3 contain the exact `curl` + `Edit` commands to resolve them. Not a placeholder failure — a deliberate two-step.
- No "TBD" / "TODO" / "fill in details" anywhere.
- No "Add appropriate error handling" / "handle edge cases" — every error path has concrete code.
- No "Write tests for the above" without the actual code — every test step shows the full test source.
- No "Similar to Task N" — repeated patterns repeat the code.
- Task 14 step 2 says "if missing, add" — that's conditional based on Subsystem 1's state, not a placeholder; the exact line to add is shown.

**3. Type consistency check**

- `findAvailablePort(range: PortRange)` — same signature in Tasks 2, 3, 8, 14. Consistent.
- `parsePortRange(spec: string): PortRange` — Tasks 3, 14. Consistent.
- `kgToCytoscape(entries, options?)` returns `CytoscapeGraph` with `empty_state?: true`. Used identically in Tasks 4, 8.
- `startVaultServer(opts).then(srv => srv.port, srv.stop)` — Tasks 8, 14, 15. Consistent.
- `listKnowledgeScopes(db) -> string[]` — Tasks 5, 8. Consistent.
- `fetchGraphEntries(db, scope?)` — Tasks 6, 8. Consistent.
- `resolveAssetPath(viewerDir, urlPath)` / `mimeFor(filename)` — Tasks 7, 8. Consistent.

No inconsistencies found. Plan ships.

---

## Execution Handoff

Plan complete and saved to `devnotes/architecture/plans/2026-05-22-vault-serve-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review between tasks. Sonnet on edit tasks; Haiku on verification tasks (1, 17, 19); Opus for Task 16 (layout tuning judgment).
2. **Inline Execution** — execute tasks in this session with checkpoints at Tasks 8, 13, 16, 19.

Recommend Subagent-Driven for this plan: Task 16 is a Vanguard patience-phase risk (impulse to declare done early), and a fresh subagent forced to time-box at 60min is the cleaner guardrail than self-policing.
