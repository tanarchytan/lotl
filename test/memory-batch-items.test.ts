/**
 * memoryStoreBatch matches memoryStore item by item:
 *  - the OKF write-time budget compacts an over-budget item on write, through
 *    the same code as memoryStore (body in text, full text in
 *    metadata.original, description, draft for a heuristic compaction);
 *  - a bad item (empty, or empty after <private> redaction) is reported as
 *    that item's error and the rest of the batch is stored.
 * No embedding provider: FTS-only storage.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { memoryStore, memoryStoreBatch, importMemories } from "../src/memory/index.js";
import { contentHash } from "../src/memory/hash.js";
import { heuristicCompact } from "../src/okf/budget.js";

const LONG = ["release checklist for the mobile app", ...Array.from({ length: 10 }, (_, k) => `step ${k}: verify build artefact ${k} and sign it`)]
  .join("\n") + "\n" + "notes ".repeat(120).trim();

describe("memoryStoreBatch per item", () => {
  let tmp: string;
  let db: any;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = { onnx: process.env.LOTL_ONNX, backend: process.env.LOTL_EMBED_BACKEND, okf: process.env.LOTL_OKF };
    delete process.env.LOTL_ONNX;
    delete process.env.LOTL_EMBED_BACKEND;
    process.env.LOTL_OKF = "on";
    tmp = mkdtempSync(join(tmpdir(), "lotl-batch-items-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    for (const [k, env] of [["onnx", "LOTL_ONNX"], ["backend", "LOTL_EMBED_BACKEND"], ["okf", "LOTL_OKF"]] as const) {
      if (saved[k] === undefined) delete process.env[env]; else process.env[env] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  const rowOf = (id: string) => {
    const r = db.prepare(`SELECT text, content_hash, scope, metadata FROM memories WHERE id = ?`).get(id) as { text: string; content_hash: string; scope: string; metadata: string };
    return { ...r, meta: JSON.parse(r.metadata) };
  };
  const count = () => (db.prepare(`SELECT count(*) AS n FROM memories`).get() as { n: number }).n;

  describe("OKF write-time budget", () => {
    test("an over-budget item is compacted on write, exactly as memoryStore does it", async () => {
      const [b] = await memoryStoreBatch(db, [{ text: LONG, scope: "batch" }]);
      const s = await memoryStore(db, { text: LONG, scope: "single" });
      const fromBatch = rowOf(b!.id);
      const fromSingle = rowOf(s.id);
      expect(fromBatch.text).toBe(heuristicCompact(LONG).body);
      expect(fromBatch.meta.original).toBe(LONG);
      expect(fromBatch.meta.status).toBe("draft");
      expect(fromBatch.content_hash).toBe(contentHash(LONG));
      expect({ text: fromBatch.text, hash: fromBatch.content_hash, meta: fromBatch.meta })
        .toEqual({ text: fromSingle.text, hash: fromSingle.content_hash, meta: fromSingle.meta });
    });

    test("batch and single store dedup each other on the full text", async () => {
      const [b] = await memoryStoreBatch(db, [{ text: LONG }]);
      expect(await memoryStore(db, { text: LONG })).toEqual({ id: b!.id, status: "duplicate", duplicate_id: b!.id });
      const [again] = await memoryStoreBatch(db, [{ text: LONG }]);
      expect(again).toEqual({ id: b!.id, status: "duplicate" });
    });

    test("LOTL_OKF=off stores the item whole", async () => {
      process.env.LOTL_OKF = "off";
      const [b] = await memoryStoreBatch(db, [{ text: LONG }]);
      expect(rowOf(b!.id).text).toBe(LONG);
      expect(rowOf(b!.id).meta.original).toBeUndefined();
    });

    test("an item that already carries metadata.original (an imported compacted row) is not compacted again", async () => {
      const body = "release checklist for the mobile app, compacted";
      const [b] = await memoryStoreBatch(db, [{ text: body, metadata: { original: LONG, description: "d" } }]);
      const r = rowOf(b!.id);
      expect(r.text).toBe(body);
      expect(r.meta.original).toBe(LONG);
    });

    test("chunked items are stored as chunks, not compacted", async () => {
      const doc = Array.from({ length: 60 }, (_, k) => `paragraph ${k} of the design document covers module ${k}.`).join("\n");
      const [b] = await memoryStoreBatch(db, [{ text: doc, chunk: true }]);
      const rows = db.prepare(`SELECT text, metadata FROM memories`).all() as { text: string; metadata: string }[];
      expect(rows.length).toBeGreaterThan(1);
      for (const r of rows) expect(JSON.parse(r.metadata).original).toBeUndefined();
      expect(b!.status).toBe("created");
    });
  });

  describe("bad items", () => {
    test("a whitespace-only item is an error for that item; the rest is stored", async () => {
      const res = await memoryStoreBatch(db, [
        { text: "first good item about the deploy window" },
        { text: "   \n " },
        { text: "second good item about the deploy window" },
      ]);
      expect(res[1]).toEqual({ id: "", status: "error", error: "Memory text cannot be empty" });
      expect(res[0]!.status).toBe("created");
      expect(res[2]!.status).toBe("created");
      expect(count()).toBe(2);
    });

    test("an item with neither text nor turns is an error", async () => {
      const res = await memoryStoreBatch(db, [{ category: "fact" }, { text: "kept item" }]);
      expect(res[0]).toEqual({ id: "", status: "error", error: "Memory text cannot be empty" });
      expect(res[1]!.status).toBe("created");
    });

    test("an item that is empty after <private> redaction is an error; the rest is stored", async () => {
      const res = await memoryStoreBatch(db, [
        { text: "kept item one" },
        { text: "<private>nothing survives</private>" },
        { text: "kept item two" },
      ]);
      expect(res[1]).toEqual({ id: "", status: "error", error: "Memory text is empty after redacting <private> content" });
      expect(res.filter(r => r.status === "created")).toHaveLength(2);
      expect(count()).toBe(2);
    });

    test("a batch of only bad items stores nothing and does not throw", async () => {
      const res = await memoryStoreBatch(db, [{ text: "" }, { text: "<private>x</private>" }]);
      expect(res.map(r => r.status)).toEqual(["error", "error"]);
      expect(count()).toBe(0);
    });

    test("importMemories counts bad items as errors and imports the rest", async () => {
      const file = join(tmp, "export.json");
      writeFileSync(file, JSON.stringify([
        { text: "imported item one", category: "fact", scope: "global", importance: 0.5, created_at: 1 },
        { text: "  ", category: "fact", scope: "global", importance: 0.5, created_at: 1 },
        { text: "imported item two", category: "fact", scope: "global", importance: 0.5, created_at: 1 },
      ]));
      expect(await importMemories(db, file)).toEqual({ imported: 2, duplicates: 0, errors: 1 });
      expect(count()).toBe(2);
    });
  });
});
