# OKF Progressive Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut lotl's first-token load by exposing docs + memory + knowledge as OKF concepts navigated via progressive disclosure (tiny index up front, bodies on demand), plus terse "caveman" memories.

**Architecture:** Approach A from the spec — an OKF projection layer over the existing SQLite stores. New `src/okf/` module holds a frozen `ConceptSource` interface; `SqliteConceptSource` implements it by reusing existing `memory/`, `knowledge.ts`, and `store` read functions. MCP tools, the CLI, and the recall hook talk only to that interface. SQLite stays the backend; on-disk OKF ("B") is deferred behind the seam.

**Tech Stack:** TypeScript (Node ≥22, ESM), better-sqlite3, Vitest. No new deps.

**Spec:** `docs/superpowers/specs/2026-07-19-okf-progressive-disclosure-design.md`

**Build model (per spec §10):** Opus owns this plan. Sonnet subagents build one Task at a time, TDD, against the frozen interfaces below. After each Task: `npm run typecheck` + the Task's tests must pass. **If a subagent is unsure or hits an ambiguity (a signature that differs from this plan, a schema surprise, a failing assumption), it STOPS and returns the question to Opus — it does not guess.**

**Conventions for every Task:**
- Paths are relative to the repo root `UsersDavidGillotProjectsqmd/`.
- Run a single test file: `npx vitest run --reporter=verbose test/<file>.test.ts`
- Typecheck: `npm run typecheck`
- Commit format: conventional commits, no attribution trailer (repo config disables it).
- Do NOT change existing tool/function signatures; add alongside.

---

## Frozen contract (read before any Task)

These types are defined in Task 1 and imported everywhere. Do not alter them without escalating.

```ts
// src/okf/concept.ts
export type ConceptKind = "docs" | "memory" | "entities";

/** Lightweight index line — NEVER carries a body. */
export interface ConceptRef {
  id: string;          // e.g. "memory/global/a1b2c3d4"
  type: string;        // e.g. "Fact", "Document", "Entity"
  title: string;       // short display name
  description: string; // one caveman line (may be "")
}

/** A navigable group in the bundle (a collection, a memory scope, or entities). */
export interface ConceptGroup {
  path: string;        // group id, e.g. "docs/notes" | "memory/global" | "entities"
  title: string;
  type: string;        // "Collection" | "Memory scope" | "Entities"
  count: number;
  description: string;
}

/** A full concept with body. */
export interface Concept extends ConceptRef {
  tags: string[];
  timestamp: string | null; // ISO 8601 or null
  links: string[];          // outbound concept ids
  body: string;
}
```

```ts
// src/okf/source.ts
export interface ConceptSource {
  listGroups(): ConceptGroup[];
  listConcepts(group: string, opts?: { limit?: number; offset?: number }): { refs: ConceptRef[]; total: number };
  getConcept(id: string): Concept | null;
}
```

---

## Task 1: Concept model + id scheme (`src/okf/concept.ts`)

**Files:**
- Create: `src/okf/concept.ts`
- Test: `test/okf-concept.test.ts`

Pure functions, no db. This is the frozen contract; get it exactly right.

- [ ] **Step 1: Write the failing test**

```ts
// test/okf-concept.test.ts
import { describe, test, expect } from "vitest";
import {
  buildDocId, buildMemoryId, buildEntityId,
  conceptKind, parseConceptId, memoryCategoryToType, capitalize,
} from "../src/okf/concept.js";

describe("okf concept ids", () => {
  test("builds ids per scheme", () => {
    expect(buildDocId("notes", "sub/readme.md")).toBe("docs/notes/sub/readme");
    expect(buildDocId("notes", "sub/readme")).toBe("docs/notes/sub/readme");
    expect(buildMemoryId("global", "a1b2c3d4e5f6")).toBe("memory/global/a1b2c3d4");
    expect(buildEntityId("Caroline Smith")).toBe("entities/caroline-smith");
  });

  test("routes kind by prefix", () => {
    expect(conceptKind("docs/notes/x")).toBe("docs");
    expect(conceptKind("memory/global/a1b2c3d4")).toBe("memory");
    expect(conceptKind("entities/caroline-smith")).toBe("entities");
    expect(() => conceptKind("bogus/x")).toThrow();
  });

  test("parses a memory id back to parts", () => {
    expect(parseConceptId("memory/global/a1b2c3d4")).toEqual({
      kind: "memory", group: "memory/global", rest: "a1b2c3d4",
    });
    expect(parseConceptId("docs/notes/sub/readme")).toEqual({
      kind: "docs", group: "docs/notes", rest: "sub/readme",
    });
  });

  test("maps memory category to OKF type", () => {
    expect(memoryCategoryToType("fact")).toBe("Fact");
    expect(memoryCategoryToType("decision")).toBe("Decision");
    expect(capitalize("preference")).toBe("Preference");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --reporter=verbose test/okf-concept.test.ts`
