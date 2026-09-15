import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { okfTimeline } from "../src/okf/timeline.js";
import { buildMemoryId } from "../src/okf/concept.js";
import { knowledgeStore } from "../src/memory/knowledge.js";

describe("okfTimeline", () => {
  let db: any, tmp: string;
  const base = 1_700_000_000_000;

  const insertMem = (id: string, text: string, createdAt: number, scope = "global") =>
    db.prepare(`INSERT INTO memories (id,text,content_hash,category,scope,importance,tier,access_count,created_at,last_accessed)
                VALUES (?,?,?, 'fact',?,0.5,'peripheral',0,?,?)`).run(id, text, id, scope, createdAt, createdAt);

  const seedSeven = () => {
    for (let i = 0; i < 7; i++) insertMem(`m${i}pad0000`, `memory number ${i}`, base + i * 1000);
  };

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "lotl-okf-timeline-")); db = openDatabase(join(tmp, "t.sqlite")); initializeDatabase(db); });
  afterEach(() => { try { db.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); });

  test("anchor with neighbours on both sides", () => {
    seedSeven();
    const anchorId = buildMemoryId("global", "m3pad0000");
    const refs = okfTimeline(db, anchorId)!;
    expect(refs).not.toBeNull();
    expect(refs.length).toBe(7); // anchor + 3 before + 3 after

    const anchorRef = refs.find(r => r.id === anchorId)!;
    expect(anchorRef.description).toMatch(/^\[anchor\]/);

    const beforeExpected = [["m2pad0000", "T-1"], ["m1pad0000", "T-2"], ["m0pad0000", "T-3"]] as const;
    const afterExpected = [["m4pad0000", "T+1"], ["m5pad0000", "T+2"], ["m6pad0000", "T+3"]] as const;
    for (const [rawId, marker] of [...beforeExpected, ...afterExpected]) {
      const ref = refs.find(r => r.id === buildMemoryId("global", rawId));
      expect(ref, `expected ${rawId} in results`).toBeDefined();
      expect(ref!.description).toContain(`[${marker}]`);
      expect((ref as any).body).toBeUndefined();
    }
  });

  test("anchor at start of scope has no before-neighbours", () => {
    seedSeven();
    const anchorId = buildMemoryId("global", "m0pad0000");
    const refs = okfTimeline(db, anchorId)!;
    expect(refs.some(r => r.description.includes("[T-1]"))).toBe(false);
    expect(refs.some(r => r.description.includes("[T+1]"))).toBe(true);
    expect(refs.some(r => r.description.includes("[T+3]"))).toBe(true);
  });

  test("anchor at end of scope has no after-neighbours", () => {
    seedSeven();
    const anchorId = buildMemoryId("global", "m6pad0000");
    const refs = okfTimeline(db, anchorId)!;
    expect(refs.some(r => r.description.includes("[T+1]"))).toBe(false);
    expect(refs.some(r => r.description.includes("[T-1]"))).toBe(true);
    expect(refs.some(r => r.description.includes("[T-3]"))).toBe(true);
  });

  test("unknown or malformed id returns null, never throws", () => {
    seedSeven();
    expect(okfTimeline(db, buildMemoryId("global", "deadbeef"))).toBeNull();
    expect(okfTimeline(db, "docs/some/path")).toBeNull();
    expect(() => okfTimeline(db, "not-a-valid-id")).not.toThrow();
    expect(okfTimeline(db, "not-a-valid-id")).toBeNull();
  });

  test("scopes neighbours to the anchor's scope only", () => {
    seedSeven();
    insertMem("xother00", "other scope memory", base + 3500, "other-scope");
    const anchorId = buildMemoryId("global", "m3pad0000");
    const refs = okfTimeline(db, anchorId)!;
    expect(refs.some(r => r.id.startsWith("memory/other-scope/"))).toBe(false);
  });

  test("includes knowledge-graph facts valid at the anchor's timestamp", () => {
    seedSeven();
    const anchorTime = base + 3000; // m3's created_at
    knowledgeStore(db, { subject: "acme", predicate: "status", object: "active", valid_from: anchorTime - 500, scope: "global" });
    const anchorId = buildMemoryId("global", "m3pad0000");
    const refs = okfTimeline(db, anchorId)!;
    const fact = refs.find(r => r.id === "entities/acme");
    expect(fact).toBeDefined();
    expect(fact!.description).toContain("[fact]");
    expect(fact!.description).toContain("status active");
  });

  test("respects the byte cap and never returns full bodies", () => {
    const rawId = (i: number) => `z${i}pad000`; // unique in the first 8 chars for i in [0,25)
    for (let i = 0; i < 25; i++) insertMem(rawId(i), `memory ${i} `.repeat(30), base + i * 1000);
    const anchorId = buildMemoryId("global", rawId(12));
    const refs = okfTimeline(db, anchorId, { window: 10 })!;
    expect(refs).not.toBeNull();
    expect(refs.length).toBeLessThan(21); // anchor + 10 + 10 candidates, cap should trim it
    const totalBytes = refs.reduce((n, r) => n + Buffer.byteLength(`${r.title}${r.description}${r.id}`), 0);
    expect(totalBytes).toBeLessThanOrEqual(2000);
    for (const r of refs) expect((r as any).body).toBeUndefined();
  });
});
