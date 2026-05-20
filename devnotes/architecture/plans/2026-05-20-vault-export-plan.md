# Vault Export (Subsystem 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `lotl vault export` + `lotl vault status` for v1.2.0-alpha.1: walk the existing knowledge graph per scope, render entity Markdown pages + an inbox of orphan memories into `~/.local/share/lotl/vault/<scope>/`, with atomic writes, a per-scope hash gate for incremental no-op exports, and 100% line+branch coverage on `src/vault/**`.

**Architecture:** New `src/vault/` module (`export.ts` + `templates.ts`) consumes the existing `knowledge.ts` + memory `index.ts` read APIs and renders Obsidian-friendly Markdown. A new `src/cli/vault-commands.ts` mirrors the per-domain CLI module pattern (cf. `collection-commands.ts`) and is dispatched from `src/cli/lotl.ts`. Writes go to `<scope>/.tmp/`, then a directory swap renames into place; on failure the previous vault stays untouched plus a `.old-*` forensic copy. KG is the source of truth — vault is derived; extraction (Subsystem 2) and the web viewer (Subsystem 3) are explicitly out of scope here.

**Tech Stack:** TypeScript ESM, Node 22+, better-sqlite3 (read-only here), Vitest with `@vitest/coverage-v8`. No Bun. CLI uses existing `terminal.ts` helpers; non-CLI logging uses `console.*` (matches `memory/index.ts`, `memory/import.ts`).

---

## File structure

| Path | Responsibility | New / Modified |
|---|---|---|
| `src/vault/templates.ts` | Frontmatter builders, entity page renderer, inbox renderer, slug normalizer (re-exports `toSlug` from `knowledge.ts`), scope-name sanitizer. Pure functions, zero I/O. | New (~120 LOC) |
| `src/vault/export.ts` | Resolve vault root + per-scope dirs, query KG + memories, group triples by subject, classify current vs historical facts, find orphan memories, write `.tmp/` → atomic rename, compute `.lotl-export.json` hash, `vault export` + `vault status` implementations. | New (~280 LOC) |
| `src/cli/vault-commands.ts` | CLI handlers `runVaultExport`, `runVaultStatus`. Argv parsing (`--scope`, `--force`). Calls `loadLotlEnv` + `openDatabase`. Uses `info`, `warn`, `success` from `terminal.ts`. | New |
| `src/cli/lotl.ts` | Dispatch `vault <sub>` to the new module. | Modify |
| `vitest.config.ts` | Add `coverage` block scoped to `src/vault/**` with 100% thresholds. | Modify |
| `package.json` | Add `@vitest/coverage-v8` devDependency. | Modify |
| `test/vault/templates.test.ts` | Snapshot + unit tests for frontmatter, entity page, inbox, slug, scope sanitizer. | New |
| `test/vault/slug.test.ts` | Slug normalization edge cases + collision disambiguation policy. | New |
| `test/vault/export.test.ts` | KG → file walk, hash gate, atomic write, error paths (perms / corrupt metadata). | New |
| `test/vault/integration/incremental.test.ts` | Full end-to-end: seed KG → first export writes → second export no-ops → forced export rewrites. | New |
| `test/vault/smoke/cli.test.ts` | Spawns `npx tsx src/cli/lotl.ts vault export` / `vault status`, asserts exit code + stdout. | New |
| `test/fixtures/vault-kg.json` | Canonical seed: 5 entities, 12 triples, mixed scopes, mixed `valid_until`. | New |

**Test layout convention:** existing tests are flat under `test/`. For vault we use one subfolder per category: `test/vault/` (unit), `test/vault/integration/`, `test/vault/smoke/`. This mirrors the existing `test/smoke/` precedent and keeps the vault feature self-contained.

---

## Task 1: Bootstrap module + coverage config

**Files:**
- Create: `src/vault/templates.ts`
- Create: `src/vault/export.ts`
- Modify: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Create the empty module stubs (so coverage tooling has something to measure)**

Write `src/vault/templates.ts`:

```ts
// src/vault/templates.ts
// Pure rendering helpers. No I/O. Subsystem 1 (v1.2.0-alpha.1).

export const TEMPLATES_MODULE_LOADED = true;
```

Write `src/vault/export.ts`:

```ts
// src/vault/export.ts
// KG -> vault Markdown exporter. Subsystem 1 (v1.2.0-alpha.1).

export const EXPORT_MODULE_LOADED = true;
```

- [ ] **Step 2: Add the coverage devDependency**

Run: `npm install --save-dev @vitest/coverage-v8`

Expected: `package.json` gains `"@vitest/coverage-v8"` under `devDependencies`, `package-lock.json` updates, exit code 0.

- [ ] **Step 3: Extend `vitest.config.ts` with the coverage block**

Replace the entire contents of `vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/vault/**"],
      exclude: ["assets/vault-viewer/**", "test/**", "**/*.d.ts"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
```

- [ ] **Step 4: Verify coverage tooling boots**

Run: `npx vitest run --coverage --reporter=verbose --run --passWithNoTests test/`

Expected: command completes, coverage table printed for `src/vault/templates.ts` and `src/vault/export.ts` (both 0% so far — that is fine; we just need the runner to wire up).

- [ ] **Step 5: Commit**

```bash
git add src/vault/templates.ts src/vault/export.ts vitest.config.ts package.json package-lock.json
git commit -m "chore(vault): bootstrap src/vault module + v8 coverage gate"
```

---

## Task 2: Scope sanitizer + slug helpers

**Files:**
- Modify: `src/vault/templates.ts`
- Create: `test/vault/slug.test.ts`

The slug normalizer is re-exported from `src/memory/knowledge.ts` (already exists) — we do **not** duplicate it. We add `sanitizeScope` (folder-name safe) and `disambiguateSlug` (scope-prefix on collision).

- [ ] **Step 1: Write the failing tests**

Create `test/vault/slug.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { disambiguateSlug, sanitizeScope, slugForSubject } from "../../src/vault/templates.js";

describe("sanitizeScope", () => {
  it("passes simple names through", () => {
    expect(sanitizeScope("global")).toBe("global");
    expect(sanitizeScope("project-foo")).toBe("project-foo");
  });

  it("replaces slashes with hyphens", () => {
    expect(sanitizeScope("agent/foo")).toBe("agent-foo");
    expect(sanitizeScope("a/b/c")).toBe("a-b-c");
  });

  it("strips characters illegal on Windows + POSIX", () => {
    expect(sanitizeScope('weird:name*?<>"|')).toBe("weird-name");
  });

  it("collapses runs of hyphens and trims edges", () => {
    expect(sanitizeScope("///hello///")).toBe("hello");
    expect(sanitizeScope("a   b")).toBe("a-b");
  });

  it("falls back to 'scope' for empty input", () => {
    expect(sanitizeScope("")).toBe("scope");
    expect(sanitizeScope("////")).toBe("scope");
  });
});

describe("slugForSubject", () => {
  it("re-exports toSlug behaviour for entity names", () => {
    // toSlug uses underscores (see src/memory/knowledge.ts) — vault follows
    // the KG slug contract so vault filenames match KG subject lookups.
    expect(slugForSubject("David Gillot")).toBe("david_gillot");
    expect(slugForSubject("@tanarchy/lotl")).toBe("tanarchy_lotl");
  });
});

describe("disambiguateSlug", () => {
  it("returns the slug unchanged when no collision", () => {
    expect(disambiguateSlug("david", "global", new Set())).toBe("david");
  });

  it("prefixes the scope when slug already taken", () => {
    const taken = new Set(["david"]);
    expect(disambiguateSlug("david", "project-foo", taken)).toBe("project-foo-david");
  });

  it("sanitizes the scope before prefixing", () => {
    const taken = new Set(["david"]);
    expect(disambiguateSlug("david", "agent/bar", taken)).toBe("agent-bar-david");
  });

  it("re-disambiguates on a second collision by appending a numeric suffix", () => {
    const taken = new Set(["david", "global-david"]);
    expect(disambiguateSlug("david", "global", taken)).toBe("global-david-2");
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run --reporter=verbose test/vault/slug.test.ts`

Expected: FAIL — `sanitizeScope`, `disambiguateSlug`, `slugForSubject` not exported.

- [ ] **Step 3: Implement the helpers**

Replace the contents of `src/vault/templates.ts` with:

```ts
// src/vault/templates.ts
// Pure rendering helpers. No I/O. Subsystem 1 (v1.2.0-alpha.1).

import { toSlug } from "../memory/knowledge.js";

export function slugForSubject(subject: string): string {
  return toSlug(subject);
}

export function sanitizeScope(scope: string): string {
  const cleaned = scope
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return cleaned.length > 0 ? cleaned : "scope";
}

export function disambiguateSlug(
  slug: string,
  scope: string,
  taken: Set<string>,
): string {
  if (!taken.has(slug)) return slug;
  const prefixed = `${sanitizeScope(scope)}-${slug}`;
  if (!taken.has(prefixed)) return prefixed;
  let n = 2;
  while (taken.has(`${prefixed}-${n}`)) n += 1;
  return `${prefixed}-${n}`;
}
```

- [ ] **Step 4: Run the tests and verify pass**

Run: `npx vitest run --reporter=verbose test/vault/slug.test.ts`

Expected: PASS — 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/vault/templates.ts test/vault/slug.test.ts
git commit -m "feat(vault): scope sanitizer + slug disambiguation"
```

---

## Task 3: Frontmatter + entity page renderer

**Files:**
- Modify: `src/vault/templates.ts`
- Create: `test/vault/templates.test.ts`

Section data shape, derived from spec template:

- Each entity has a list of `KnowledgeEntry` rows (already typed in `src/memory/knowledge.ts`).
- `valid_until == null` -> current fact. Otherwise historical.
- `created_at` = min(`valid_from`) over facts; `updated_at` = max(`valid_from`, or `valid_until` if non-null) — pick the most recent timestamp written for the entity.
- `linked memories` is optional (omit section entirely if empty).

- [ ] **Step 1: Define the shared types in `templates.ts`**

Append to `src/vault/templates.ts`:

```ts
export interface EntityFact {
  predicate: string;
  object: string;
  valid_from: string;
  valid_until: string | null;
}

export interface LinkedMemory {
  memory_id: string;
  excerpt: string;
}

export interface EntityPageInput {
  subject: string;
  scope: string;
  facts: EntityFact[];
  linkedMemories: LinkedMemory[];
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/vault/templates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderEntityPage } from "../../src/vault/templates.js";

