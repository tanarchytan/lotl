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