Expected: FAIL — cannot find module `../src/okf/concept.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/okf/concept.ts
export type ConceptKind = "docs" | "memory" | "entities";

export interface ConceptRef { id: string; type: string; title: string; description: string; }
export interface ConceptGroup { path: string; title: string; type: string; count: number; description: string; }
export interface Concept extends ConceptRef { tags: string[]; timestamp: string | null; links: string[]; body: string; }

const MEMORY_ID_LEN = 8;

export function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function memoryCategoryToType(category: string): string {
  return capitalize(category || "other");
}

/** Slug for entity ids. Mirrors knowledge.ts toSlug: lowercase, non-alnum → single hyphen, trim hyphens. */
export function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function buildDocId(collection: string, path: string): string {
  const p = path.replace(/\.md$/i, "");
  return `docs/${collection}/${p}`;
}

export function buildMemoryId(scope: string, memoryId: string): string {
  return `memory/${scope}/${memoryId.slice(0, MEMORY_ID_LEN)}`;
}

export function buildEntityId(subject: string): string {
  return `entities/${toSlug(subject)}`;
}

export function conceptKind(id: string): ConceptKind {
  const head = id.split("/", 1)[0];
  if (head === "docs" || head === "memory" || head === "entities") return head;
  throw new Error(`unknown concept id prefix: ${id}`);
}

export function parseConceptId(id: string): { kind: ConceptKind; group: string; rest: string } {
  const kind = conceptKind(id);
  const parts = id.split("/");
  if (kind === "entities") return { kind, group: "entities", rest: parts.slice(1).join("/") };
  // docs/<collection>/<rest...> or memory/<scope>/<rest>
  const group = `${parts[0]}/${parts[1]}`;
  const rest = parts.slice(2).join("/");
  return { kind, group, rest };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --reporter=verbose test/okf-concept.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/okf/concept.ts test/okf-concept.test.ts
git commit -m "feat(okf): concept model + id scheme (frozen contract)"
```

---

## Task 2: SqliteConceptSource (`src/okf/source.ts`)

**Files:**
- Create: `src/okf/source.ts`
- Test: `test/okf-source.test.ts`

Implements `ConceptSource` over `Store`. Reuses existing readers:
- Docs groups: `listCollections(db)` (from `src/store/context.js`) → `{ name, active_count }`.
- Memory scopes/rows: direct SQL on `memories` (columns: `id, text, category, scope, importance, tier, access_count, created_at, last_accessed, metadata`). **Explicit column list only — never `SELECT *`, never `fact_embedding`.**
- Entities: `knowledgeEntities(db)` + `knowledgeAbout(db, subject)` (from `src/memory/knowledge.js`).
- Doc bodies: `store.findDocument(path, { includeBody: true })` + `store.getDocumentBody`.

Take the `Store` (it exposes `.db` and the doc methods). Description for a memory ref = `metadata.description` if present (set by the caveman migration in Task 7), else the first non-empty line of `text` trimmed to 120 chars.

- [ ] **Step 1: Write the failing test**

```ts
// test/okf-source.test.ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { SqliteConceptSource } from "../src/okf/source.js";

// Minimal fake Store: only .db + the doc methods source.ts uses.
function fakeStore(db: any) {
  return { db, findDocument: () => ({ error: "not_found", query: "", similarFiles: [] }), getDocumentBody: () => null } as any;
}

describe("SqliteConceptSource", () => {
  let db: any, tmp: string;
  const insertMem = (id: string, text: string, category = "fact", scope = "global") =>
    db.prepare(`INSERT INTO memories (id,text,content_hash,category,scope,importance,tier,access_count,created_at,last_accessed)
                VALUES (?,?,?,?,?,?, 'peripheral',0,?,?)`).run(id, text, id, category, scope, 0.5, Date.now(), Date.now());

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lotl-okf-src-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
  });
  afterEach(() => { try { db.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); });

  test("lists memory scope groups with counts", () => {
    insertMem("a1b2c3d4aa", "alpha fact one", "fact", "global");
    insertMem("b2c3d4e5bb", "beta decision", "decision", "projX");
    const src = new SqliteConceptSource(fakeStore(db));
    const groups = src.listGroups();
    const mem = groups.filter(g => g.type === "Memory scope").map(g => g.path).sort();
    expect(mem).toEqual(["memory/global", "memory/projX"]);
    expect(groups.find(g => g.path === "memory/global")!.count).toBe(1);
  });

  test("lists concept refs for a memory scope without bodies", () => {
    insertMem("a1b2c3d4aa", "alpha fact one\nsecond line", "fact", "global");
    const src = new SqliteConceptSource(fakeStore(db));
    const { refs, total } = src.listConcepts("memory/global");
    expect(total).toBe(1);
    expect(refs[0]).toMatchObject({ id: "memory/global/a1b2c3d4", type: "Fact", description: "alpha fact one" });
    expect((refs[0] as any).body).toBeUndefined();
  });

  test("gets a memory concept with body, resolves 8-char id", () => {
    insertMem("a1b2c3d4aa", "alpha fact one", "fact", "global");
    const src = new SqliteConceptSource(fakeStore(db));
    const c = src.getConcept("memory/global/a1b2c3d4");
    expect(c?.body).toContain("alpha fact one");
    expect(c?.type).toBe("Fact");
    expect(src.getConcept("memory/global/zzzzzzzz")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --reporter=verbose test/okf-source.test.ts`
Expected: FAIL — cannot find module `../src/okf/source.js`.

- [ ] **Step 3: Write implementation**

