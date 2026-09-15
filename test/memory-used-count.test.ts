/**
 * used_count separates "a memory was opened in full" from access_count's
 * "a memory was surfaced in a result set". access_count must keep its exact
 * old meaning: it is the sole Weibull decay input and its tunables were
 * validated at n=500 on LongMemEval.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { memoryStore, memoryMarkUsed, memoryStats } from "../src/memory/index.js";

describe("used_count vs access_count", () => {
  let db: any, tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lotl-used-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
  });
  afterEach(() => {
    try { db.close(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  const store = (text: string) => memoryStore(db, { text, scope: "global" });
  const row = (id: string) => db.prepare(`SELECT access_count, used_count, last_accessed FROM memories WHERE id = ?`).get(id) as any;

  test("a fresh memory starts unused", async () => {
    const res = await store("Redis listens on 6380 in staging.");
    expect(row((res as any).id).used_count).toBe(0);
  });

  test("marking used increments only used_count", async () => {
    const res = await store("The deploy key lives in 1Password.");
    const before = row((res as any).id);
    memoryMarkUsed(db, (res as any).id);
    const after = row((res as any).id);
    expect(after.used_count).toBe(1);
    expect(after.access_count).toBe(before.access_count);
    expect(after.last_accessed).toBe(before.last_accessed);
  });

  test("uses accumulate", async () => {
    const res = await store("Staging resets every Sunday at 03:00.");
    memoryMarkUsed(db, (res as any).id);
    memoryMarkUsed(db, (res as any).id);
    memoryMarkUsed(db, (res as any).id);
    expect(row((res as any).id).used_count).toBe(3);
  });

  test("stats separate recalled from opened", async () => {
    const opened = await store("Opened memory.");
    await store("Surfaced but never opened.");
    // Simulate a recall touch on both, then open only one.
    db.prepare(`UPDATE memories SET access_count = access_count + 1`).run();
    memoryMarkUsed(db, (opened as any).id);

    const stats = memoryStats(db);
    expect(stats.usage.recalled).toBe(2);
    expect(stats.usage.used).toBe(1);
    expect(stats.usage.recalledNeverUsed).toBe(1);
  });

  test("the column is added to a pre-existing database in place", () => {
    db.exec(`ALTER TABLE memories DROP COLUMN used_count`);
    expect((db.prepare(`PRAGMA table_info(memories)`).all() as any[]).some(c => c.name === "used_count")).toBe(false);
    initializeDatabase(db);
    expect((db.prepare(`PRAGMA table_info(memories)`).all() as any[]).some(c => c.name === "used_count")).toBe(true);
  });
});
