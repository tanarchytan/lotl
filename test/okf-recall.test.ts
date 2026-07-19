import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { okfRecall } from "../src/okf/recall.js";

describe("okfRecall", () => {
  let db: any, tmp: string;
  const store = () => ({ db, searchFTS: () => [] });
  const insertMem = (id: string, text: string) =>
    db.prepare(`INSERT INTO memories (id,text,content_hash,category,scope,importance,tier,access_count,created_at,last_accessed)
                VALUES (?,?,?, 'fact','global',0.5,'peripheral',0,?,?)`).run(id, text, id, Date.now(), Date.now());
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "lotl-okf-recall-")); db = openDatabase(join(tmp, "t.sqlite")); initializeDatabase(db); });
  afterEach(() => { try { db.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); });

  test("returns index refs, never bodies, capped", async () => {
    for (let i = 0; i < 20; i++) insertMem(`id${i}pad0000`, `widget fact number ${i}`);
    const refs = await okfRecall(store(), "widget", { limit: 5 });
    expect(refs.length).toBeLessThanOrEqual(5);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      expect(r.id.startsWith("memory/global/")).toBe(true);
      expect((r as any).body).toBeUndefined();
    }
  });
});