```ts
// src/okf/source.ts
import type { Database } from "../db.js";
import { listCollections } from "../store/context.js";
import { knowledgeEntities, knowledgeAbout } from "../memory/knowledge.js";
import {
  buildMemoryId, buildEntityId, memoryCategoryToType, parseConceptId, conceptKind,
  type Concept, type ConceptRef, type ConceptGroup,
} from "./concept.js";

const DESC_MAX = 120;

type StoreLike = {
  db: Database;
  findDocument: (filename: string, options?: { includeBody?: boolean }) => any;
  getDocumentBody: (doc: any, fromLine?: number, maxLines?: number) => string | null;
};

type MemRow = { id: string; text: string; category: string; scope: string; metadata: string | null; last_accessed: number | null; created_at: number };

function firstLine(text: string): string {
  const line = (text || "").split("\n").map(s => s.trim()).find(Boolean) ?? "";
  return line.length > DESC_MAX ? line.slice(0, DESC_MAX - 1) + "…" : line;
}
function metaDescription(metadata: string | null): string | null {
  if (!metadata) return null;
  try { const m = JSON.parse(metadata); return typeof m?.description === "string" ? m.description : null; } catch { return null; }
}
function isoOrNull(ms: number | null): string | null { return ms ? new Date(ms).toISOString() : null; }
/** Extract [[id]] and markdown links from a body as outbound concept ids. */
function extractLinks(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) ids.add(m[1]!.trim());
  for (const m of body.matchAll(/\]\((\/[^)]+)\)/g)) ids.add(m[1]!.replace(/^\//, "").replace(/\.md$/i, ""));
  return [...ids];
}

export class SqliteConceptSource {
  constructor(private store: StoreLike) {}
  private get db(): Database { return this.store.db; }

  listGroups(): ConceptGroup[] {
    const groups: ConceptGroup[] = [];
    for (const c of listCollections(this.db)) {
      groups.push({ path: `docs/${c.name}`, title: c.name, type: "Collection", count: c.active_count, description: `${c.active_count} documents` });
    }
    const scopes = this.db.prepare(`SELECT scope, COUNT(*) AS c FROM memories GROUP BY scope ORDER BY scope`).all() as { scope: string; c: number }[];
    for (const s of scopes) {
      groups.push({ path: `memory/${s.scope}`, title: s.scope, type: "Memory scope", count: s.c, description: `${s.c} memories` });
    }
    const entities = knowledgeEntities(this.db);
    if (entities.length) groups.push({ path: "entities", title: "Entities", type: "Entities", count: entities.length, description: `${entities.length} entities` });
    return groups;
  }

  listConcepts(group: string, opts: { limit?: number; offset?: number } = {}): { refs: ConceptRef[]; total: number } {
    const limit = Math.min(opts.limit ?? 50, 500);
    const offset = opts.offset ?? 0;
    if (group.startsWith("memory/")) {
      const scope = group.slice("memory/".length);
      const total = (this.db.prepare(`SELECT COUNT(*) c FROM memories WHERE scope=?`).get(scope) as { c: number }).c;
      const rows = this.db.prepare(
        `SELECT id, text, category, scope, metadata, last_accessed, created_at FROM memories WHERE scope=? ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).all(scope, limit, offset) as MemRow[];
      const refs = rows.map(r => this.memRowToRef(r));
      return { refs, total };
    }
    if (group === "entities") {
      const all = knowledgeEntities(this.db);
      const page = all.slice(offset, offset + limit);
      const refs = page.map(subject => {
        const facts = knowledgeAbout(this.db, subject);
        const latest = facts[0];
        return { id: buildEntityId(subject), type: "Entity", title: subject, description: latest ? `${latest.predicate} ${latest.object}` : "" };
      });
      return { refs, total: all.length };
    }
    if (group.startsWith("docs/")) {
      const collection = group.slice("docs/".length);
      const total = (this.db.prepare(`SELECT COUNT(*) c FROM documents d JOIN collections co ON d.collection_id=co.id WHERE co.name=? AND d.active=1`).get(collection) as { c: number }).c;
      const rows = this.db.prepare(
        `SELECT d.path AS path, d.title AS title FROM documents d JOIN collections co ON d.collection_id=co.id WHERE co.name=? AND d.active=1 ORDER BY d.path LIMIT ? OFFSET ?`
      ).all(collection, limit, offset) as { path: string; title: string }[];
      const refs = rows.map(r => ({ id: `docs/${collection}/${r.path.replace(/\.md$/i, "")}`, type: "Document", title: r.title || r.path, description: "" }));
      return { refs, total };
    }
    return { refs: [], total: 0 };
  }

  getConcept(id: string): Concept | null {
    const kind = conceptKind(id);
    if (kind === "memory") {
      const { group, rest } = parseConceptId(id);
      const scope = group.slice("memory/".length);
      const rows = this.db.prepare(
        `SELECT id, text, category, scope, metadata, last_accessed, created_at FROM memories WHERE scope=? AND substr(id,1,8)=?`
      ).all(scope, rest) as MemRow[];
      if (rows.length !== 1) return null; // 0 = not found; >1 = ambiguous → escalate to Opus if this ever happens
      const r = rows[0]!;
      const ref = this.memRowToRef(r);
      return { ...ref, tags: [], timestamp: isoOrNull(r.last_accessed ?? r.created_at), links: extractLinks(r.text), body: r.text };
    }
    if (kind === "entities") {
      const { rest } = parseConceptId(id);
      const subject = knowledgeEntities(this.db).find(s => buildEntityId(s) === id);
      if (!subject) return null;
      const facts = knowledgeAbout(this.db, subject);
      const body = facts.map(f => `- ${f.predicate} ${f.object}`).join("\n");
      return { id, type: "Entity", title: subject, description: facts[0] ? `${facts[0].predicate} ${facts[0].object}` : "",
               tags: [], timestamp: null, links: [], body };
    }
    // docs
    const { group, rest } = parseConceptId(id);
    const collection = group.slice("docs/".length);
    const doc = this.store.findDocument(`${collection}/${rest}.md`, { includeBody: true });
    if (!doc || (doc as any).error) return null;
    const body = (doc as any).body ?? this.store.getDocumentBody(doc, undefined, undefined) ?? "";
    return { id, type: "Document", title: (doc as any).title || rest, description: (doc as any).context ?? "",
             tags: [], timestamp: (doc as any).modifiedAt ?? null, links: extractLinks(body), body };
  }

  private memRowToRef(r: MemRow): ConceptRef {
    return { id: buildMemoryId(r.scope, r.id), type: memoryCategoryToType(r.category),
             title: firstLine(r.text).slice(0, 60), description: metaDescription(r.metadata) ?? firstLine(r.text) };
  }
}
```

> **Escalation note for the builder:** the docs SQL above assumes tables `documents(path,title,active,collection_id)` and `collections(id,name)`. If `initializeDatabase` uses different column/table names, STOP and return the real schema to Opus rather than guessing — the docs branch is the only place this plan touches doc-table columns directly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --reporter=verbose test/okf-source.test.ts`
Expected: PASS (3 tests). (The memory + entity paths must pass; if the docs-schema assumption is wrong the memory/entity tests still pass and you escalate on docs.)

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/okf/source.ts test/okf-source.test.ts
git commit -m "feat(okf): SqliteConceptSource over memory/knowledge/docs"
```

---

## Task 3: index.md rendering (`src/okf/index-render.ts`)

**Files:**
- Create: `src/okf/index-render.ts`
- Test: `test/okf-index-render.test.ts`

Pure. OKF §6 format: `* [Title](id) — description`, grouped under `#` headings.

