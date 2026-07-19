import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { SqliteConceptSource } from "../src/okf/source.js";

describe("SqliteConceptSource", () => {
  let db: any, tmp: string;
  const insertMem = (id: string, text: string, category = "fact", scope = "global") =>
    db.prepare(`INSERT INTO memories (id,text,content_hash,category,scope,importance,tier,access_count,created_at,last_accessed)
                VALUES (?,?,?,?,?,?, 'peripheral',0,?,?)`).run(id, text, id, category, scope, 0.5, Date.now(), Date.now());
  const insertDoc = (collection: string, path: string, title: string, body: string) => {
    db.prepare(`INSERT OR IGNORE INTO store_collections (name,path,pattern,include_by_default) VALUES (?,?, '**/*.md',1)`).run(collection, "/tmp/" + collection);
    const hash = `${collection}:${path}`;
    db.prepare(`INSERT OR IGNORE INTO content (hash,doc,created_at) VALUES (?,?,?)`).run(hash, body, "2026-01-01");
    db.prepare(`INSERT INTO documents (collection,path,title,hash,created_at,modified_at,active) VALUES (?,?,?,?,?,?,1)`)
      .run(collection, path, title, hash, "2026-01-01", "2026-01-01");
  };
  const insertKnowledge = (subject: string, predicate: string, object: string) =>
    db.prepare(`INSERT INTO knowledge (id,subject,predicate,object,confidence,created_at,scope) VALUES (?,?,?,?,1.0,?, 'global')`)
      .run(`${subject}-${predicate}`, subject, predicate, object, Date.now());

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lotl-okf-src-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
  });
  afterEach(() => { try { db.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); });

  test("lists memory scope groups with counts", () => {
    insertMem("a1b2c3d4aa", "alpha fact one", "fact", "global");
    insertMem("b2c3d4e5bb", "beta decision", "decision", "projX");
    const src = new SqliteConceptSource(db);
    const groups = src.listGroups();
    const mem = groups.filter(g => g.type === "Memory scope").map(g => g.path).sort();
    expect(mem).toEqual(["memory/global", "memory/projX"]);
    expect(groups.find(g => g.path === "memory/global")!.count).toBe(1);
  });

  test("lists memory refs without bodies, description = first line", () => {
    insertMem("a1b2c3d4aa", "alpha fact one\nsecond line", "fact", "global");
    const src = new SqliteConceptSource(db);
    const { refs, total } = src.listConcepts("memory/global");
    expect(total).toBe(1);
    expect(refs[0]).toMatchObject({ id: "memory/global/a1b2c3d4", type: "Fact", description: "alpha fact one" });
    expect((refs[0] as any).body).toBeUndefined();
  });

  test("gets a memory concept with body, resolves 8-char id, null on miss", () => {
    insertMem("a1b2c3d4aa", "alpha fact one", "fact", "global");
    const src = new SqliteConceptSource(db);
    const c = src.getConcept("memory/global/a1b2c3d4");
    expect(c?.body).toContain("alpha fact one");
    expect(c?.type).toBe("Fact");
    expect(src.getConcept("memory/global/zzzzzzzz")).toBeNull();
  });

  test("lists doc groups + refs and gets a doc concept", () => {
    insertDoc("notes", "sub/readme.md", "Read Me", "# Read Me\nbody text");
    const src = new SqliteConceptSource(db);
    expect(src.listGroups().some(g => g.path === "docs/notes")).toBe(true);
    const { refs } = src.listConcepts("docs/notes");
    expect(refs[0]).toMatchObject({ id: "docs/notes/sub/readme", type: "Document", title: "Read Me" });
    const c = src.getConcept("docs/notes/sub/readme");
    expect(c?.body).toContain("body text");
  });

  test("lists entities and gets an entity concept", () => {
    insertKnowledge("caroline", "lives in", "London");   // stored form is the slug
    const src = new SqliteConceptSource(db);
    expect(src.listGroups().some(g => g.type === "Entities")).toBe(true);
    const c = src.getConcept("entities/caroline");
    expect(c?.type).toBe("Entity");
    expect(c?.body).toContain("lives in London");
  });
});
