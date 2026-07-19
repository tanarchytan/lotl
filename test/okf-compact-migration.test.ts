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