- [ ] **Step 1: Write the failing test**

```ts
// test/okf-index-render.test.ts
import { describe, test, expect } from "vitest";
import { renderGroups, renderRefs } from "../src/okf/index-render.js";

describe("okf index render", () => {
  test("renders groups grouped by type", () => {
    const out = renderGroups([
      { path: "docs/notes", title: "notes", type: "Collection", count: 3, description: "3 documents" },
      { path: "memory/global", title: "global", type: "Memory scope", count: 5, description: "5 memories" },
    ]);
    expect(out).toContain("# Collection");
    expect(out).toContain("* [notes](docs/notes) — 3 documents");
    expect(out).toContain("# Memory scope");
    expect(out).toContain("* [global](memory/global) — 5 memories");
  });

  test("renders refs as a flat list", () => {
    const out = renderRefs([{ id: "memory/global/a1b2c3d4", type: "Fact", title: "alpha", description: "alpha fact one" }]);
    expect(out).toBe("* [alpha](memory/global/a1b2c3d4) — alpha fact one");
  });

  test("omits the em-dash when description is empty", () => {
    const out = renderRefs([{ id: "docs/notes/x", type: "Document", title: "X", description: "" }]);
    expect(out).toBe("* [X](docs/notes/x)");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --reporter=verbose test/okf-index-render.test.ts` → FAIL (missing module).

- [ ] **Step 3: Implement**

```ts
// src/okf/index-render.ts
import type { ConceptGroup, ConceptRef } from "./concept.js";

function line(id: string, title: string, description: string): string {
  return description ? `* [${title}](${id}) — ${description}` : `* [${title}](${id})`;
}

export function renderRefs(refs: ConceptRef[]): string {
  return refs.map(r => line(r.id, r.title, r.description)).join("\n");
}

export function renderGroups(groups: ConceptGroup[]): string {
  const byType = new Map<string, ConceptGroup[]>();
  for (const g of groups) { (byType.get(g.type) ?? byType.set(g.type, []).get(g.type)!).push(g); }
  const sections: string[] = [];
  for (const [type, gs] of byType) {
    sections.push(`# ${type}\n\n` + gs.map(g => line(g.path, g.title, g.description)).join("\n"));
  }
  return sections.join("\n\n");
}
```

- [ ] **Step 4: Run** the test → PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/okf/index-render.ts test/okf-index-render.test.ts
git commit -m "feat(okf): index.md rendering"
```

---

## Task 4: recall (`src/okf/recall.ts`)

**Files:**
- Create: `src/okf/recall.ts`
- Test: `test/okf-recall.test.ts`

`okfRecall` returns `ConceptRef[]` (NO bodies), hard-capped by count and total bytes. Memory matches via `memoryRecall` (already imported db-based). Docs matches via `store.searchFTS`. Combine, cap.

Signature:
```ts
export async function okfRecall(store: StoreLike, query: string, opts?: { limit?: number; maxBytes?: number }): Promise<ConceptRef[]>
```
where `StoreLike = { db: Database; searchFTS: (q: string, limit?: number) => any[] }`. Defaults: `limit = 8`, `maxBytes = 2000`.

- [ ] **Step 1: Write the failing test**

```ts
// test/okf-recall.test.ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { okfRecall } from "../src/okf/recall.js";

describe("okfRecall", () => {
  let db: any, tmp: string;
  const store = () => ({ db, searchFTS: () => [] });
  const insertMem = (id: string, text: string) =>
    db.prepare(`INSERT INTO memories (id,text,content_hash,category,scope,importance,tier,access_count,created_at,last_accessed)
                VALUES (?,?,?, 'fact','global',0.5,'peripheral',0,?,?)`).run(id, text, id, Date.now(), Date.now());
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "lotl-okf-recall-")); db = openDatabase(join(tmp, "t.sqlite")); initializeDatabase(db); });
  afterEach(() => { try { db.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); });

  test("returns index refs, never bodies, capped", async () => {
    for (let i = 0; i < 20; i++) insertMem(`id${i}pad0000`, `widget fact number ${i}`);
    const refs = await okfRecall(store(), "widget", { limit: 5 });
    expect(refs.length).toBeLessThanOrEqual(5);
    for (const r of refs) {
      expect(r.id.startsWith("memory/global/")).toBe(true);
      expect((r as any).body).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run** → FAIL (missing module).

- [ ] **Step 3: Implement**

```ts
// src/okf/recall.ts
import type { Database } from "../db.js";
import { memoryRecall } from "../memory/index.js";
import { buildMemoryId, type ConceptRef } from "./concept.js";
import { capitalize } from "./concept.js";

