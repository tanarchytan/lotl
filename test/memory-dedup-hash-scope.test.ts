/**
 * Exact-hash dedup stays inside the store's scope, like cosine dedup: a
 * memory stored in one scope is never answered as a duplicate of the same
 * text in another scope, or a scoped recall would never find it. Covers the
 * single store, the batch store and import. No embedding provider: the
 * exact-hash path alone decides.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { memoryStore, memoryStoreBatch, importMemories } from "../src/memory/index.js";

const TEXT = "The staging database is restored from the Sunday snapshot.";

describe("exact-hash dedup is per scope", () => {
  let tmp: string;
  let db: any;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = { onnx: process.env.LOTL_ONNX, backend: process.env.LOTL_EMBED_BACKEND };
    delete process.env.LOTL_ONNX;
    delete process.env.LOTL_EMBED_BACKEND;
    tmp = mkdtempSync(join(tmpdir(), "lotl-hash-scope-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    if (saved.onnx === undefined) delete process.env.LOTL_ONNX; else process.env.LOTL_ONNX = saved.onnx;
    if (saved.backend === undefined) delete process.env.LOTL_EMBED_BACKEND; else process.env.LOTL_EMBED_BACKEND = saved.backend;
    rmSync(tmp, { recursive: true, force: true });
  });

  const rows = () => db.prepare(`SELECT scope, access_count FROM memories ORDER BY scope`).all() as { scope: string; access_count: number }[];

  test("memoryStore: same text in another scope is stored, same scope is a duplicate", async () => {
    const a = await memoryStore(db, { text: TEXT, scope: "proj-a" });
    const b = await memoryStore(db, { text: TEXT, scope: "proj-b" });
    expect(b.status).toBe("created");
    expect(b.id).not.toBe(a.id);
    const again = await memoryStore(db, { text: TEXT, scope: "proj-a" });
    expect(again).toEqual({ id: a.id, status: "duplicate", duplicate_id: a.id });
    // The other scope's row was not touched by either dedup.
    expect(rows()).toEqual([{ scope: "proj-a", access_count: 1 }, { scope: "proj-b", access_count: 0 }]);
  });

  test("memoryStore without a scope dedups against global only", async () => {
    await memoryStore(db, { text: TEXT, scope: "proj-a" });
    expect((await memoryStore(db, { text: TEXT })).status).toBe("created");
    expect((await memoryStore(db, { text: TEXT, scope: "global" })).status).toBe("duplicate");
  });

  test("memoryStoreBatch: lookup against stored rows is per scope", async () => {
    const a = await memoryStore(db, { text: TEXT, scope: "proj-a" });
    const res = await memoryStoreBatch(db, [
      { text: TEXT, scope: "proj-b" },
      { text: TEXT, scope: "proj-a" },
    ]);
    expect(res[0]!.status).toBe("created");
    expect(res[1]).toEqual({ id: a.id, status: "duplicate" });
    expect(rows()).toEqual([{ scope: "proj-a", access_count: 1 }, { scope: "proj-b", access_count: 0 }]);
  });

  test("memoryStoreBatch: a text repeated inside one batch is one row per scope", async () => {
    const res = await memoryStoreBatch(db, [
      { text: TEXT, scope: "proj-a" },
      { text: TEXT, scope: "proj-b" },
      { text: `  ${TEXT}  `, scope: "proj-a" },
    ]);
    expect(res.map(r => r.status)).toEqual(["created", "created", "duplicate"]);
    expect(res[2]!.id).toBe(res[0]!.id);
    expect(res[1]!.id).not.toBe(res[0]!.id);
    expect(rows().map(r => r.scope)).toEqual(["proj-a", "proj-b"]);
  });

  test("importMemories keeps the same text in two scopes", async () => {
    await memoryStore(db, { text: TEXT, scope: "proj-a" });
    const file = join(tmp, "export.json");
    writeFileSync(file, JSON.stringify([
      { text: TEXT, category: "fact", scope: "proj-a", importance: 0.5, created_at: 1 },
      { text: TEXT, category: "fact", scope: "proj-b", importance: 0.5, created_at: 1 },
    ]));
    const r = await importMemories(db, file);
    expect(r.imported).toBe(1);
    expect(r.duplicates).toBe(1);
    expect(rows().map(r => r.scope)).toEqual(["proj-a", "proj-b"]);
  });
});
