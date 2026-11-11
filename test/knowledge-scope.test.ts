/**
 * Knowledge timelines are per scope: a knowledgeStore in one scope never ends,
 * bounds or is absorbed by a fact of the same subject+predicate in another.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { knowledgeStore, knowledgeAbout } from "../src/memory/knowledge.js";

const DAY = 86_400_000;

describe("knowledge timelines per scope", () => {
  let db: any;
  let tmp: string;
  let now: number;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lotl-kg-scope-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
    now = Date.now();
  });
  afterEach(() => { try { db.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); });

  const store = (object: string, scope?: string, offsetDays?: number) =>
    knowledgeStore(db, { subject: "Alex Example", predicate: "lives_in", object, ...(scope ? { scope } : {}), ...(offsetDays === undefined ? {} : { valid_from: now + offsetDays * DAY }) });
  const row = (id: string) => db.prepare(`SELECT * FROM knowledge WHERE id = ?`).get(id) as { valid_from: number; valid_until: number | null; object: string; scope: string };

  test("a store in scope B does not end the fact in scope A", () => {
    const a = store("Lisbon", "a", -30);
    const b = store("Porto", "b", -10);
    expect(b.invalidated).toEqual([]);
    expect(row(a.id).valid_until).toBeNull();
    expect(row(b.id).valid_until).toBeNull();
  });

  test("the same object in another scope is its own row, not the other scope's id", () => {
    const a = store("Lisbon", "a", -30);
    const b = store("Lisbon", "b", -10);
    expect(b.id).not.toBe(a.id);
    expect(row(b.id).scope).toBe("b");
    expect(row(a.id).valid_from).toBe(now - 30 * DAY);
  });

  test("a later fact in another scope does not bound this scope's new fact", () => {
    store("Faro", "a", 30);
    const b = store("Porto", "b", -10);
    expect(row(b.id).valid_until).toBeNull();
  });

  test("a later fact with the same object in another scope is not pulled back", () => {
    const a = store("Faro", "a", 30);
    const b = store("Faro", "b", -10);
    expect(b.id).not.toBe(a.id);
    expect(row(a.id).valid_from).toBe(now + 30 * DAY);
  });

  test("inside one scope the timeline still closes, bounds and dedups", () => {
    const lisbon = store("Lisbon", "a", -300);
    const porto = store("Porto", "a", -60);
    expect(porto.invalidated).toEqual([lisbon.id]);
    expect(row(lisbon.id).valid_until).toBe(now - 60 * DAY);
    expect(store("Porto", "a", -20).id).toBe(porto.id);
    const old = store("Braga", "a", -400);
    expect(row(old.id).valid_until).toBe(now - 300 * DAY);
  });

  test("no scope means 'global' and is its own timeline", () => {
    const g1 = store("Lisbon", undefined, -30);
    const a = store("Porto", "a", -10);
    expect(row(g1.id).scope).toBe("global");
    expect(a.invalidated).toEqual([]);
    const g2 = store("Faro", "global", -5);
    expect(g2.invalidated).toEqual([g1.id]);
    expect(row(a.id).valid_until).toBeNull();
  });

  test("knowledgeAbout still lists the in-force fact of every scope", () => {
    store("Lisbon", "a", -30);
    store("Porto", "b", -10);
    expect(knowledgeAbout(db, "Alex Example").map(r => r.object).sort()).toEqual(["Lisbon", "Porto"]);
  });
});