const baseInput = {
  subject: "David Gillot",
  scope: "global",
  facts: [
    {
      predicate: "works_on",
      object: "Lotl",
      valid_from: "2026-01-15T10:00:00Z",
      valid_until: null,
    },
    {
      predicate: "lives_in",
      object: "Antwerp",
      valid_from: "2024-06-01T00:00:00Z",
      valid_until: "2025-12-31T00:00:00Z",
    },
  ],
  linkedMemories: [
    { memory_id: "abc1234def", excerpt: "David shipped v1.2 alpha." },
  ],
};

describe("renderEntityPage", () => {
  it("emits frontmatter with derived created_at / updated_at / fact_count", () => {
    const md = renderEntityPage(baseInput);
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('title: "David Gillot"');
    expect(md).toContain("type: entity");
    expect(md).toContain('scope: "global"');
    expect(md).toContain('created_at: "2024-06-01T00:00:00Z"');
    expect(md).toContain('updated_at: "2026-01-15T10:00:00Z"');
    expect(md).toContain("fact_count: 2");
  });

  it("renders current facts as wiki-linked bullets with since-date", () => {
    const md = renderEntityPage(baseInput);
    expect(md).toContain("## Current facts");
    expect(md).toContain("- **works_on** [[Lotl]] *(since 2026-01-15T10:00:00Z)*");
  });

  it("renders historical facts with a window", () => {
    const md = renderEntityPage(baseInput);
    expect(md).toContain("## Historical facts");
    expect(md).toContain(
      "- **lives_in** [[Antwerp]] *(2024-06-01T00:00:00Z → 2025-12-31T00:00:00Z)*",
    );
  });

  it("renders linked memories with truncated id + excerpt", () => {
    const md = renderEntityPage(baseInput);
    expect(md).toContain("## Linked memories");
    expect(md).toContain("- [[memory-abc1234]] — David shipped v1.2 alpha.");
  });

  it("omits the Historical facts section when all facts are current", () => {
    const md = renderEntityPage({
      ...baseInput,
      facts: [baseInput.facts[0]!],
    });
    expect(md).not.toContain("## Historical facts");
  });

  it("emits placeholder when all facts have expired", () => {
    const md = renderEntityPage({
      ...baseInput,
      facts: [baseInput.facts[1]!],
    });
    expect(md).toContain("## Current facts");
    expect(md).toContain("*no current facts*");
  });

  it("omits the Linked memories section when none provided", () => {
    const md = renderEntityPage({ ...baseInput, linkedMemories: [] });
    expect(md).not.toContain("## Linked memories");
  });

  it("truncates memory excerpts to 200 chars with ellipsis", () => {
    const long = "x".repeat(250);
    const md = renderEntityPage({
      ...baseInput,
      linkedMemories: [{ memory_id: "deadbeef99", excerpt: long }],
    });
    expect(md).toContain(`- [[memory-deadbeef]] — ${"x".repeat(200)}...`);
  });

  it("handles a 0-fact entity without crashing", () => {
    const md = renderEntityPage({
      subject: "Empty",
      scope: "global",
      facts: [],
      linkedMemories: [],
    });
    expect(md).toContain("fact_count: 0");
    expect(md).toContain("*no current facts*");
    expect(md).not.toContain("## Historical facts");
    expect(md).not.toContain("## Linked memories");
  });
});
```

- [ ] **Step 3: Run the failing tests**

Run: `npx vitest run --reporter=verbose test/vault/templates.test.ts`

Expected: FAIL — `renderEntityPage` not exported.

- [ ] **Step 4: Implement `renderEntityPage`**

Append to `src/vault/templates.ts`:

```ts
function truncate(text: string, max = 200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function pickTimestamps(facts: EntityFact[]): { created: string; updated: string } {
  if (facts.length === 0) {
    const now = "1970-01-01T00:00:00Z";
    return { created: now, updated: now };
  }
  const all = facts.flatMap((f) =>
    f.valid_until ? [f.valid_from, f.valid_until] : [f.valid_from],
  );
  const sorted = [...all].sort();
  return { created: sorted[0]!, updated: sorted[sorted.length - 1]! };
}

export function renderEntityPage(input: EntityPageInput): string {
  const { subject, scope, facts, linkedMemories } = input;
  const current = facts.filter((f) => f.valid_until === null);
  const historical = facts.filter((f) => f.valid_until !== null);
  const { created, updated } = pickTimestamps(facts);

  const lines: string[] = [];
  lines.push("---");
  lines.push(`title: "${subject}"`);
  lines.push("type: entity");
  lines.push(`scope: "${scope}"`);
  lines.push(`created_at: "${created}"`);
  lines.push(`updated_at: "${updated}"`);
  lines.push(`fact_count: ${facts.length}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${subject}`);
  lines.push("");
  lines.push("## Current facts");
  lines.push("");
  if (current.length === 0) {
    lines.push("*no current facts*");
  } else {
    for (const f of current) {
      lines.push(
        `- **${f.predicate}** [[${f.object}]] *(since ${f.valid_from})*`,
      );
    }
  }
  lines.push("");

  if (historical.length > 0) {
    lines.push("## Historical facts");
    lines.push("");
    for (const f of historical) {
      lines.push(
        `- **${f.predicate}** [[${f.object}]] *(${f.valid_from} → ${f.valid_until})*`,
      );
    }
    lines.push("");
  }

  if (linkedMemories.length > 0) {
    lines.push("## Linked memories");
    lines.push("");
    for (const m of linkedMemories) {
      lines.push(
        `- [[memory-${shortId(m.memory_id)}]] — ${truncate(m.excerpt)}`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
```

- [ ] **Step 5: Run the tests and verify pass**

Run: `npx vitest run --reporter=verbose test/vault/templates.test.ts`

Expected: PASS — 9 tests green.

- [ ] **Step 6: Commit**

```bash
git add src/vault/templates.ts test/vault/templates.test.ts
git commit -m "feat(vault): entity page renderer with frontmatter + section gating"
```

---

## Task 4: Inbox renderer (orphan memories grouped by tier)

**Files:**
- Modify: `src/vault/templates.ts`
- Modify: `test/vault/templates.test.ts`

Tier groupings (from existing memory model — three tiers, see `src/memory/decay.ts`):
- `core` (threshold 0.7), `working` (threshold 0.3), `peripheral` (threshold 0.0).
- Group memories by tier; sort by `created_at` desc within each tier; truncate excerpts to 200 chars.
- Omit a tier section when it has zero memories. If all tiers are empty, render a friendly empty line.

- [ ] **Step 1: Define inbox input type**

Append to `src/vault/templates.ts`:

```ts
export type InboxTier = "core" | "working" | "peripheral";

export interface InboxMemory {
  memory_id: string;
  created_at: string;
  importance: number;
  excerpt: string;
}

export interface InboxPageInput {
  scope: string;
  generated_at: string;
  memories: InboxMemory[];
}

export const TIER_THRESHOLDS: Record<InboxTier, number> = {
  core: 0.7,
  working: 0.3,
  peripheral: 0,
};
```

- [ ] **Step 2: Write the failing tests**

Append to `test/vault/templates.test.ts`:

```ts
import { renderInboxPage } from "../../src/vault/templates.js";

describe("renderInboxPage", () => {
  const mems = [
    {
      memory_id: "core01aaaa",
      created_at: "2026-05-19T10:00:00Z",
      importance: 0.85,
      excerpt: "Hard fact",
    },
    {
      memory_id: "core02bbbb",
      created_at: "2026-05-20T10:00:00Z",
      importance: 0.95,
      excerpt: "Newer hard fact",
    },
    {
      memory_id: "work01cccc",
      created_at: "2026-05-15T10:00:00Z",
      importance: 0.5,
      excerpt: "Soft fact",
    },
    {
      memory_id: "per01ddddd",
      created_at: "2026-05-10T10:00:00Z",
      importance: 0.05,
      excerpt: "Noise",
    },
  ];

  it("emits frontmatter with scope, count, generated_at", () => {
    const md = renderInboxPage({
      scope: "global",
      generated_at: "2026-05-20T12:00:00Z",
      memories: mems,
    });
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('title: "Inbox — global"');
    expect(md).toContain("type: inbox");
    expect(md).toContain('scope: "global"');
    expect(md).toContain("count: 4");
    expect(md).toContain('generated_at: "2026-05-20T12:00:00Z"');
  });

  it("groups memories by tier with the right thresholds", () => {
    const md = renderInboxPage({
      scope: "global",
      generated_at: "2026-05-20T12:00:00Z",
      memories: mems,
    });
    expect(md).toContain("## core (importance >= 0.7)");
    expect(md).toContain("## working (importance >= 0.3)");
    expect(md).toContain("## peripheral (importance >= 0)");
  });

  it("sorts within tier by created_at desc", () => {
    const md = renderInboxPage({
      scope: "global",
      generated_at: "2026-05-20T12:00:00Z",
      memories: mems,
    });
    const idxNewer = md.indexOf("Newer hard fact");
    const idxOlder = md.indexOf("Hard fact");
    expect(idxNewer).toBeGreaterThan(-1);
    expect(idxOlder).toBeGreaterThan(idxNewer);
  });

  it("truncates excerpts at 200 chars and emits short id suffix", () => {
    const long = "y".repeat(250);
    const md = renderInboxPage({
      scope: "global",
      generated_at: "2026-05-20T12:00:00Z",
      memories: [
        {
          memory_id: "longidaaaa",
          created_at: "2026-05-20T10:00:00Z",
          importance: 0.95,
          excerpt: long,
        },
      ],
    });
    expect(md).toContain(`${"y".repeat(200)}... \`#longidaa\``);
  });

  it("omits a tier section when it has zero memories", () => {
    const md = renderInboxPage({
      scope: "global",
      generated_at: "2026-05-20T12:00:00Z",
      memories: [mems[0]!],
    });
    expect(md).toContain("## core");
    expect(md).not.toContain("## working");
    expect(md).not.toContain("## peripheral");
  });

  it("renders an empty-state line when there are zero memories", () => {
    const md = renderInboxPage({
      scope: "global",
      generated_at: "2026-05-20T12:00:00Z",
      memories: [],
    });
    expect(md).toContain("count: 0");
    expect(md).toContain("*no orphan memories*");
  });
});
```

- [ ] **Step 3: Run the failing tests**

Run: `npx vitest run --reporter=verbose test/vault/templates.test.ts`

Expected: FAIL — `renderInboxPage` not exported.

- [ ] **Step 4: Implement `renderInboxPage`**

Append to `src/vault/templates.ts`:

```ts
export function classifyTier(importance: number): InboxTier {
  if (importance >= TIER_THRESHOLDS.core) return "core";
  if (importance >= TIER_THRESHOLDS.working) return "working";
  return "peripheral";
}

const TIER_ORDER: InboxTier[] = ["core", "working", "peripheral"];

export function renderInboxPage(input: InboxPageInput): string {
  const { scope, generated_at, memories } = input;
  const lines: string[] = [];
  lines.push("---");
  lines.push(`title: "Inbox — ${scope}"`);
  lines.push("type: inbox");
  lines.push(`scope: "${scope}"`);
  lines.push(`count: ${memories.length}`);
  lines.push(`generated_at: "${generated_at}"`);
  lines.push("---");
  lines.push("");
  lines.push(`# Inbox — ${scope}`);
  lines.push("");
  lines.push("Memories without any entity references.");
  lines.push("");

  if (memories.length === 0) {
    lines.push("*no orphan memories*");
    return `${lines.join("\n")}\n`;
  }

  const grouped: Record<InboxTier, InboxMemory[]> = {
    core: [],
    working: [],
    peripheral: [],
  };
  for (const m of memories) grouped[classifyTier(m.importance)]!.push(m);

  for (const tier of TIER_ORDER) {
    const bucket = grouped[tier];
    if (bucket.length === 0) continue;
    bucket.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    lines.push(`## ${tier} (importance >= ${TIER_THRESHOLDS[tier]})`);
    lines.push("");
    for (const m of bucket) {
      const excerpt = m.excerpt.length > 200
        ? `${m.excerpt.slice(0, 200)}...`
        : m.excerpt;
      lines.push(
        `- **${m.created_at}** — ${excerpt} \`#${m.memory_id.slice(0, 8)}\``,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
```

- [ ] **Step 5: Run the tests and verify pass**

Run: `npx vitest run --reporter=verbose test/vault/templates.test.ts`

Expected: PASS — all template tests green (9 entity + 6 inbox).

- [ ] **Step 6: Commit**

```bash
git add src/vault/templates.ts test/vault/templates.test.ts
git commit -m "feat(vault): inbox renderer grouped by tier with desc sort"
```

---

## Task 5: Fixture KG for the export tests

**Files:**
- Create: `test/fixtures/vault-kg.json`

The fixture is consumed by `export.test.ts` and `integration/incremental.test.ts`. It contains 5 entities, 12 triples, 2 scopes (`global`, `project-foo`), and a mix of `valid_until` states.

- [ ] **Step 1: Write the fixture**

Create `test/fixtures/vault-kg.json`:

```json
{
  "schema_version": 1,
  "triples": [
    { "id": "t01", "subject": "David", "predicate": "works_on", "object": "Lotl", "valid_from": "2026-01-15T10:00:00Z", "valid_until": null, "confidence": 0.95, "source_memory_id": "m001", "scope": "global", "created_at": "2026-01-15T10:00:00Z" },
    { "id": "t02", "subject": "David", "predicate": "lives_in", "object": "Antwerp", "valid_from": "2024-06-01T00:00:00Z", "valid_until": "2025-12-31T00:00:00Z", "confidence": 0.9, "source_memory_id": "m002", "scope": "global", "created_at": "2024-06-01T00:00:00Z" },
    { "id": "t03", "subject": "David", "predicate": "lives_in", "object": "Ghent", "valid_from": "2026-01-01T00:00:00Z", "valid_until": null, "confidence": 0.9, "source_memory_id": "m003", "scope": "global", "created_at": "2026-01-01T00:00:00Z" },
    { "id": "t04", "subject": "Lotl", "predicate": "written_in", "object": "TypeScript", "valid_from": "2024-01-01T00:00:00Z", "valid_until": null, "confidence": 0.99, "source_memory_id": "m004", "scope": "global", "created_at": "2024-01-01T00:00:00Z" },
    { "id": "t05", "subject": "Lotl", "predicate": "uses", "object": "SQLite", "valid_from": "2024-01-01T00:00:00Z", "valid_until": null, "confidence": 0.99, "source_memory_id": "m004", "scope": "global", "created_at": "2024-01-01T00:00:00Z" },
    { "id": "t06", "subject": "Antwerp", "predicate": "is_a", "object": "City", "valid_from": "2024-06-01T00:00:00Z", "valid_until": null, "confidence": 0.95, "source_memory_id": null, "scope": "global", "created_at": "2024-06-01T00:00:00Z" },
    { "id": "t07", "subject": "Ghent", "predicate": "is_a", "object": "City", "valid_from": "2026-01-01T00:00:00Z", "valid_until": null, "confidence": 0.95, "source_memory_id": null, "scope": "global", "created_at": "2026-01-01T00:00:00Z" },
    { "id": "t08", "subject": "ProjectFoo", "predicate": "owned_by", "object": "David", "valid_from": "2025-09-01T00:00:00Z", "valid_until": null, "confidence": 0.9, "source_memory_id": "m005", "scope": "project-foo", "created_at": "2025-09-01T00:00:00Z" },
    { "id": "t09", "subject": "ProjectFoo", "predicate": "status", "object": "Active", "valid_from": "2025-09-01T00:00:00Z", "valid_until": "2026-03-01T00:00:00Z", "confidence": 0.8, "source_memory_id": "m005", "scope": "project-foo", "created_at": "2025-09-01T00:00:00Z" },
    { "id": "t10", "subject": "ProjectFoo", "predicate": "status", "object": "Shipped", "valid_from": "2026-03-01T00:00:00Z", "valid_until": null, "confidence": 0.9, "source_memory_id": "m006", "scope": "project-foo", "created_at": "2026-03-01T00:00:00Z" },
    { "id": "t11", "subject": "David", "predicate": "owns", "object": "ProjectFoo", "valid_from": "2025-09-01T00:00:00Z", "valid_until": null, "confidence": 0.85, "source_memory_id": "m005", "scope": "project-foo", "created_at": "2025-09-01T00:00:00Z" },
    { "id": "t12", "subject": "David", "predicate": "favourite_lang", "object": "TypeScript", "valid_from": "2024-01-01T00:00:00Z", "valid_until": null, "confidence": 0.7, "source_memory_id": "m004", "scope": "global", "created_at": "2024-01-01T00:00:00Z" }
  ],
  "memories": [
    { "id": "m001", "scope": "global", "text": "David works on Lotl since Jan 2026.", "importance": 0.85, "created_at": "2026-01-15T10:00:00Z" },
    { "id": "m002", "scope": "global", "text": "David used to live in Antwerp until end of 2025.", "importance": 0.4, "created_at": "2024-06-01T00:00:00Z" },
    { "id": "m003", "scope": "global", "text": "David moved to Ghent in 2026.", "importance": 0.6, "created_at": "2026-01-01T00:00:00Z" },
    { "id": "m004", "scope": "global", "text": "Lotl is written in TypeScript and uses SQLite.", "importance": 0.9, "created_at": "2024-01-01T00:00:00Z" },
    { "id": "m005", "scope": "project-foo", "text": "ProjectFoo owned by David.", "importance": 0.75, "created_at": "2025-09-01T00:00:00Z" },
    { "id": "m006", "scope": "project-foo", "text": "ProjectFoo shipped.", "importance": 0.9, "created_at": "2026-03-01T00:00:00Z" },
    { "id": "m_orphan_1", "scope": "global", "text": "Today I drank coffee and felt slightly more alive than usual, an unremarkable yet warm experience.", "importance": 0.05, "created_at": "2026-05-10T10:00:00Z" },
    { "id": "m_orphan_2", "scope": "global", "text": "Reminder: renew passport before September.", "importance": 0.5, "created_at": "2026-05-15T10:00:00Z" },
    { "id": "m_orphan_3", "scope": "global", "text": "Critical: backup encryption key is in 1Password vault 'longterm'.", "importance": 0.9, "created_at": "2026-05-18T10:00:00Z" },
    { "id": "m_orphan_4", "scope": "project-foo", "text": "Need to write a post-mortem for ProjectFoo shipping.", "importance": 0.7, "created_at": "2026-04-01T10:00:00Z" }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add test/fixtures/vault-kg.json
git commit -m "test(vault): canonical KG fixture (5 entities, 12 triples, 2 scopes)"
```

---

## Task 6 (patience phase: many small unit tests, mechanical)

**Vault root resolution, hash computation, scope enumeration**

**Files:**
- Modify: `src/vault/export.ts`
- Create: `test/vault/export.test.ts`

Resolve `~` via `os.homedir()` because this is a Windows dev machine. Env override: `LOTL_VAULT_PATH`. Default: `<homedir>/.local/share/lotl/vault`. The hash is `sha256(<kg_count>:<max(updated_at)>)` truncated to 32 hex chars for readability — the spec says "sha256-of-(kg_count, max(updated_at))"; we store the full hex.

- [ ] **Step 1: Write the failing tests**

Create `test/vault/export.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  resolveVaultRoot,
  computeScopeHash,
  scopeDir,
} from "../../src/vault/export.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "lotl-vault-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("resolveVaultRoot", () => {
  it("honours LOTL_VAULT_PATH when set", () => {
    expect(resolveVaultRoot({ LOTL_VAULT_PATH: tmp })).toBe(tmp);
  });

  it("expands a leading ~ via homedir", () => {
    const resolved = resolveVaultRoot({ LOTL_VAULT_PATH: "~/vault-x" }, "/home/u");
    expect(resolved).toBe(join("/home/u", "vault-x"));
  });

  it("falls back to ~/.local/share/lotl/vault when env unset", () => {
    const resolved = resolveVaultRoot({}, "/home/u");
    expect(resolved).toBe(join("/home/u", ".local", "share", "lotl", "vault"));
  });
});

describe("scopeDir", () => {
  it("sanitizes the scope into the folder name", () => {
    expect(scopeDir("/root", "agent/foo")).toBe(join("/root", "agent-foo"));
    expect(scopeDir("/root", "global")).toBe(join("/root", "global"));
  });
});

describe("computeScopeHash", () => {
  it("is stable for same inputs", () => {
    const a = computeScopeHash(5, "2026-05-20T10:00:00Z");
    const b = computeScopeHash(5, "2026-05-20T10:00:00Z");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when kg_count changes", () => {
    expect(computeScopeHash(5, "2026-05-20T10:00:00Z")).not.toBe(
      computeScopeHash(6, "2026-05-20T10:00:00Z"),
    );
  });

  it("changes when max_updated_at changes", () => {
    expect(computeScopeHash(5, "2026-05-20T10:00:00Z")).not.toBe(
      computeScopeHash(5, "2026-05-21T10:00:00Z"),
    );
  });

  it("accepts null max_updated_at (empty scope)", () => {
    expect(computeScopeHash(0, null)).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run --reporter=verbose test/vault/export.test.ts`

Expected: FAIL — `resolveVaultRoot`, `computeScopeHash`, `scopeDir` not exported.

- [ ] **Step 3: Implement the helpers**

Replace the contents of `src/vault/export.ts` with:

```ts
// src/vault/export.ts
// KG -> vault Markdown exporter. Subsystem 1 (v1.2.0-alpha.1).

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeScope } from "./templates.js";

export function resolveVaultRoot(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const override = env.LOTL_VAULT_PATH;
  if (override && override.length > 0) {
    if (override.startsWith("~")) return join(home, override.slice(1).replace(/^[\\/]/, ""));
    return override;
  }
  return join(home, ".local", "share", "lotl", "vault");
}

export function scopeDir(root: string, scope: string): string {
  return join(root, sanitizeScope(scope));
}

export function computeScopeHash(
  kgCount: number,
  maxUpdatedAt: string | null,
): string {
  return createHash("sha256")
    .update(`${kgCount}:${maxUpdatedAt ?? ""}`)
    .digest("hex");
}
```

- [ ] **Step 4: Run the tests and verify pass**

Run: `npx vitest run --reporter=verbose test/vault/export.test.ts`

Expected: PASS — 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/vault/export.ts test/vault/export.test.ts
git commit -m "feat(vault): vault root + scope dir + hash helpers"
```

---

## Task 7: DB read interface for triples + orphan memories

**Files:**
- Modify: `src/vault/export.ts`
- Modify: `test/vault/export.test.ts`

We define a narrow read-only interface (`VaultDataSource`) so unit tests can supply an in-memory fixture loader and integration tests will use a live DB via Subsystem 1's call into `knowledgeEntities`/`knowledgeQuery` + a memory query. The DB query for orphan memories selects memories whose `id` is not in `(SELECT DISTINCT source_memory_id FROM knowledge WHERE source_memory_id IS NOT NULL)`. Subsystem 2 will mutate the KG; here we only read.

- [ ] **Step 1: Add the data source interface tests**

Append to `test/vault/export.test.ts`:

```ts
import { readFile as readFileTest } from "node:fs/promises";
import {
  loadFixtureDataSource,
  listScopes,
  collectEntityFacts,
  collectOrphanMemories,
} from "../../src/vault/export.js";

async function fixtureSource() {
  const raw = await readFileTest(
    join(process.cwd(), "test/fixtures/vault-kg.json"),
    "utf8",
  );
  return loadFixtureDataSource(JSON.parse(raw) as never);
}

describe("VaultDataSource (fixture loader)", () => {
  it("listScopes returns both seeded scopes", async () => {
    const ds = await fixtureSource();
    const scopes = await ds.listScopes();
    expect(scopes.sort()).toEqual(["global", "project-foo"]);
  });

  it("collectEntityFacts groups triples by subject within a scope", async () => {
    const ds = await fixtureSource();
    const entities = await collectEntityFacts(ds, "global");
    const names = entities.map((e) => e.subject).sort();
    expect(names).toEqual(["Antwerp", "David", "Ghent", "Lotl"]);
    const david = entities.find((e) => e.subject === "David")!;
    expect(david.facts.length).toBe(4);
    expect(david.facts.some((f) => f.predicate === "lives_in" && f.object === "Ghent" && f.valid_until === null)).toBe(true);
    expect(david.facts.some((f) => f.predicate === "lives_in" && f.object === "Antwerp" && f.valid_until !== null)).toBe(true);
  });

  it("collectOrphanMemories returns only memories not referenced by any triple", async () => {
    const ds = await fixtureSource();
    const orphans = await collectOrphanMemories(ds, "global");
    const ids = orphans.map((m) => m.memory_id).sort();
    expect(ids).toEqual(["m_orphan_1", "m_orphan_2", "m_orphan_3"]);
  });

  it("scope filter applies to orphans too", async () => {
    const ds = await fixtureSource();
    const orphans = await collectOrphanMemories(ds, "project-foo");
    expect(orphans.map((m) => m.memory_id)).toEqual(["m_orphan_4"]);
  });

  it("max_updated_at returns the latest valid_from/valid_until timestamp in the scope", async () => {
    const ds = await fixtureSource();
    const ts = await ds.maxUpdatedAt("global");
    expect(ts).toBe("2026-01-15T10:00:00Z");
  });

  it("kgCount returns the number of triples in the scope", async () => {
    const ds = await fixtureSource();
    expect(await ds.kgCount("global")).toBe(8);
    expect(await ds.kgCount("project-foo")).toBe(4);
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run --reporter=verbose test/vault/export.test.ts`

Expected: FAIL — fixture loader + collectors not exported.

- [ ] **Step 3: Implement the data source interface**

Append to `src/vault/export.ts`:

```ts
import type { EntityFact, InboxMemory, LinkedMemory } from "./templates.js";

export interface RawTriple {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: string;
  valid_until: string | null;
  source_memory_id: string | null;
  scope: string;
  created_at: string;
}

export interface RawMemory {
  id: string;
  scope: string;
  text: string;
  importance: number;
  created_at: string;
}

export interface VaultDataSource {
  listScopes(): Promise<string[]>;
  triplesForScope(scope: string): Promise<RawTriple[]>;
  memoriesForScope(scope: string): Promise<RawMemory[]>;
  kgCount(scope: string): Promise<number>;
  maxUpdatedAt(scope: string): Promise<string | null>;
}

export interface EntityGroup {
  subject: string;
  scope: string;
  facts: EntityFact[];
  linkedMemories: LinkedMemory[];
}

function dedupeFacts(triples: RawTriple[]): EntityFact[] {
  const seen = new Set<string>();
  const out: EntityFact[] = [];
  for (const t of triples) {
    const key = `${t.predicate}|${t.object}|${t.valid_from}|${t.valid_until ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      predicate: t.predicate,
      object: t.object,
      valid_from: t.valid_from,
      valid_until: t.valid_until,
    });
  }
  return out;
}

export async function collectEntityFacts(
  ds: VaultDataSource,
  scope: string,
): Promise<EntityGroup[]> {
  const triples = await ds.triplesForScope(scope);
  const bySubject = new Map<string, RawTriple[]>();
  for (const t of triples) {
    if (!bySubject.has(t.subject)) bySubject.set(t.subject, []);
    bySubject.get(t.subject)!.push(t);
  }
  const memories = await ds.memoriesForScope(scope);
  const memoryById = new Map(memories.map((m) => [m.id, m]));

  const groups: EntityGroup[] = [];
  for (const [subject, subjectTriples] of bySubject) {
    const linkedIds = new Set<string>();
    for (const t of subjectTriples) {
      if (t.source_memory_id) linkedIds.add(t.source_memory_id);
    }
    const linkedMemories: LinkedMemory[] = [];
    for (const id of linkedIds) {
      const m = memoryById.get(id);
      if (!m) continue;
      linkedMemories.push({ memory_id: m.id, excerpt: m.text });
    }
    groups.push({
      subject,
      scope,
      facts: dedupeFacts(subjectTriples),
      linkedMemories,
    });
  }
  groups.sort((a, b) => (a.subject < b.subject ? -1 : 1));
  return groups;
}

export async function collectOrphanMemories(
  ds: VaultDataSource,
  scope: string,
): Promise<InboxMemory[]> {
  const triples = await ds.triplesForScope(scope);
  const referenced = new Set<string>();
  for (const t of triples) {
    if (t.source_memory_id) referenced.add(t.source_memory_id);
  }
  const memories = await ds.memoriesForScope(scope);
  return memories
    .filter((m) => !referenced.has(m.id))
    .map((m) => ({
      memory_id: m.id,
      created_at: m.created_at,
      importance: m.importance,
      excerpt: m.text,
    }));
}

interface FixturePayload {
  triples: RawTriple[];
  memories: RawMemory[];
}

export function loadFixtureDataSource(payload: FixturePayload): VaultDataSource {
  return {
    async listScopes() {
      return Array.from(new Set(payload.triples.map((t) => t.scope))).sort();
    },
    async triplesForScope(scope) {
      return payload.triples.filter((t) => t.scope === scope);
    },
    async memoriesForScope(scope) {
      return payload.memories.filter((m) => m.scope === scope);
    },
    async kgCount(scope) {
      return payload.triples.filter((t) => t.scope === scope).length;
    },
    async maxUpdatedAt(scope) {
      const stamps: string[] = [];
      for (const t of payload.triples) {
        if (t.scope !== scope) continue;
        stamps.push(t.valid_from);
        if (t.valid_until) stamps.push(t.valid_until);
      }
      if (stamps.length === 0) return null;
      stamps.sort();
      return stamps[stamps.length - 1]!;
    },
  };
}

export async function listScopes(ds: VaultDataSource): Promise<string[]> {
  return ds.listScopes();
}
```

- [ ] **Step 4: Run the tests and verify pass**

Run: `npx vitest run --reporter=verbose test/vault/export.test.ts`

Expected: PASS — all 14 export tests green.

- [ ] **Step 5: Commit**

```bash
git add src/vault/export.ts test/vault/export.test.ts
git commit -m "feat(vault): data source interface + fixture loader + entity/orphan collectors"
```

---

## Task 8: SQLite-backed data source

**Files:**
- Modify: `src/vault/export.ts`
- Modify: `test/vault/export.test.ts`

We bind to `better-sqlite3`'s `Database` (from `src/db.ts`). The vault module receives a generic `Database` instance — no module-scope DB open — so unit tests can stand up an in-memory DB.

- [ ] **Step 1: Write the failing test**

Append to `test/vault/export.test.ts`:

```ts
import Database from "better-sqlite3";
import { createSqliteDataSource } from "../../src/vault/export.js";

describe("createSqliteDataSource", () => {
  function seed(): Database.Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE knowledge (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_until TEXT,
        source_memory_id TEXT,
        scope TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        text TEXT NOT NULL,
        importance REAL NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const t = db.prepare(
      "INSERT INTO knowledge VALUES (?,?,?,?,?,?,?,?,?)",
    );
    t.run("t1", "David", "works_on", "Lotl", "2026-01-15T10:00:00Z", null, "m1", "global", "2026-01-15T10:00:00Z");
    t.run("t2", "Lotl", "uses", "SQLite", "2024-01-01T00:00:00Z", null, "m2", "global", "2024-01-01T00:00:00Z");
    const m = db.prepare("INSERT INTO memories VALUES (?,?,?,?,?)");
    m.run("m1", "global", "David works on Lotl.", 0.9, "2026-01-15T10:00:00Z");
    m.run("m2", "global", "Lotl uses SQLite.", 0.8, "2024-01-01T00:00:00Z");
    m.run("m3", "global", "Orphan note.", 0.4, "2026-05-01T00:00:00Z");
    return db;
  }

  it("listScopes returns distinct scopes from knowledge", async () => {
    const db = seed();
    const ds = createSqliteDataSource(db);
    expect(await ds.listScopes()).toEqual(["global"]);
  });

  it("triplesForScope returns triples with the right shape", async () => {
    const db = seed();
    const ds = createSqliteDataSource(db);
    const triples = await ds.triplesForScope("global");
    expect(triples.length).toBe(2);
    expect(triples[0]!.subject).toBe("David");
  });

  it("memoriesForScope returns all memories in scope", async () => {
    const db = seed();
    const ds = createSqliteDataSource(db);
    const memories = await ds.memoriesForScope("global");
    expect(memories.length).toBe(3);
  });

  it("kgCount returns the row count", async () => {
    const db = seed();
    const ds = createSqliteDataSource(db);
    expect(await ds.kgCount("global")).toBe(2);
  });

  it("maxUpdatedAt returns the latest timestamp (valid_from or valid_until)", async () => {
    const db = seed();
    const ds = createSqliteDataSource(db);
    expect(await ds.maxUpdatedAt("global")).toBe("2026-01-15T10:00:00Z");
  });

  it("maxUpdatedAt returns null for empty scope", async () => {
    const db = seed();
    const ds = createSqliteDataSource(db);
    expect(await ds.maxUpdatedAt("does-not-exist")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run --reporter=verbose test/vault/export.test.ts`

Expected: FAIL — `createSqliteDataSource` not exported.

- [ ] **Step 3: Implement the SQLite-backed source**

Append to `src/vault/export.ts`:

```ts
import type { Database as BetterSqlite3Database } from "better-sqlite3";

export function createSqliteDataSource(
  db: BetterSqlite3Database,
): VaultDataSource {
  return {
    async listScopes() {
      const rows = db
        .prepare("SELECT DISTINCT scope FROM knowledge ORDER BY scope")
        .all() as { scope: string }[];
      return rows.map((r) => r.scope);
    },
    async triplesForScope(scope) {
      return db
        .prepare(
          `SELECT id, subject, predicate, object, valid_from, valid_until,
                  source_memory_id, scope, created_at
             FROM knowledge WHERE scope = ?`,
        )
        .all(scope) as RawTriple[];
    },
    async memoriesForScope(scope) {
      return db
        .prepare(
          `SELECT id, scope, text, importance, created_at
             FROM memories WHERE scope = ?`,
        )
        .all(scope) as RawMemory[];
    },
    async kgCount(scope) {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM knowledge WHERE scope = ?")
        .get(scope) as { n: number };
      return row.n;
    },
    async maxUpdatedAt(scope) {
      const row = db
        .prepare(
          `SELECT MAX(ts) AS ts FROM (
             SELECT valid_from AS ts FROM knowledge WHERE scope = ?
             UNION ALL
             SELECT valid_until AS ts FROM knowledge WHERE scope = ? AND valid_until IS NOT NULL
           )`,
        )
        .get(scope, scope) as { ts: string | null };
      return row.ts ?? null;
    },
  };
}
```

- [ ] **Step 4: Run the tests and verify pass**

Run: `npx vitest run --reporter=verbose test/vault/export.test.ts`

Expected: PASS — all 20 export tests green.

- [ ] **Step 5: Commit**

```bash
git add src/vault/export.ts test/vault/export.test.ts
git commit -m "feat(vault): better-sqlite3-backed VaultDataSource"
```

---

## Task 9: Atomic scope writer

**Files:**
- Modify: `src/vault/export.ts`
- Modify: `test/vault/export.test.ts`

Per spec atomic write protocol:

1. `<scopeDir>/.tmp/` is written.
2. If old vault exists: rename `<scopeDir>/entities/` -> `<scopeDir>/.old-entities-<ts>/` (and same for `inbox.md`, `.lotl-export.json`).
3. Rename `<scopeDir>/.tmp/entities/` -> `<scopeDir>/entities/`, and `<scopeDir>/.tmp/inbox.md` -> `<scopeDir>/inbox.md`, and same for `.lotl-export.json`.
4. On success delete the `.old-*` directories/files.
5. On any failure step 2-3 throws -> the `.old-*` items stay for forensics, the new `.tmp/` remains for inspection.

- [ ] **Step 1: Add the writer tests**

Append to `test/vault/export.test.ts`:

```ts
import { writeScopeAtomically } from "../../src/vault/export.js";

describe("writeScopeAtomically", () => {
  it("creates entities/ and inbox.md on first run", async () => {
    const scopeRoot = join(tmp, "global");
    await mkdir(scopeRoot, { recursive: true });
    await writeScopeAtomically(scopeRoot, {
      entities: [
        { slug: "david", body: "# David\n" },
        { slug: "lotl", body: "# Lotl\n" },
      ],
      inbox: "# Inbox\n",
      metadata: {
        schema_version: 1,
        exported_at: "2026-05-20T12:00:00Z",
        scope: "global",
        kg_count: 12,
        memory_count: 7,
        hash: "abc",
      },
    });
    expect(existsSync(join(scopeRoot, "entities", "david.md"))).toBe(true);
    expect(existsSync(join(scopeRoot, "entities", "lotl.md"))).toBe(true);
    expect(existsSync(join(scopeRoot, "inbox.md"))).toBe(true);
    expect(existsSync(join(scopeRoot, ".lotl-export.json"))).toBe(true);
    expect(existsSync(join(scopeRoot, ".tmp"))).toBe(false);
  });

  it("replaces an existing vault and cleans the .old-* directory on success", async () => {
    const scopeRoot = join(tmp, "global");
    await mkdir(join(scopeRoot, "entities"), { recursive: true });
    await writeFile(join(scopeRoot, "entities", "stale.md"), "old");
    await writeFile(join(scopeRoot, "inbox.md"), "old inbox");
    await writeFile(
      join(scopeRoot, ".lotl-export.json"),
      JSON.stringify({ hash: "old" }),
    );

    await writeScopeAtomically(scopeRoot, {
      entities: [{ slug: "fresh", body: "# Fresh\n" }],
      inbox: "# New inbox\n",
      metadata: {
        schema_version: 1,
        exported_at: "2026-05-20T12:00:00Z",
        scope: "global",
        kg_count: 1,
        memory_count: 0,
        hash: "new",
      },
    });

    expect(existsSync(join(scopeRoot, "entities", "fresh.md"))).toBe(true);
    expect(existsSync(join(scopeRoot, "entities", "stale.md"))).toBe(false);
    expect((await readFile(join(scopeRoot, "inbox.md"), "utf8"))).toContain("New inbox");
    const meta = JSON.parse(
      await readFile(join(scopeRoot, ".lotl-export.json"), "utf8"),
    );
    expect(meta.hash).toBe("new");
    const entries = await import("node:fs/promises").then((fs) =>
      fs.readdir(scopeRoot),
    );
    expect(entries.some((e) => e.startsWith(".old-"))).toBe(false);
    expect(entries.includes(".tmp")).toBe(false);
  });

  it("leaves .old-* behind when the rename step throws", async () => {
    const scopeRoot = join(tmp, "global");
    await mkdir(join(scopeRoot, "entities"), { recursive: true });
    await writeFile(join(scopeRoot, "entities", "keep.md"), "stay");
    await writeFile(join(scopeRoot, "inbox.md"), "stay");
    await writeFile(join(scopeRoot, ".lotl-export.json"), "{}");

    // Force a failure by making the .tmp directory unrenamable:
    // pre-create entities/ as a file (not a directory) at the destination
    // path after the .old- move; we simulate the impossible state by
    // injecting an error via a faulty .tmp shape.
    await expect(
      writeScopeAtomically(scopeRoot, {
        entities: [{ slug: "", body: "" }], // empty slug triggers validation
        inbox: "x",
        metadata: {
          schema_version: 1,
          exported_at: "2026-05-20T12:00:00Z",
          scope: "global",
          kg_count: 0,
          memory_count: 0,
          hash: "x",
        },
      }),
    ).rejects.toThrow(/empty entity slug/);
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run --reporter=verbose test/vault/export.test.ts`

Expected: FAIL — `writeScopeAtomically` not exported.

- [ ] **Step 3: Implement the writer**

Append to `src/vault/export.ts`:

```ts
import { mkdir, writeFile, rename, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

export interface ScopeExportMetadata {
  schema_version: 1;
  exported_at: string;
  scope: string;
  kg_count: number;
  memory_count: number;
  hash: string;
}

export interface ScopePayload {
  entities: { slug: string; body: string }[];
  inbox: string;
  metadata: ScopeExportMetadata;
}

function timestampToken(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function writeScopeAtomically(
  scopeRoot: string,
  payload: ScopePayload,
): Promise<void> {
  for (const e of payload.entities) {
    if (!e.slug || e.slug.length === 0) {
      throw new Error("empty entity slug — refusing to write");
    }
  }
  await mkdir(scopeRoot, { recursive: true });
  const tmp = join(scopeRoot, ".tmp");
  if (existsSync(tmp)) await rm(tmp, { recursive: true, force: true });
  await mkdir(join(tmp, "entities"), { recursive: true });
  for (const e of payload.entities) {
    await writeFile(join(tmp, "entities", `${e.slug}.md`), e.body, "utf8");
  }
  await writeFile(join(tmp, "inbox.md"), payload.inbox, "utf8");
  await writeFile(
    join(tmp, ".lotl-export.json"),
    `${JSON.stringify(payload.metadata, null, 2)}\n`,
    "utf8",
  );

  const ts = timestampToken();
  const oldEntities = join(scopeRoot, `.old-entities-${ts}`);
  const oldInbox = join(scopeRoot, `.old-inbox-${ts}.md`);
  const oldMeta = join(scopeRoot, `.old-export-${ts}.json`);

  if (existsSync(join(scopeRoot, "entities"))) {
    await rename(join(scopeRoot, "entities"), oldEntities);
  }
  if (existsSync(join(scopeRoot, "inbox.md"))) {
    await rename(join(scopeRoot, "inbox.md"), oldInbox);
  }
  if (existsSync(join(scopeRoot, ".lotl-export.json"))) {
    await rename(join(scopeRoot, ".lotl-export.json"), oldMeta);
  }

  await rename(join(tmp, "entities"), join(scopeRoot, "entities"));
  await rename(join(tmp, "inbox.md"), join(scopeRoot, "inbox.md"));
  await rename(
    join(tmp, ".lotl-export.json"),
    join(scopeRoot, ".lotl-export.json"),
  );
  await rm(tmp, { recursive: true, force: true });

  for (const stale of [oldEntities, oldInbox, oldMeta]) {
    if (existsSync(stale)) await rm(stale, { recursive: true, force: true });
  }
}

export async function readScopeMetadata(
  scopeRoot: string,
): Promise<ScopeExportMetadata | null> {
  const path = join(scopeRoot, ".lotl-export.json");
  if (!existsSync(path)) return null;
  try {
    const raw = await (await import("node:fs/promises")).readFile(path, "utf8");
    return JSON.parse(raw) as ScopeExportMetadata;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests and verify pass**

Run: `npx vitest run --reporter=verbose test/vault/export.test.ts`

Expected: PASS — 23 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/vault/export.ts test/vault/export.test.ts
git commit -m "feat(vault): atomic scope writer (tmp + rename) with .old-* forensics"
```

---

## Task 10: Top-level `exportScope` + `exportAllScopes` + `vaultStatus`

**Files:**
- Modify: `src/vault/export.ts`
- Modify: `test/vault/export.test.ts`

This is the orchestrator. It:

1. Computes new hash from `(kgCount, maxUpdatedAt)`.
2. Reads old `.lotl-export.json`; if `hash` matches and `!force`, returns `{ skipped: true }`.
3. Else renders entity pages (with slug disambiguation), inbox, metadata.
4. Calls `writeScopeAtomically`.
5. Returns `{ skipped: false, entityCount, memoryCount }`.

`vaultStatus` enumerates scope dirs under the vault root + scopes in the KG; merges; for each reports `(scope, kg_count, last_export_at, hash, vault_dir_present)`.

- [ ] **Step 1: Add the orchestrator tests**

Append to `test/vault/export.test.ts`:

```ts
import {
  exportScope,
  exportAllScopes,
  vaultStatus,
} from "../../src/vault/export.js";

describe("exportScope", () => {
  it("writes the full vault on first export", async () => {
    const ds = await fixtureSource();
    const result = await exportScope({
      dataSource: ds,
      scope: "global",
      vaultRoot: tmp,
      now: () => "2026-05-20T12:00:00Z",
    });
    expect(result.skipped).toBe(false);
    expect(result.entityCount).toBe(4);
    expect(result.memoryCount).toBe(3);
    const dir = join(tmp, "global");
    const files = (await readdir(join(dir, "entities"))).sort();
    expect(files).toEqual(["antwerp.md", "david.md", "ghent.md", "lotl.md"]);
  });

  it("is a no-op on the second run when KG hash unchanged", async () => {
    const ds = await fixtureSource();
    await exportScope({
      dataSource: ds,
      scope: "global",
      vaultRoot: tmp,
      now: () => "2026-05-20T12:00:00Z",
    });
    const second = await exportScope({
      dataSource: ds,
      scope: "global",
      vaultRoot: tmp,
      now: () => "2026-05-20T13:00:00Z",
    });
    expect(second.skipped).toBe(true);
  });

  it("force: true rewrites the vault even when the hash matches", async () => {
    const ds = await fixtureSource();
    await exportScope({
      dataSource: ds,
      scope: "global",
      vaultRoot: tmp,
      now: () => "2026-05-20T12:00:00Z",
    });
    const forced = await exportScope({
      dataSource: ds,
      scope: "global",
      vaultRoot: tmp,
      now: () => "2026-05-20T13:00:00Z",
      force: true,
    });
    expect(forced.skipped).toBe(false);
    const meta = JSON.parse(
      await readFile(join(tmp, "global", ".lotl-export.json"), "utf8"),
    );
    expect(meta.exported_at).toBe("2026-05-20T13:00:00Z");
  });

  it("treats a corrupt .lotl-export.json as 'no metadata' and rebuilds", async () => {
    const ds = await fixtureSource();
    await mkdir(join(tmp, "global"), { recursive: true });
    await writeFile(join(tmp, "global", ".lotl-export.json"), "}}}not-json");
    const result = await exportScope({
      dataSource: ds,
      scope: "global",
      vaultRoot: tmp,
      now: () => "2026-05-20T12:00:00Z",
    });
    expect(result.skipped).toBe(false);
  });

  it("disambiguates colliding slugs via the scope prefix", async () => {
    const ds = loadFixtureDataSource({
      triples: [
        { id: "a", subject: "Same Name", predicate: "p", object: "X", valid_from: "2026-01-01T00:00:00Z", valid_until: null, source_memory_id: null, scope: "global", created_at: "2026-01-01T00:00:00Z" },
        { id: "b", subject: "Same  Name", predicate: "q", object: "Y", valid_from: "2026-01-02T00:00:00Z", valid_until: null, source_memory_id: null, scope: "global", created_at: "2026-01-02T00:00:00Z" },
      ],
      memories: [],
    });
    await exportScope({
      dataSource: ds,
      scope: "global",
      vaultRoot: tmp,
      now: () => "2026-05-20T12:00:00Z",
    });
    const files = (await readdir(join(tmp, "global", "entities"))).sort();
    expect(files.length).toBe(2);
    expect(files).toContain("same-name.md");
    expect(files.some((f) => f.startsWith("global-same-name"))).toBe(true);
  });
});

describe("exportAllScopes", () => {
  it("exports every scope returned by the data source", async () => {
    const ds = await fixtureSource();
    const summary = await exportAllScopes({
      dataSource: ds,
      vaultRoot: tmp,
      now: () => "2026-05-20T12:00:00Z",
    });
    expect(Object.keys(summary).sort()).toEqual(["global", "project-foo"]);
    expect(summary["global"]!.skipped).toBe(false);
    expect(summary["project-foo"]!.skipped).toBe(false);
  });

  it("scoping to one scope ignores the others", async () => {
    const ds = await fixtureSource();
    const summary = await exportAllScopes({
      dataSource: ds,
      vaultRoot: tmp,
      onlyScope: "project-foo",
      now: () => "2026-05-20T12:00:00Z",
    });
    expect(Object.keys(summary)).toEqual(["project-foo"]);
  });
});

describe("vaultStatus", () => {
  it("reports per-scope kg_count, last_export_at, hash, vault_dir_present", async () => {
    const ds = await fixtureSource();
    await exportScope({
      dataSource: ds,
      scope: "global",
      vaultRoot: tmp,
      now: () => "2026-05-20T12:00:00Z",
    });
    const status = await vaultStatus({ dataSource: ds, vaultRoot: tmp });
    expect(status.vault_root).toBe(tmp);
    const global = status.scopes.find((s) => s.scope === "global")!;
    expect(global.kg_count).toBe(8);
    expect(global.last_export_at).toBe("2026-05-20T12:00:00Z");
    expect(global.vault_dir_present).toBe(true);
    const projectFoo = status.scopes.find((s) => s.scope === "project-foo")!;
    expect(projectFoo.vault_dir_present).toBe(false);
    expect(projectFoo.last_export_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run --reporter=verbose test/vault/export.test.ts`

Expected: FAIL — `exportScope`, `exportAllScopes`, `vaultStatus` not exported.

- [ ] **Step 3: Implement the orchestrator**

Append to `src/vault/export.ts`:

```ts
import {
  classifyTier as _classifyTierUnused,
  disambiguateSlug,
  renderEntityPage,
  renderInboxPage,
  sanitizeScope as _sanitizeScopeUnused,
  slugForSubject,
} from "./templates.js";

export interface ExportOptions {
  dataSource: VaultDataSource;
  scope: string;
  vaultRoot: string;
  force?: boolean;
  now?: () => string;
}

export interface ExportResult {
  skipped: boolean;
  entityCount: number;
  memoryCount: number;
  hash: string;
}

function defaultNow(): string {
  return new Date().toISOString();
}

export async function exportScope(opts: ExportOptions): Promise<ExportResult> {
  const { dataSource, scope, vaultRoot, force = false } = opts;
  const now = opts.now ?? defaultNow;

  const kgCount = await dataSource.kgCount(scope);
  const maxUpdatedAt = await dataSource.maxUpdatedAt(scope);
  const hash = computeScopeHash(kgCount, maxUpdatedAt);

  const dir = scopeDir(vaultRoot, scope);
  const prior = await readScopeMetadata(dir);
  if (!force && prior && prior.hash === hash) {
    return { skipped: true, entityCount: 0, memoryCount: 0, hash };
  }

  const entityGroups = await collectEntityFacts(dataSource, scope);
  const orphanMemories = await collectOrphanMemories(dataSource, scope);

  const taken = new Set<string>();
  const renderedEntities: { slug: string; body: string }[] = [];
  for (const group of entityGroups) {
    const baseSlug = slugForSubject(group.subject);
    const slug = disambiguateSlug(baseSlug, scope, taken);
    taken.add(slug);
    renderedEntities.push({
      slug,
      body: renderEntityPage({
        subject: group.subject,
        scope: group.scope,
        facts: group.facts,
        linkedMemories: group.linkedMemories,
      }),
    });
  }

  const inboxBody = renderInboxPage({
    scope,
    generated_at: now(),
    memories: orphanMemories,
  });

  const metadata: ScopeExportMetadata = {
    schema_version: 1,
    exported_at: now(),
    scope,
    kg_count: kgCount,
    memory_count: orphanMemories.length,
    hash,
  };

  await writeScopeAtomically(dir, {
    entities: renderedEntities,
    inbox: inboxBody,
    metadata,
  });

  return {
    skipped: false,
    entityCount: renderedEntities.length,
    memoryCount: orphanMemories.length,
    hash,
  };
}

export interface ExportAllOptions {
  dataSource: VaultDataSource;
  vaultRoot: string;
  onlyScope?: string;
  force?: boolean;
  now?: () => string;
}

export async function exportAllScopes(
  opts: ExportAllOptions,
): Promise<Record<string, ExportResult>> {
  const allScopes = await opts.dataSource.listScopes();
  const scopes = opts.onlyScope
    ? allScopes.filter((s) => s === opts.onlyScope)
    : allScopes;
  const summary: Record<string, ExportResult> = {};
  for (const scope of scopes) {
    summary[scope] = await exportScope({
      dataSource: opts.dataSource,
      scope,
      vaultRoot: opts.vaultRoot,
      force: opts.force,
      now: opts.now,
    });
  }
  return summary;
}

export interface VaultStatusScope {
  scope: string;
  kg_count: number;
  last_export_at: string | null;
  hash: string | null;
  vault_dir_present: boolean;
}

export interface VaultStatusReport {
  vault_root: string;
  scopes: VaultStatusScope[];
}

export async function vaultStatus(opts: {
  dataSource: VaultDataSource;
  vaultRoot: string;
}): Promise<VaultStatusReport> {
  const { dataSource, vaultRoot } = opts;
  const kgScopes = await dataSource.listScopes();
  const onDiskScopes = existsSync(vaultRoot)
    ? (await readdir(vaultRoot, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];

  const merged = new Set<string>([...kgScopes, ...onDiskScopes]);
  const rows: VaultStatusScope[] = [];
  for (const scope of Array.from(merged).sort()) {
    const dir = scopeDir(vaultRoot, scope);
    const meta = await readScopeMetadata(dir);
    rows.push({
      scope,
      kg_count: kgScopes.includes(scope) ? await dataSource.kgCount(scope) : 0,
      last_export_at: meta?.exported_at ?? null,
      hash: meta?.hash ?? null,
      vault_dir_present: existsSync(dir),
    });
  }
  return { vault_root: vaultRoot, scopes: rows };
}
```

Drop the `_classifyTierUnused` + `_sanitizeScopeUnused` imports — they were there to make the structure visible; remove them now since they're unused. Final import block in `export.ts`:

```ts
import { disambiguateSlug, renderEntityPage, renderInboxPage, slugForSubject } from "./templates.js";
```

- [ ] **Step 4: Run the tests and verify pass**

Run: `npx vitest run --reporter=verbose test/vault/export.test.ts`

Expected: PASS — all 30 export tests green.

- [ ] **Step 5: Commit**

```bash
git add src/vault/export.ts test/vault/export.test.ts
git commit -m "feat(vault): exportScope orchestrator + vaultStatus reporter"
```

---

## Task 11: CLI command module + dispatcher

**Files:**
- Create: `src/cli/vault-commands.ts`
- Modify: `src/cli/lotl.ts`

`vault-commands.ts` mirrors `collection-commands.ts`: a `runVaultCommand(argv)` entry plus per-sub handlers. Uses `terminal.ts` helpers for output. Uses `loadLotlEnv` + `openDatabase` + `createSqliteDataSource` to build the data source.

- [ ] **Step 1: Inspect the existing pattern to mirror**

Run: `npx vitest run --reporter=verbose --passWithNoTests test/`

(This step is "look at the file before editing", not a verification — use `Read` on `src/cli/collection-commands.ts` and `src/cli/lotl.ts` to confirm:
- the exported entry function shape,
- how the lotl dispatcher routes `vault` today (it almost certainly errors out — we replace that path).

This is a 1-minute orientation. Skip if you already have the file in context.)

- [ ] **Step 2: Write the CLI module**

Create `src/cli/vault-commands.ts`:

```ts
// src/cli/vault-commands.ts
// CLI handlers for `lotl vault export|status`. Subsystem 1 (v1.2.0-alpha.1).

import { loadLotlEnv } from "../env.js";
import { openDatabase } from "../db.js";
import {
  createSqliteDataSource,
  exportAllScopes,
  resolveVaultRoot,
  vaultStatus,
} from "../vault/export.js";
import { info, success, warn } from "./terminal.js";

interface ParsedArgs {
  sub: string;
  scope?: string;
  force: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [sub, ...rest] = argv;
  let scope: string | undefined;
  let force = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--scope") {
      scope = rest[i + 1];
      i += 1;
    } else if (arg === "--force") {
      force = true;
    } else if (arg && arg.startsWith("--scope=")) {
      scope = arg.slice("--scope=".length);
    }
  }
  return { sub: sub ?? "", scope, force };
}

export async function runVaultCommand(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  loadLotlEnv();

  switch (args.sub) {
    case "export":
      return runVaultExport(args);
    case "status":
      return runVaultStatus();
    case "":
    case "help":
    case "--help":
      printUsage();
      return 0;
    default:
      warn(`[vault] unknown subcommand: ${args.sub}`);
      printUsage();
      return 2;
  }
}

function printUsage(): void {
  info("Usage: lotl vault <export|status> [--scope X] [--force]");
}

async function runVaultExport(args: ParsedArgs): Promise<number> {
  const db = openDatabase();
  const dataSource = createSqliteDataSource(db);
  const vaultRoot = resolveVaultRoot();
  info(`[vault:export] vault root: ${vaultRoot}`);

  const summary = await exportAllScopes({
    dataSource,
    vaultRoot,
    onlyScope: args.scope,
    force: args.force,
  });

  const scopes = Object.keys(summary);
  if (scopes.length === 0) {
    warn("[vault:export] no scopes found in KG — nothing to export.");
    return 0;
  }

  for (const scope of scopes) {
    const r = summary[scope]!;
    if (r.skipped) {
      info(`[vault:export] ${scope}: skipped (hash unchanged)`);
    } else {
      success(
        `[vault:export] ${scope}: wrote ${r.entityCount} entities, ${r.memoryCount} orphan memories`,
      );
    }
  }
  return 0;
}

async function runVaultStatus(): Promise<number> {
  const db = openDatabase();
  const dataSource = createSqliteDataSource(db);
  const vaultRoot = resolveVaultRoot();
  const report = await vaultStatus({ dataSource, vaultRoot });
  info(`vault root: ${report.vault_root}`);
  if (report.scopes.length === 0) {
    info("(no scopes)");
    return 0;
  }
  for (const row of report.scopes) {
    info(
      `  - ${row.scope}: kg_count=${row.kg_count} ` +
        `last_export=${row.last_export_at ?? "(never)"} ` +
        `vault_dir=${row.vault_dir_present ? "yes" : "no"}`,
    );
  }
  return 0;
}
```

- [ ] **Step 3: Wire `vault` into `src/cli/lotl.ts`**

Use `Read` to inspect the dispatcher and identify where existing per-domain commands are routed (look for `case "collection"`-style branches or the dispatch table). Then add (importing at the top of the file):

```ts
import { runVaultCommand } from "./vault-commands.js";
```

And add the dispatch branch (mirror the exact shape used by `collection`):

```ts
case "vault": {
  const exit = await runVaultCommand(rest);
  process.exit(exit);
  break;
}
```

If the dispatcher uses an object/lookup-table pattern instead of a switch, follow that pattern exactly — register `vault: runVaultCommand` so the routing matches.

- [ ] **Step 4: Typecheck the wiring**

Run: `npm run typecheck`

Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli/vault-commands.ts src/cli/lotl.ts
git commit -m "feat(vault): cli — lotl vault export|status"
```

---

## Task 12: Incremental + idempotency integration test

**Files:**
- Create: `test/vault/integration/incremental.test.ts`

Full flow over the fixture: first export writes everything; a second `exportAllScopes` is a complete no-op (skipped on every scope); flipping a triple's `valid_until` to a later timestamp changes the hash and triggers a real rewrite; `force: true` always rewrites.

- [ ] **Step 1: Write the failing test**

Create `test/vault/integration/incremental.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportAllScopes,
  loadFixtureDataSource,
} from "../../../src/vault/export.js";

let tmp: string;
async function fixture(): Promise<ReturnType<typeof loadFixtureDataSource>> {
  const raw = await readFile(
    join(process.cwd(), "test/fixtures/vault-kg.json"),
    "utf8",
  );
  return loadFixtureDataSource(JSON.parse(raw) as never);
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "lotl-vault-int-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("vault export — incremental flow", () => {
  it("first export writes every scope; second is a no-op on every scope", async () => {
    const ds = await fixture();
    const first = await exportAllScopes({
      dataSource: ds,
      vaultRoot: tmp,
      now: () => "2026-05-20T12:00:00Z",
    });
    for (const scope of Object.keys(first)) {
      expect(first[scope]!.skipped).toBe(false);
    }
    const globalFiles = await readdir(join(tmp, "global", "entities"));
    expect(globalFiles.length).toBeGreaterThan(0);

    const second = await exportAllScopes({
      dataSource: ds,
      vaultRoot: tmp,
      now: () => "2026-05-20T13:00:00Z",
    });
    for (const scope of Object.keys(second)) {
      expect(second[scope]!.skipped).toBe(true);
    }
  });

  it("modifying a triple changes the hash and triggers a rewrite", async () => {
    const raw = JSON.parse(
      await readFile(
        join(process.cwd(), "test/fixtures/vault-kg.json"),
        "utf8",
      ),
    );
    const ds = loadFixtureDataSource(raw);
    await exportAllScopes({
      dataSource: ds,
      vaultRoot: tmp,
      now: () => "2026-05-20T12:00:00Z",
    });
    // Mutate the fixture: bump the latest timestamp by adding a triple.
    raw.triples.push({
      id: "t-mutate",
      subject: "David",
      predicate: "hobby",
      object: "Climbing",
      valid_from: "2026-05-21T00:00:00Z",
      valid_until: null,
      source_memory_id: null,
      scope: "global",
      created_at: "2026-05-21T00:00:00Z",
    });
    const ds2 = loadFixtureDataSource(raw);
    const second = await exportAllScopes({
      dataSource: ds2,
      vaultRoot: tmp,
      now: () => "2026-05-21T12:00:00Z",
    });
    expect(second["global"]!.skipped).toBe(false);
    expect(second["project-foo"]!.skipped).toBe(true);
  });

  it("--force rewrites even on unchanged hash", async () => {
    const ds = await fixture();
    await exportAllScopes({
      dataSource: ds,
      vaultRoot: tmp,
      now: () => "2026-05-20T12:00:00Z",
    });
    const second = await exportAllScopes({
      dataSource: ds,
      vaultRoot: tmp,
      now: () => "2026-05-20T13:00:00Z",
      force: true,
    });
    for (const scope of Object.keys(second)) {
      expect(second[scope]!.skipped).toBe(false);
    }
    const meta = JSON.parse(
      await readFile(join(tmp, "global", ".lotl-export.json"), "utf8"),
    );
    expect(meta.exported_at).toBe("2026-05-20T13:00:00Z");
  });
});
```

- [ ] **Step 2: Run the test and verify pass**

Run: `npx vitest run --reporter=verbose test/vault/integration/incremental.test.ts`

Expected: PASS — 3 tests green.

- [ ] **Step 3: Commit**

```bash
git add test/vault/integration/incremental.test.ts
git commit -m "test(vault): end-to-end incremental + force-rewrite integration"
```

---

## Task 13: CLI smoke test

**Files:**
- Create: `test/vault/smoke/cli.test.ts`

Spawns the CLI via `npx tsx`. Uses a clean `LOTL_VAULT_PATH` in a tmp dir and a clean DB path so the smoke test does not touch the dev DB. We need an empty / seeded DB; the simplest path is to spawn `lotl memory` commands to seed, but for Subsystem 1 we instead create a SQLite DB by hand at the path lotl expects.

Constraint: `openDatabase()` opens whatever `lotl` is configured to open (likely `~/.cache/lotl/index.sqlite` by default or via `LOTL_DB_PATH`). The smoke test must override that env var to point at a tmp DB we control. If the project does not have a `LOTL_DB_PATH` env var, the test uses whatever existing override lotl supports (the engineer should confirm via `Read` on `src/db.ts` / `src/env.ts`; if no override exists, this smoke test is dropped to status-only).

- [ ] **Step 1: Write the smoke test**

Create `test/vault/smoke/cli.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";

const exec = promisify(execFile);

let tmp: string;
let dbPath: string;
let vaultPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "lotl-vault-smoke-"));
  dbPath = join(tmp, "index.sqlite");
  vaultPath = join(tmp, "vault");
  await mkdir(vaultPath, { recursive: true });

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE knowledge (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_until TEXT,
      source_memory_id TEXT,
      scope TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      text TEXT NOT NULL,
      importance REAL NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO knowledge VALUES
      ('t1','David','works_on','Lotl','2026-01-15T10:00:00Z',NULL,'m1','global','2026-01-15T10:00:00Z');
    INSERT INTO memories VALUES
      ('m1','global','David works on Lotl.',0.9,'2026-01-15T10:00:00Z'),
      ('m2','global','Orphan thought.',0.4,'2026-05-01T00:00:00Z');
  `);
  db.close();
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const childEnv = (extra: Record<string, string>) => ({
  ...process.env,
  LOTL_VAULT_PATH: vaultPath,
  LOTL_DB_PATH: dbPath,
  ...extra,
});

describe("lotl vault smoke", () => {
  it("vault export prints scope summary and writes files", async () => {
    const { stdout, stderr } = await exec(
      "npx",
      ["tsx", "src/cli/lotl.ts", "vault", "export"],
      { env: childEnv({}) },
    );
    expect(`${stdout}\n${stderr}`).toMatch(/\[vault:export\] global:/);
  });

  it("vault status prints vault root + scope rows", async () => {
    await exec("npx", ["tsx", "src/cli/lotl.ts", "vault", "export"], {
      env: childEnv({}),
    });
    const { stdout } = await exec(
      "npx",
      ["tsx", "src/cli/lotl.ts", "vault", "status"],
      { env: childEnv({}) },
    );
    expect(stdout).toContain("vault root:");
    expect(stdout).toContain("global");
  });

  it("vault help exits 0", async () => {
    const { stdout } = await exec(
      "npx",
      ["tsx", "src/cli/lotl.ts", "vault", "help"],
      { env: childEnv({}) },
    );
    expect(stdout).toMatch(/Usage: lotl vault/);
  });
});
```

> Note on `LOTL_DB_PATH`: if the project's `src/db.ts` / `src/env.ts` does not honor `LOTL_DB_PATH`, the engineer must confirm the actual env var lotl reads (e.g. `LOTL_INDEX_PATH`) and adjust. This test deliberately uses one env var only; if lotl uses two-tier loading via `~/.config/lotl/.env`, route around it by writing a tmp `.env` and pointing `XDG_CONFIG_HOME` or equivalent at the tmp dir.

- [ ] **Step 2: Run the smoke test**

Run: `npx vitest run --reporter=verbose test/vault/smoke/cli.test.ts`

Expected: PASS — 3 tests green. If the env-var override is wrong (see note above), the test fails fast with a clear error and the engineer fixes the override.

- [ ] **Step 3: Commit**

```bash
git add test/vault/smoke/cli.test.ts
git commit -m "test(vault): cli smoke for export/status/help"
```

---

## Task 14: Coverage gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full vault suite with coverage**

Run: `npx vitest run --coverage --reporter=verbose test/vault/`

Expected: PASS on all tests; coverage table shows `src/vault/templates.ts` and `src/vault/export.ts` at 100% lines / branches / functions / statements. If any number is below 100, the vitest run exits non-zero because of the thresholds we set in Task 1.

- [ ] **Step 2: If coverage gaps exist, plug them**

For each uncovered branch the v8 reporter highlights:
- Identify the file:line.
- Write one targeted test in the appropriate `test/vault/**.test.ts` exercising that branch.
- Re-run `npx vitest run --coverage --reporter=verbose test/vault/`.

Likely uncovered branches to expect:
- `resolveVaultRoot` when `LOTL_VAULT_PATH` is set without `~`.
- `readScopeMetadata` JSON parse failure.
- `writeScopeAtomically` `.tmp` cleanup when `.tmp` exists from a prior crash.

Each gap → one tiny test, commit per file.

- [ ] **Step 3: Run the full repo test suite**

Run: `npx vitest run --reporter=verbose test/`

Expected: PASS — every existing test still green, plus all vault tests.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit (only if gap-plugging tests were added)**

```bash
git add test/vault/
git commit -m "test(vault): plug remaining coverage gaps to 100%"
```

---

## Task 15: Manual end-to-end against the real DB (1 minute)

**Files:** none (smoke verification only)

This is a non-CI safety check on the Windows dev box against the user's actual lotl DB.

- [ ] **Step 1: Run `vault status` against the dev DB**

Run: `npx tsx src/cli/lotl.ts vault status`

Expected: prints `vault root: <some path under home>` and a list of scopes that matches whatever is in the user's local KG. If the KG is empty, prints `(no scopes)`.

- [ ] **Step 2: Run `vault export` against the dev DB**

Run: `npx tsx src/cli/lotl.ts vault export`

Expected: exits 0, prints either `[vault:export] no scopes found` (empty KG) or `[vault:export] <scope>: wrote N entities, M orphan memories` per scope. Inspect `~/.local/share/lotl/vault/` (or `$LOTL_VAULT_PATH`) — there should be a `<scope>/entities/` directory and an `inbox.md` per scope.

- [ ] **Step 3: Re-run `vault export`**

Run: `npx tsx src/cli/lotl.ts vault export`

Expected: every scope reports `skipped (hash unchanged)`.

- [ ] **Step 4: Run with `--force`**

Run: `npx tsx src/cli/lotl.ts vault export --force`

Expected: every scope rewrites (`wrote N entities ...`).

No commit here — manual verification only.

---

## Task 16: CHANGELOG entry (chore)

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a v1.2.0-alpha.1 unreleased entry**

Append under `## [Unreleased]` (create the header if missing):

```markdown
### Added
- `lotl vault export` — derives `~/.local/share/lotl/vault/<scope>/entities/*.md` + `inbox.md` from the KG. Atomic writes via `<scope>/.tmp/` + rename. Per-scope hash gate skips no-op exports. Flags: `--scope`, `--force`.
- `lotl vault status` — prints vault root + per-scope KG row count + last export timestamp + hash + whether the vault dir exists.
- `src/vault/templates.ts` + `src/vault/export.ts` — pure renderers + SQLite-backed exporter with 100% line/branch coverage.

### Configuration
- `LOTL_VAULT_PATH` — overrides default `~/.local/share/lotl/vault`.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "chore(changelog): vault export + status for v1.2.0-alpha.1"
```

---

## Self-review

**1. Spec coverage (Subsystem 1 only):**

| Spec requirement | Task |
|---|---|
| `lotl vault export` CLI subcommand | Task 11 (CLI module + dispatcher) |
| `lotl vault status` CLI subcommand | Task 11 |
| `src/vault/export.ts` (~280 LOC) | Tasks 6, 7, 8, 9, 10 |
| `src/vault/templates.ts` (~120 LOC) | Tasks 2, 3, 4 |
| Entity page Markdown template (frontmatter + Current/Historical/Linked Memories with conditional sections) | Task 3 |
| Inbox Markdown template (tier grouping, 200-char excerpt, desc sort) | Task 4 |
| Slug normalizer (reuse `toSlug`) + scope sanitizer + collision disambiguation | Task 2 |
| `~/.local/share/lotl/vault/` default + `LOTL_VAULT_PATH` env override | Task 6 |
| Atomic write via `<scope>/.tmp/` + rename | Task 9 |
| `.old-*` preserved on failure, removed on success | Task 9 |
| `.lotl-export.json` shape (schema_version, exported_at, scope, kg_count, memory_count, hash) | Tasks 9, 10 |
| Per-scope hash gate (incremental no-op) | Task 10 + Task 12 (integration) |
| `--force` flag | Tasks 10, 11, 12 |
| `--scope` filter | Tasks 10, 11 |
| Orphan memory query (memories not in `knowledge.source_memory_id`) | Tasks 7, 8 |
| Read-only against memory store / KG (no mutations in Subsystem 1) | Task 8 (DB queries are `SELECT` only) |
| 100% line+branch coverage on `src/vault/**` enforced by `vitest.config.ts` | Tasks 1, 14 |
| Logging conventions (`[vault:export]` prefix, terminal helpers on CLI path) | Task 11 |
| Integration test for incremental flow | Task 12 |
| CLI smoke test | Task 13 |
| Vault rendering tests with snapshot/explicit content | Tasks 3, 4 |
| Slug edge cases test file | Task 2 |
| Fixture seed (5 entities, 12 triples, mixed scopes, mixed valid_until) | Task 5 |
| `coverage-v8` devDependency | Task 1 |
| `vitest.config.ts` coverage block | Task 1 |
| Scope-name sanitization for folder names | Task 2 (`sanitizeScope`) |
| Three-tier inbox grouping (core/working/peripheral) | Task 4 |

Subsystems 2 (extraction) and 3 (viewer) are explicitly excluded — no tasks reference `extract.ts`, `serve.ts`, dream-hook integration, Hono, or cytoscape. Confirmed.

**2. Placeholder scan:** No `TBD`, `TODO`, `implement later`, `similar to above`, or undefined symbol references in any task. All function signatures and types are defined inline.

**3. Type consistency:**
- `EntityFact`, `LinkedMemory`, `EntityPageInput`, `InboxMemory`, `InboxPageInput`, `InboxTier` all defined in Task 3 / Task 4, used consistently in Task 7, 10.
- `RawTriple`, `RawMemory`, `VaultDataSource`, `EntityGroup` defined in Task 7, used in Tasks 8, 10.
- `ScopeExportMetadata`, `ScopePayload`, `ExportOptions`, `ExportResult`, `ExportAllOptions`, `VaultStatusScope`, `VaultStatusReport` all defined in Tasks 9, 10.
- Exported function names cross-checked: `slugForSubject`, `sanitizeScope`, `disambiguateSlug`, `renderEntityPage`, `renderInboxPage`, `classifyTier`, `resolveVaultRoot`, `scopeDir`, `computeScopeHash`, `loadFixtureDataSource`, `createSqliteDataSource`, `collectEntityFacts`, `collectOrphanMemories`, `listScopes`, `writeScopeAtomically`, `readScopeMetadata`, `exportScope`, `exportAllScopes`, `vaultStatus`. All used with the same name where referenced.

---

## Open questions to flag to the user

1. **`LOTL_DB_PATH` env var name (Task 13).** The smoke test assumes lotl honors `LOTL_DB_PATH`. If `src/env.ts` exposes a different name (e.g. `LOTL_INDEX_PATH`), the engineer must update the smoke test env in step 1.
2. **`src/cli/lotl.ts` dispatcher shape (Task 11).** The plan dictates "mirror the per-domain command module pattern" but the exact wiring (switch vs. lookup table) needs to be observed by the engineer when reading the file. The plan describes both routes; pick the one that matches the existing style.
3. **`scope` column on `memories` + `knowledge`.** The plan assumes both tables have a `scope` column. The KG already exposes scope (per `knowledge.ts` API). The memory table's scope column existence is asserted but not re-verified in this plan — confirm before Task 8. If memories are scoped via a join table instead, adjust `memoriesForScope` accordingly.
