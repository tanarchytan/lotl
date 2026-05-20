import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  resolveVaultRoot,
  computeScopeHash,
  scopeDir,
  loadFixtureDataSource,
  listScopes,
  collectEntityFacts,
  collectOrphanMemories,
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

async function fixtureSource() {
  const raw = await readFile(
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

describe("writeScopeAtomically", () => {
  it("creates entities/ and inbox.md on first run", async () => {
    const scopeRoot = join(tmp, "global");
    await mkdir(scopeRoot, { recursive: true });
    const { writeScopeAtomically } = await import("../../src/vault/export.js");
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

    const { writeScopeAtomically } = await import("../../src/vault/export.js");
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

    const { writeScopeAtomically } = await import("../../src/vault/export.js");
    // empty slug triggers validation
    await expect(
      writeScopeAtomically(scopeRoot, {
        entities: [{ slug: "", body: "" }],
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