type StoreLike = { db: Database; searchFTS: (q: string, limit?: number) => Array<{ displayPath?: string; title?: string; collectionName?: string }> };

const DESC_MAX = 120;
function firstLine(text: string): string {
  const l = (text || "").split("\n").map(s => s.trim()).find(Boolean) ?? "";
  return l.length > DESC_MAX ? l.slice(0, DESC_MAX - 1) + "…" : l;
}

export async function okfRecall(store: StoreLike, query: string, opts: { limit?: number; maxBytes?: number } = {}): Promise<ConceptRef[]> {
  const limit = opts.limit ?? 8;
  const maxBytes = opts.maxBytes ?? 2000;
  const refs: ConceptRef[] = [];

  const mem = await memoryRecall(store.db, { query, limit });
  for (const m of mem) {
    refs.push({ id: buildMemoryId(m.scope, m.id), type: capitalize(m.category), title: firstLine(m.text).slice(0, 60), description: firstLine(m.text) });
  }
  try {
    for (const d of store.searchFTS(query, limit)) {
      const path = (d.displayPath ?? "").replace(/\.md$/i, "");
      refs.push({ id: `docs/${d.collectionName ?? ""}/${path}`, type: "Document", title: d.title ?? path, description: "" });
    }
  } catch { /* fail-open: docs FTS optional */ }

  // Cap by count, then by cumulative bytes.
  const capped: ConceptRef[] = [];
  let bytes = 0;
  for (const r of refs.slice(0, limit)) {
    const size = Buffer.byteLength(`${r.title}${r.description}${r.id}`);
    if (bytes + size > maxBytes && capped.length) break;
    bytes += size; capped.push(r);
  }
  return capped;
}
```

> **Escalation note:** `memoryRecall(db, { query, limit })` is assumed to return `MemoryRecallResult[]` with `{ id, text, category, scope }` (confirmed in the skeleton). If it requires extra options or a warm embedder for FTS-only recall, STOP and return the real call shape.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/okf/recall.ts test/okf-recall.test.ts
git commit -m "feat(okf): query recall returns index refs, byte-capped"
```

---

## Task 5: caveman budget + compact helper (`src/okf/budget.ts`)

**Files:**
- Create: `src/okf/budget.ts`
- Test: `test/okf-budget.test.ts`

Constants + a deterministic heuristic compactor (LLM path is optional and injected, so tests stay deterministic).

Interface:
```ts
export const DESCRIPTION_MAX = 120;
export const BODY_MAX = 500;
export function isOverBudget(text: string): boolean;
/** Deterministic fallback: description = first line (≤120), body = first ~6 non-empty lines (≤500). */
export function heuristicCompact(text: string): { description: string; body: string };
/** LLM compaction when a chatComplete fn is provided; falls back to heuristic on any error. */
export async function compactMemoryText(
  text: string,
  chat?: (prompt: string) => Promise<string>,
): Promise<{ description: string; body: string; lowConfidence: boolean }>;
```

- [ ] **Step 1: Write the failing test**

```ts
// test/okf-budget.test.ts
import { describe, test, expect } from "vitest";
import { isOverBudget, heuristicCompact, compactMemoryText, BODY_MAX } from "../src/okf/budget.js";

describe("caveman budget", () => {
  test("flags over-budget text", () => {
    expect(isOverBudget("short")).toBe(false);
    expect(isOverBudget("x".repeat(BODY_MAX + 1))).toBe(true);
  });
  test("heuristic keeps first line as description and trims body", () => {
    const text = "first line fact\n" + "extra ".repeat(400);
    const { description, body } = heuristicCompact(text);
    expect(description).toBe("first line fact");
    expect(body.length).toBeLessThanOrEqual(BODY_MAX);
  });
  test("compact falls back to heuristic when chat throws", async () => {
    const r = await compactMemoryText("aaaa\nbbbb", async () => { throw new Error("no llm"); });
    expect(r.description).toBe("aaaa");
    expect(r.lowConfidence).toBe(true);
  });
  test("compact uses chat JSON when provided", async () => {
    const r = await compactMemoryText("long text here", async () =>
      JSON.stringify({ description: "d", body: "b" }));
    expect(r).toMatchObject({ description: "d", body: "b", lowConfidence: false });
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/okf/budget.ts
export const DESCRIPTION_MAX = 120;
export const BODY_MAX = 500;

export function isOverBudget(text: string): boolean {
  return (text?.length ?? 0) > BODY_MAX;
}

export function heuristicCompact(text: string): { description: string; body: string } {
  const lines = (text || "").split("\n").map(s => s.trim()).filter(Boolean);
  const description = (lines[0] ?? "").slice(0, DESCRIPTION_MAX);
  let body = lines.slice(0, 6).join("\n");
  if (body.length > BODY_MAX) body = body.slice(0, BODY_MAX - 1) + "…";
  return { description, body };
}

const PROMPT = (text: string) =>
`Compress this memory to a terse "caveman" fact. Keep every load-bearing specific (ids, file:line, decisions, the one gotcha, [[links]]). Cut narrative and session play-by-play.
Return ONLY JSON: {"description": "<one line, <=${DESCRIPTION_MAX} chars>", "body": "<<=${BODY_MAX} chars>"}
MEMORY:
${text}`;

export async function compactMemoryText(
  text: string,
  chat?: (prompt: string) => Promise<string>,
): Promise<{ description: string; body: string; lowConfidence: boolean }> {
  if (!chat) return { ...heuristicCompact(text), lowConfidence: true };
  try {
    const raw = await chat(PROMPT(text));
    const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const description = String(json.description ?? "").slice(0, DESCRIPTION_MAX);
    const body = String(json.body ?? "").slice(0, BODY_MAX);
    const lowConfidence = !description || !body || body.length >= BODY_MAX;
    return { description, body, lowConfidence };
  } catch {
    return { ...heuristicCompact(text), lowConfidence: true };
  }
}
```

