/**
 * Knowledge-graph validity windows. For one subject + predicate the facts
 * form a timeline ordered by valid_from: a fact that starts at t ends the
 * fact in force at t at t (not at the wall clock), and ends itself where the
 * next later fact starts.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { knowledgeStore, knowledgeQuery, knowledgeAbout, knowledgeInvalidate } from "../src/memory/knowledge.js";

const DAY = 86_400_000;

describe("knowledge validity windows", () => {
  let db: any;
  let tmp: string;
  let now: number;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lotl-kg-valid-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
    now = Date.now();
  });
  afterEach(() => { try { db.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); });

  const lives = (object: string, offsetDays?: number) =>
    knowledgeStore(db, { subject: "Alex Example", predicate: "lives_in", object, ...(offsetDays === undefined ? {} : { valid_from: now + offsetDays * DAY }) });
  const at = (offsetDays: number) =>
    knowledgeQuery(db, { subject: "Alex Example", predicate: "lives_in", as_of: now + offsetDays * DAY }).map(r => r.object).sort();
  const row = (id: string) => db.prepare(`SELECT * FROM knowledge WHERE id = ?`).get(id) as { valid_from: number; valid_until: number | null; object: string };

  test("backdated facts do not overlap: the old fact ends where the new one starts", () => {
    const lisbon = lives("Lisbon", -300);
    const porto = lives("Porto", -60);
    expect(porto.invalidated).toEqual([lisbon.id]);
    expect(row(lisbon.id).valid_until).toBe(now - 60 * DAY);
    expect(at(-30)).toEqual(["Porto"]);
    expect(at(-100)).toEqual(["Lisbon"]);
    expect(at(-400)).toEqual([]);
  });

  test("a future-dated fact leaves the current one in force until it starts", () => {
    lives("Lisbon", -300);
    const porto = lives("Porto", -60);
    const faro = lives("Faro", 30);
    expect(faro.invalidated).toEqual([porto.id]);
    expect(row(porto.id).valid_until).toBe(now + 30 * DAY);
    expect(at(10)).toEqual(["Porto"]);
    expect(at(0)).toEqual(["Porto"]);
    expect(at(40)).toEqual(["Faro"]);
    expect(row(faro.id).valid_until).toBeNull();
  });

  test("a fact older than the existing ones ends where the earliest later fact starts", () => {
    const porto = lives("Porto", -60);
    const lisbon = lives("Lisbon", -300);
    expect(lisbon.invalidated).toEqual([]);
    expect(row(lisbon.id).valid_until).toBe(now - 60 * DAY);
    expect(row(porto.id).valid_until).toBeNull();
    expect(at(-100)).toEqual(["Lisbon"]);
    expect(at(-30)).toEqual(["Porto"]);
  });

  test("a fact inserted between two facts splits the earlier one", () => {
    const lisbon = lives("Lisbon", -300);
    const faro = lives("Faro", -10);
    const porto = lives("Porto", -60);
    expect(porto.invalidated).toEqual([lisbon.id]);
    expect(row(lisbon.id).valid_until).toBe(now - 60 * DAY);
    expect(row(porto.id).valid_until).toBe(now - 10 * DAY);
    expect(row(faro.id).valid_until).toBeNull();
    expect(at(-100)).toEqual(["Lisbon"]);
    expect(at(-30)).toEqual(["Porto"]);
    expect(at(-1)).toEqual(["Faro"]);
  });

  test("default valid_from is now: the previous fact ends now (unchanged)", () => {
    const a = lives("Lisbon");
    const b = lives("Porto");
    expect(b.invalidated).toEqual([a.id]);
    const ra = row(a.id);
    expect(ra.valid_until).toBe(row(b.id).valid_from);
    expect(row(b.id).valid_until).toBeNull();
  });

  test("a fact added now before a future-dated one ends where the future one starts", () => {
    const porto = lives("Porto", -60);
    const faro = lives("Faro", 30);
    const braga = lives("Braga");
    expect(braga.invalidated).toEqual([porto.id]);
    expect(row(braga.id).valid_until).toBe(now + 30 * DAY);
    expect(row(faro.id).valid_until).toBeNull();
    expect(at(10)).toEqual(["Braga"]);
    expect(at(40)).toEqual(["Faro"]);
  });

  test("asserting the object already in force returns the existing fact", () => {
    const porto = lives("Porto", -60);
    expect(lives("Porto")).toEqual({ id: porto.id, invalidated: [] });
    expect(lives("Porto", -30)).toEqual({ id: porto.id, invalidated: [] });
    expect((db.prepare(`SELECT count(*) AS n FROM knowledge`).get() as { n: number }).n).toBe(1);
  });

  test("asserting the next fact's object earlier extends that fact back instead of adding a copy", () => {
    const lisbon = lives("Lisbon", -300);
    const porto = lives("Porto", -60);
    const again = lives("Porto", -100);
    expect(again).toEqual({ id: porto.id, invalidated: [lisbon.id] });
    expect(row(porto.id).valid_from).toBe(now - 100 * DAY);
    expect(row(lisbon.id).valid_until).toBe(now - 100 * DAY);
    expect((db.prepare(`SELECT count(*) AS n FROM knowledge`).get() as { n: number }).n).toBe(2);
    expect(at(-80)).toEqual(["Porto"]);
  });

  test("an object that held before is a new fact when asserted again later", () => {
    const lisbon = lives("Lisbon", -300);
    const porto = lives("Porto", -60);
    const back = lives("Lisbon", -5);
    expect(back.id).not.toBe(lisbon.id);
    expect(back.invalidated).toEqual([porto.id]);
    expect(at(-100)).toEqual(["Lisbon"]);
    expect(at(-30)).toEqual(["Porto"]);
    expect(at(-1)).toEqual(["Lisbon"]);
  });

  test("an explicitly invalidated fact is not reopened or cut by a later fact", () => {
    const lisbon = lives("Lisbon", -300);
    expect(knowledgeInvalidate(db, lisbon.id).invalidated).toBe(true);
    const ended = row(lisbon.id).valid_until!;
    const porto = lives("Porto", 10);
    expect(porto.invalidated).toEqual([]);
    expect(row(lisbon.id).valid_until).toBe(ended);
  });

  test("other subjects and predicates are untouched", () => {
    const a = lives("Lisbon", -300);
    knowledgeStore(db, { subject: "Alex Example", predicate: "works_at", object: "Acme", valid_from: now - 50 * DAY });
    knowledgeStore(db, { subject: "Sam Example", predicate: "lives_in", object: "Porto", valid_from: now - 50 * DAY });
    expect(row(a.id).valid_until).toBeNull();
  });

  test("knowledgeAbout lists the facts in force now, not future-dated ones", () => {
    lives("Porto", -60);
    lives("Faro", 30);
    knowledgeStore(db, { subject: "Alex Example", predicate: "works_at", object: "Acme", valid_from: now - 5 * DAY });
    const about = knowledgeAbout(db, "Alex Example").map(f => `${f.predicate}=${f.object}`);
    expect(about).toEqual(["lives_in=Porto", "works_at=Acme"]);
  });

  test("knowledgeInvalidate ends a fact that is in force now but already has a future end", () => {
    const porto = lives("Porto", -60);
    lives("Faro", 30);
    expect(knowledgeInvalidate(db, porto.id).invalidated).toBe(true);
    expect(row(porto.id).valid_until!).toBeLessThanOrEqual(Date.now());
    expect(at(10)).toEqual([]);
    expect(knowledgeInvalidate(db, porto.id).invalidated).toBe(false);
  });

  test("rows written before the fix keep their overlap (not migrated)", () => {
    // Shape the old code produced: Lisbon closed at the wall clock although
    // Porto was backdated to -60d.
    db.prepare(`INSERT INTO knowledge (id, subject, predicate, object, valid_from, valid_until, confidence, created_at, scope)
                VALUES ('old-1', 'alex_example', 'lives_in', 'Lisbon', ?, ?, 1, ?, 'global')`).run(now - 300 * DAY, now - DAY, now - DAY);
    db.prepare(`INSERT INTO knowledge (id, subject, predicate, object, valid_from, valid_until, confidence, created_at, scope)
                VALUES ('old-2', 'alex_example', 'lives_in', 'Porto', ?, NULL, 1, ?, 'global')`).run(now - 60 * DAY, now - DAY);
    expect(at(-30)).toEqual(["Lisbon", "Porto"]);
    // A new fact only ends the one in force at its start (latest valid_from).
    const faro = lives("Faro", 30);
    expect(faro.invalidated).toEqual(["old-2"]);
    expect(at(40)).toEqual(["Faro"]);
  });
});
