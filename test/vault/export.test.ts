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
