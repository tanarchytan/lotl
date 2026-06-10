/**
 * memory-batch-degrade.test.ts — memoryStoreBatch must store FTS-only when
 * there are no embeddings (no vec table), instead of throwing.
 *
 * Regression: the batch path prepared `INSERT INTO memories_vec ...`
 * unconditionally. With embeddings off (LOTL_ONNX unset / no provider /
 * never embedded) the table doesn't exist, and db.prepare() throws at prepare
 * time ("no such table: memories_vec") — crashing the whole batch, while single
 * memoryStore degraded to FTS-only. This surfaced when the auto-memory Stop
 * hook fired against an un-embedded index. Now the batch guards the vec insert.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { memoryStoreBatch } from "../src/memory/index.js";

describe("memoryStoreBatch — graceful degrade without embeddings", () => {
  let db: ReturnType<typeof openDatabase>;
  let tmpDir: string;
  let savedOnnx: string | undefined;
  let savedBackend: string | undefined;

  beforeEach(() => {
    savedOnnx = process.env.LOTL_ONNX;
    savedBackend = process.env.LOTL_EMBED_BACKEND;
    delete process.env.LOTL_ONNX;
    delete process.env.LOTL_EMBED_BACKEND;
    tmpDir = mkdtempSync(join(tmpdir(), "lotl-batch-degrade-"));
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

  test("stores all items via FTS when no vec table exists (no throw)", async () => {
    const res = await memoryStoreBatch(db, [
      { text: "Production database is Postgres 16 with streaming replication" },
      { text: "Deploys roll back to the previous git tag" },
    ]);

    expect(res).toHaveLength(2);
    expect(res.every((r) => r.status === "created")).toBe(true);

    const { c } = db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
    expect(c).toBe(2);

    // No embeddings → memories_vec must never have been created.
    const vec = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_vec'")
      .get();
    expect(vec).toBeUndefined();
  });

  test("the stored memories are recallable via FTS", async () => {
    await memoryStoreBatch(db, [{ text: "The release pipeline publishes to npm on version tags" }]);
    const hit = db
      .prepare("SELECT text FROM memories WHERE text LIKE ?")
      .get("%release pipeline%") as { text: string } | undefined;
    expect(hit?.text).toContain("release pipeline");
  });
});
