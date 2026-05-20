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