- [ ] **Step 4: Run** → PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/okf/budget.ts test/okf-budget.test.ts
git commit -m "feat(okf): caveman budget + compact helper"
```

---

## Task 6: write-time budget enforcement (`src/memory/index.ts`)

**Files:**
- Modify: `src/memory/index.ts` (inside `memoryStore`, before content-hash/embedding)
- Test: `test/okf-write-budget.test.ts`

When incoming memory `text` is over budget, auto-compact it (heuristic path in tests; wire the real `chatComplete` only if the store's `llm` is present) and store `metadata.description` = the caveman one-liner. Gate behind `LOTL_OKF !== "off"` so it can be disabled.

> **Escalation note:** locate the point in `memoryStore` where `text` is finalized (after `turnsToText`, before `contentHash`). If the function shape differs from the skeleton, STOP and return the surrounding 15 lines to Opus.

- [ ] **Step 1: Write the failing test**

```ts
// test/okf-write-budget.test.ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { memoryStore } from "../src/memory/index.js";

describe("write-time budget", () => {
  let db: any, tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "lotl-okf-wb-")); db = openDatabase(join(tmp, "t.sqlite")); initializeDatabase(db); });
  afterEach(() => { try { db.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); });

  test("over-budget memory is stored compacted with a description", async () => {
    const big = "headline fact\n" + "filler ".repeat(400);
    const res = await memoryStore(db, { text: big, category: "fact", scope: "global" });
    const row = db.prepare(`SELECT text, metadata FROM memories WHERE id=?`).get((res as any).id) as any;
    expect(row.text.length).toBeLessThanOrEqual(500);
    expect(JSON.parse(row.metadata).description).toBe("headline fact");
  });
});
```

- [ ] **Step 2: Run** → FAIL (text stored full-length).

- [ ] **Step 3: Implement** — inside `memoryStore`, after `text` is finalized:

```ts
import { isOverBudget, compactMemoryText } from "../okf/budget.js";
// ...
if (process.env.LOTL_OKF !== "off" && isOverBudget(text)) {
  const { description, body } = await compactMemoryText(text /*, optional chat fn */);
  text = body || text.slice(0, 500);
  metadata = { ...(metadata ?? {}), description };
}
```

(Use the existing local variable names for `text` and `metadata`; if `metadata` is not yet an object at that point, adapt to however the function accumulates metadata — escalate if unclear.)

- [ ] **Step 4: Run** → PASS. Then run the existing memory suite to ensure no regression: `npx vitest run --reporter=verbose test/` (memory tests must stay green).

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/memory/index.ts test/okf-write-budget.test.ts
git commit -m "feat(memory): enforce caveman budget on write"
```

---

## Task 7: migration `lotl memory compact` (`src/memory/compact.ts` + CLI)

**Files:**
- Create: `src/memory/compact.ts`
- Modify: `src/cli/lotl.ts` (memory subcommand dispatch — add `compact`)
- Test: `test/okf-compact-migration.test.ts`

`compactAllMemories(db, { apply, chat })`:
- Finds memories where `length(text) > BODY_MAX` AND `metadata.original` is NOT already set.
- For each: `compactMemoryText`. If `lowConfidence`, push to a review list and DO NOT apply unless `--force`.
- On apply: `memoryUpdate(db, { id, text: body, metadata: { ...existing, original: <old text>, description } })`.
- Returns `{ scanned, compacted, review: string[] }`. Dry-run returns the same counts with `compacted=0` and before/after previews.

- [ ] **Step 1: Write the failing test**

```ts
// test/okf-compact-migration.test.ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { compactAllMemories } from "../src/memory/compact.js";

describe("memory compact migration", () => {
  let db: any, tmp: string;
  const bigInsert = (id: string) => db.prepare(
    `INSERT INTO memories (id,text,content_hash,category,scope,importance,tier,access_count,created_at,last_accessed)
     VALUES (?,?,?, 'fact','global',0.5,'peripheral',0,?,?)`
  ).run(id, "headline\n" + "x".repeat(2000), id, Date.now(), Date.now());
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "lotl-okf-mig-")); db = openDatabase(join(tmp, "t.sqlite")); initializeDatabase(db); });
  afterEach(() => { try { db.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); });

  test("dry-run changes nothing", async () => {
    bigInsert("m1aaaaaaaa");
    const r = await compactAllMemories(db, { apply: false, chat: async () => JSON.stringify({ description: "headline", body: "headline" }) });
    expect(r.scanned).toBe(1);
    expect(r.compacted).toBe(0);
    expect((db.prepare(`SELECT text FROM memories WHERE id='m1aaaaaaaa'`).get() as any).text.length).toBeGreaterThan(1000);
  });

  test("apply compacts and archives original", async () => {
    bigInsert("m1aaaaaaaa");
    const r = await compactAllMemories(db, { apply: true, chat: async () => JSON.stringify({ description: "headline", body: "headline" }) });
    expect(r.compacted).toBe(1);
    const row = db.prepare(`SELECT text, metadata FROM memories WHERE id='m1aaaaaaaa'`).get() as any;
    expect(row.text).toBe("headline");
    expect(JSON.parse(row.metadata).original).toContain("x".repeat(100));
  });
});
```

