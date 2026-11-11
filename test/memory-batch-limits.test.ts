/**
 * memory-batch-limits.test.ts: memoryStoreBatch (MCP memory_add_batch) on
 * large batches and repeated texts.
 *
 * Regressions found by the 2026-11-10 install stress test:
 *  - A batch of 4096+ items failed as a whole with "too many SQL variables":
 *    the hash lookup and the multi-VALUES INSERT bound every row in one
 *    statement (8 params per row, SQLite caps bound params at 32766).
 *  - The same text twice in one batch was stored twice: hash dedup only
 *    checked rows already in the table, not earlier items of the batch.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { memoryStoreBatch } from "../src/memory/index.js";

describe("memoryStoreBatch limits", () => {
  let db: ReturnType<typeof openDatabase>;
  let tmpDir: string;
  let savedOnnx: string | undefined;
  let savedBackend: string | undefined;

  beforeEach(() => {
    savedOnnx = process.env.LOTL_ONNX;
    savedBackend = process.env.LOTL_EMBED_BACKEND;
    delete process.env.LOTL_ONNX;
    delete process.env.LOTL_EMBED_BACKEND;
    tmpDir = mkdtempSync(join(tmpdir(), "lotl-batch-limits-"));
    db = openDatabase(join(tmpDir, "t.sqlite"));
    initializeDatabase(db);
  });

  afterEach(() => {
    if (savedOnnx === undefined) delete process.env.LOTL_ONNX;
    else process.env.LOTL_ONNX = savedOnnx;
    if (savedBackend === undefined) delete process.env.LOTL_EMBED_BACKEND;
    else process.env.LOTL_EMBED_BACKEND = savedBackend;
    try { db.close(); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const count = () => (db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;

  test("stores a 5000-item batch (over the 4095-row bound-parameter ceiling)", async () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({ text: `bulk memory number ${i}`, category: "other" as const }));
    const res = await memoryStoreBatch(db, items);
    expect(res).toHaveLength(5000);
    expect(res.every((r) => r.status === "created" && r.id)).toBe(true);
    expect(count()).toBe(5000);
    const hist = db.prepare("SELECT COUNT(*) AS c FROM memory_history").get() as { c: number };
    expect(hist.c).toBe(5000);

    // Re-sending the same 5000 is all duplicates, resolved through the sliced lookup.
    const again = await memoryStoreBatch(db, items);
    expect(again.every((r, i) => r.status === "duplicate" && r.id === res[i]!.id)).toBe(true);
    expect(count()).toBe(5000);
  });

  test("a text repeated inside one batch is stored once", async () => {
    const res = await memoryStoreBatch(db, [
      { text: "deploys roll back to the previous tag" },
      { text: "something else entirely" },
      { text: "  deploys roll back to the previous tag  " },
    ]);
    expect(res.map((r) => r.status)).toEqual(["created", "created", "duplicate"]);
    expect(res[2]!.id).toBe(res[0]!.id);
    expect(count()).toBe(2);
    // Same as storing it twice one by one: the kept row is touched once.
    const row = db.prepare("SELECT access_count FROM memories WHERE id = ?").get(res[0]!.id) as { access_count: number };
    expect(row.access_count).toBe(1);
  });
});