- [ ] **Step 2: Run** → FAIL (missing module).

- [ ] **Step 3: Implement `src/memory/compact.ts`**

```ts
// src/memory/compact.ts
import type { Database } from "../db.js";
import { memoryUpdate } from "./index.js";
import { compactMemoryText, BODY_MAX } from "../okf/budget.js";

type Row = { id: string; text: string; metadata: string | null };
export interface CompactResult { scanned: number; compacted: number; review: string[]; }

export async function compactAllMemories(
  db: Database,
  opts: { apply: boolean; force?: boolean; chat?: (p: string) => Promise<string> },
): Promise<CompactResult> {
  const rows = db.prepare(`SELECT id, text, metadata FROM memories WHERE length(text) > ?`).all(BODY_MAX) as Row[];
  const result: CompactResult = { scanned: 0, compacted: 0, review: [] };
  for (const r of rows) {
    let meta: Record<string, unknown> = {};
    try { meta = r.metadata ? JSON.parse(r.metadata) : {}; } catch { meta = {}; }
    if (meta.original) continue; // already migrated
    result.scanned++;
    const { description, body, lowConfidence } = await compactMemoryText(r.text, opts.chat);
    if (lowConfidence && !opts.force) { result.review.push(r.id); continue; }
    if (!opts.apply) continue;
    await memoryUpdate(db, { id: r.id, text: body, metadata: { ...meta, original: r.text, description } });
    result.compacted++;
  }
  return result;
}
```

- [ ] **Step 4: Run** → PASS (2 tests).

- [ ] **Step 5: Wire the CLI** — in `src/cli/lotl.ts`, in the `memory` subcommand dispatch (the same `else if (subCmd === ...)` chain that already handles `serve`, `export`, etc.), add:

```ts
} else if (subCmd === "compact") {
  const apply = cli.values.apply === true;
  const force = cli.values.force === true;
  const { compactAllMemories } = await import("../memory/compact.js");
  const r = await compactAllMemories(db, { apply, force /*, chat: store.llm?.chatComplete bound */ });
  console.log(`Scanned ${r.scanned} over-budget memories; ${apply ? "compacted" : "would compact"} ${apply ? r.compacted : r.scanned - r.review.length}.`);
  if (r.review.length) console.log(`Review (low-confidence, not applied): ${r.review.join(", ")}`);
  if (!apply) console.log("Dry-run. Re-run with --apply to write (originals archived in metadata.original).");
  closeDb();
```

Add `apply` and `force` as boolean options in the `parseCLI` options block (next to the existing `host`/`token` from the memory-serve change). Verify with: `npx tsx src/cli/lotl.ts memory compact` prints the dry-run summary.

> **Escalation note:** binding the real LLM (`store.llm?.chatComplete`) into `chat` requires the exact `chatComplete` signature from `src/llm.ts` (not captured in this plan). Wire the heuristic path first (no `chat`), confirm tests pass, then ask Opus for the `chatComplete` binding before enabling LLM compaction.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add src/memory/compact.ts src/cli/lotl.ts test/okf-compact-migration.test.ts
git commit -m "feat(memory): lotl memory compact migration (dry-run, archive, review queue)"
```

---

## Task 8: MCP tools `okf_index` / `okf_get` / `okf_recall` (`src/mcp/server.ts`)

**Files:**
- Modify: `src/mcp/server.ts` — register 3 tools inside `createMcpServer`; update `buildStaticInstructions()`.

Follow the existing `server.registerTool(...)`/`server.tool(...)` pattern used by the neighboring `doc_search`/`memory_search` registrations in `createMcpServer`. Build a `SqliteConceptSource` from the store once, near the top of `createMcpServer`.

- `okf_index({ group?: string, limit?, offset? })` → if no `group`: `renderGroups(source.listGroups())`; else `renderRefs(source.listConcepts(group, {limit,offset}).refs)` plus a `total`/pagination footer.
- `okf_get({ id })` → `source.getConcept(id)`; return frontmatter + body as text, or a not-found message.
- `okf_recall({ query, limit? })` → `renderRefs(await okfRecall(store, query, { limit }))`.

Update `buildStaticInstructions()` to replace any memory-dump guidance with: "Knowledge is OKF concepts. Call `okf_index` for the root groups, `okf_index({group})` to drill in, `okf_get({id})` to open one. Do not expect memories pre-loaded."

- [ ] **Step 1: Write the failing test**

```ts
// test/okf-mcp.test.ts — smoke test the tool handlers via a thin harness if createMcpServer exposes them;
// otherwise assert buildStaticInstructions mentions okf_index.
import { describe, test, expect } from "vitest";
import { buildStaticInstructions } from "../src/mcp/server.js";

describe("okf mcp wiring", () => {
  test("static instructions point at okf_index", () => {
    expect(buildStaticInstructions()).toMatch(/okf_index/);
  });
});
```

> **Escalation note:** if `buildStaticInstructions` is not exported, either export it or, if the maintainer pattern forbids that, STOP and ask Opus how tool handlers are tested in this repo (check whether `createMcpServer` returns a testable registry). Do not invent a test harness.

- [ ] **Step 2: Run** → FAIL (no `okf_index` in instructions).

- [ ] **Step 3: Implement** the 3 `registerTool` calls + the `buildStaticInstructions` edit, following the existing registrations verbatim in style (same result-shaping helpers, same error handling). Import `SqliteConceptSource`, `renderGroups`, `renderRefs`, `okfRecall`.

- [ ] **Step 4: Run** → PASS. Also run the existing MCP test file if present: `npx vitest run --reporter=verbose test/` (all green).

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/mcp/server.ts test/okf-mcp.test.ts
git commit -m "feat(mcp): okf_index/okf_get/okf_recall + okf-first static instructions"
```

---

## Task 9: CLI `okf` subcommand (`src/cli/lotl.ts`)

**Files:**
- Modify: `src/cli/lotl.ts` — add top-level `okf` command with `index|get|recall` sub-subcommands, mirroring the memory dispatch style.

- `lotl okf index [group]` → prints `renderGroups`/`renderRefs`.
- `lotl okf get <id>` → prints the concept (frontmatter + body).
- `lotl okf recall <query>` → prints `renderRefs`.

- [ ] **Step 1** Add the dispatch block (build a `Store`, wrap in `SqliteConceptSource`). Follow the existing command routing in `parseCLI`/main.
- [ ] **Step 2** Manual verify:
  - `npx tsx src/cli/lotl.ts okf index` → prints group headings.
  - `npx tsx src/cli/lotl.ts okf recall "test"` → prints refs (or nothing).
- [ ] **Step 3: Commit**

```bash
npm run typecheck
git add src/cli/lotl.ts
git commit -m "feat(cli): lotl okf index|get|recall"
```

---

## Task 10: recall-hook rewrite (`hooks/lotl_recall_hook.sh`)

**Files:**
- Modify: `hooks/lotl_recall_hook.sh`

Replace the `memory recall` call with `okf recall`, gated by `LOTL_OKF`. Keep fail-open.

- [ ] **Step 1** Change line 47-48 region from `"$LOTL_BIN" memory recall "$PROMPT"` to:

```sh
if [ "${LOTL_OKF:-on}" = "off" ]; then
  RESULTS="$(LOTL_ONNX=off LOTL_MEMORY_RERANK=off timeout "$RECALL_TIMEOUT" "$LOTL_BIN" memory recall "$PROMPT" 2>/dev/null | head -n "$MAX_LINES")" || emit_nothing
else
  RESULTS="$(LOTL_ONNX=off timeout "$RECALL_TIMEOUT" "$LOTL_BIN" okf recall "$PROMPT" 2>/dev/null | head -n "$MAX_LINES")" || emit_nothing
fi
```

Update the injected-context header string from "Relevant memories from lotl (recalled automatically):" to "Relevant lotl concepts (open with okf_get):".

- [ ] **Step 2** Manual verify: `echo '{"prompt":"widget test prompt"}' | bash hooks/lotl_recall_hook.sh` emits either `{}` or a compact index (no multi-KB blobs).
- [ ] **Step 3: Commit**

```bash
git add hooks/lotl_recall_hook.sh
git commit -m "feat(hooks): recall hook injects okf index lines, not memory bodies"
```

---

## Task 11: session-start (`src/openclaw/plugin.ts`)

**Files:**
- Modify: `src/openclaw/plugin.ts` — the `before_prompt_build` hook.

Emit `okf_index()` root (via `renderGroups`) as session-start context instead of any memory dump, gated by `LOTL_OKF`.

- [ ] **Step 1** Locate the `before_prompt_build` handler; where it currently injects memory context, swap to a `SqliteConceptSource(store).listGroups()` → `renderGroups(...)` block, capped to a small byte budget.
- [ ] **Step 2** Add/adjust the plugin's test if one exists; otherwise a smoke assert that the injected string contains `# Collection` or `# Memory scope` when data exists.

> **Escalation note:** the plugin's store/hook wiring is framework-specific. Read the existing `before_prompt_build` body first; if the injection mechanism is unclear, STOP and return it to Opus.

- [ ] **Step 3: Commit**

```bash
npm run typecheck
git add src/openclaw/plugin.ts
git commit -m "feat(openclaw): emit okf root index at session start"
```

---

## Task 12: docs + changelog

**Files:**
- Modify: `CLAUDE.md` (Commands + MCP Tools sections), `CHANGELOG.md` (`## [Unreleased]` → `### Added`).

- [ ] **Step 1** Add to CLAUDE.md Commands: `lotl okf index|get|recall`, `lotl memory compact [--apply]`. Add to MCP Tools: `okf_index`, `okf_get`, `okf_recall`.
- [ ] **Step 2** Add a CHANGELOG entry summarizing OKF progressive disclosure + caveman memories + `LOTL_OKF` flag.
- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: OKF progressive disclosure + caveman memories"
```

---

## Final verification (after all tasks)

- [ ] `npm run typecheck` clean.
- [ ] `npx vitest run --reporter=verbose test/` — all green (new okf-*.test.ts + existing suite).
- [ ] `npm run build` succeeds (dist regenerates).
- [ ] Manual: `echo '{"prompt":"a real question"}' | bash hooks/lotl_recall_hook.sh` → compact index, not blobs.
- [ ] Manual: `LOTL_OKF=on npx tsx src/cli/lotl.ts okf index` → root groups.

## Rollback

Every change is additive or flag-gated (`LOTL_OKF=off` restores the old recall path; migration originals live in `metadata.original`; old MCP tools remain). Revert by commit if needed.
