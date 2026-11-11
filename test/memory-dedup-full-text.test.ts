/**
 * Exact dedup hashes the full text, not the OKF-compacted body.
 *
 * Regression (2026-11-10 stress test, "Not fixed" item 1): memoryStore
 * compacted over-budget text (heuristic body = first 6 non-empty lines) and
 * then hashed the body. Two different long memories that shared a head got
 * the same hash, the second came back "duplicate" and its text was kept
 * nowhere. Invariant now: "duplicate" only when the full incoming text is
 * already recoverable from the existing row.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase, type Database } from "../src/db.js";
import { initializeDatabase, migrateMemoryHashesToFullText } from "../src/store/db-init.js";
import { memoryStore, memoryStoreBatch, memoryUpdate } from "../src/memory/index.js";
import { contentHash, memoryRowHash } from "../src/memory/hash.js";
import { compactAllMemories } from "../src/memory/compact.js";
import { exportMemories, importMemories } from "../src/memory/import.js";
import { SqliteConceptSource } from "../src/okf/source.js";
import { buildMemoryId } from "../src/okf/concept.js";
import { heuristicCompact } from "../src/okf/budget.js";

const HEAD = Array.from({ length: 6 }, (_, k) => `shared header line ${k} for the nightly backup job report`).join("\n");
const longWith = (tail: string) => `${HEAD}\n${tail} ${"pad ".repeat(150)}`.trim();
const A = longWith("UNIQUE TAIL A: backup FAILED on vol-a");
const B = longWith("UNIQUE TAIL B: backup ok on vol-b");

type Row = { id: string; text: string; content_hash: string; metadata: string | null };
const rows = (db: Database) => db.prepare(`SELECT id, text, content_hash, metadata FROM memories ORDER BY rowid`).all() as Row[];
const count = (db: Database, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const okfBody = (db: Database, id: string) => new SqliteConceptSource(db).getConcept(buildMemoryId("global", id))!.body;

describe("full-text dedup", () => {
  let tmp: string;
  let db: Database;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = { LOTL_ONNX: process.env.LOTL_ONNX, LOTL_EMBED_BACKEND: process.env.LOTL_EMBED_BACKEND, LOTL_OKF: process.env.LOTL_OKF };
    delete process.env.LOTL_ONNX;
    delete process.env.LOTL_EMBED_BACKEND;
    process.env.LOTL_OKF = "on";
    tmp = mkdtempSync(join(tmpdir(), "lotl-dedup-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  test("same head, different tail: two rows, both originals served by okf get", async () => {
    // Precondition of the bug: the two compacted bodies are identical.
    expect(heuristicCompact(A).body).toBe(heuristicCompact(B).body);

    const a = await memoryStore(db, { text: A });
    const b = await memoryStore(db, { text: B });
    expect(a.status).toBe("created");
    expect(b.status).toBe("created");
    expect(b.id).not.toBe(a.id);
    expect(count(db, "memories")).toBe(2);

    expect(okfBody(db, a.id)).toBe(A);
    expect(okfBody(db, b.id)).toBe(B);
    const [ra, rb] = rows(db);
    expect(ra!.content_hash).toBe(contentHash(A));
    expect(rb!.content_hash).toBe(contentHash(B));
  });

  test("identical long text twice: one row, second is duplicate", async () => {
    const a = await memoryStore(db, { text: A });
    const again = await memoryStore(db, { text: `  ${A}\n` });
    expect(again).toEqual({ id: a.id, status: "duplicate", duplicate_id: a.id });
    expect(count(db, "memories")).toBe(1);
  });

  test("single store then batch of the same long text: one row", async () => {
    const a = await memoryStore(db, { text: A });
    const [r] = await memoryStoreBatch(db, [{ text: A }]);
    expect(r).toEqual({ id: a.id, status: "duplicate" });
    expect(count(db, "memories")).toBe(1);
  });

  test("batch then single store of the same long text: one row", async () => {
    // The batch path does not compact (reported separately); its row hashes
    // the full text, which is what single store now hashes too.
    const [r] = await memoryStoreBatch(db, [{ text: A }]);
    expect(r!.status).toBe("created");
    const s = await memoryStore(db, { text: A });
    expect(s).toEqual({ id: r!.id, status: "duplicate", duplicate_id: r!.id });
    expect(count(db, "memories")).toBe(1);
  });

  test("batch items that share a head but differ in full text are both kept", async () => {
    const out = await memoryStoreBatch(db, [
      { text: heuristicCompact(A).body, metadata: { original: A } },
      { text: heuristicCompact(B).body, metadata: { original: B } },
    ]);
    expect(out.map(o => o.status)).toEqual(["created", "created"]);
    expect(rows(db).map(r => r.content_hash)).toEqual([contentHash(A), contentHash(B)]);
  });

  test("batch chunking: chunks that inherit metadata.original are not collapsed into one", async () => {
    const doc = Array.from({ length: 40 }, (_, i) => `paragraph ${i}: ${"word ".repeat(20)}distinct-${i}`).join("\n\n");
    const [r] = await memoryStoreBatch(db, [{ text: doc, chunk: true, metadata: { original: "whole doc summary source" } }]);
    expect(r!.status).toBe("created");
    const stored = rows(db);
    expect(stored.length).toBeGreaterThan(1);
    expect(new Set(stored.map(s => s.content_hash)).size).toBe(stored.length);
  });

  test("<private> spans are redacted before hashing and never stored", async () => {
    const secret = "sk-live-SECRET-9f8e7d";
    const withPrivate = `${HEAD}\nUNIQUE TAIL P: token <private>${secret}</private> rotated ${"pad ".repeat(150)}`;
    const p = await memoryStore(db, { text: withPrivate });
    expect(p.status).toBe("created");

    const [row] = rows(db);
    const meta = JSON.parse(row!.metadata!);
    expect(meta.original).not.toContain(secret);
    expect(row!.text).not.toContain(secret);
    // Hash input is the redacted full text.
    expect(row!.content_hash).toBe(contentHash(meta.original));

    // Same text with different private content is the same memory.
    const p2 = await memoryStore(db, { text: withPrivate.replace(secret, "another-secret") });
    expect(p2.status).toBe("duplicate");

    for (const table of ["memories", "memories_fts", "memory_history"]) {
      const dump = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
      expect(dump).not.toContain(secret);
      expect(dump).not.toContain("another-secret");
    }
  });

  test("LOTL_OKF=off: no compaction, hash of the stored text, same dedup as before", async () => {
    process.env.LOTL_OKF = "off";
    const a = await memoryStore(db, { text: A });
    const b = await memoryStore(db, { text: B });
    const again = await memoryStore(db, { text: A });
    expect([a.status, b.status, again.status]).toEqual(["created", "created", "duplicate"]);
    const [ra] = rows(db);
    expect(ra!.text).toBe(A);
    expect(JSON.parse(ra!.metadata!).original).toBeUndefined();
    expect(ra!.content_hash).toBe(contentHash(A));
  });

  test("memory compact --apply keeps the full-text hash, re-store is duplicate", async () => {
    process.env.LOTL_OKF = "off";
    const a = await memoryStore(db, { text: A });
    const before = rows(db)[0]!.content_hash;
    process.env.LOTL_OKF = "on";

    const res = await compactAllMemories(db, {
      apply: true,
      chat: async () => JSON.stringify({ description: "nightly backup report", body: "backup report: vol-a FAILED" }),
    });
    expect(res.compacted).toBe(1);
    const [row] = rows(db);
    expect(row!.text).toBe("backup report: vol-a FAILED");
    expect(JSON.parse(row!.metadata!).original).toBe(A);
    expect(row!.content_hash).toBe(before);

    expect(await memoryStore(db, { text: A })).toEqual({ id: a.id, status: "duplicate", duplicate_id: a.id });
    expect((await memoryStore(db, { text: B })).status).toBe("created");
  });

  test("export/import round trip, then re-store and re-import are duplicates", async () => {
    await memoryStore(db, { text: A });
    await memoryStore(db, { text: B });
    const file = join(tmp, "export.json");
    expect(exportMemories(db, file)).toBe(2);

    const dst = openDatabase(join(tmp, "dst.sqlite"));
    try {
      initializeDatabase(dst);
      expect(await importMemories(dst, file)).toEqual({ imported: 2, duplicates: 0 });
      expect(rows(dst).map(r => r.content_hash)).toEqual([contentHash(A), contentHash(B)]);
      expect((await memoryStore(dst, { text: A })).status).toBe("duplicate");
      expect((await memoryStore(dst, { text: B })).status).toBe("duplicate");
      expect(await importMemories(dst, file)).toEqual({ imported: 0, duplicates: 2 });
      expect(count(dst, "memories")).toBe(2);
    } finally {
      dst.close();
    }
  });

  test("memoryUpdate: metadata that adds or drops original moves the hash with it", async () => {
    const s = await memoryStore(db, { text: "short fact about vol-c" });
    await memoryUpdate(db, { id: s.id, metadata: { original: "the full story about vol-c" } });
    expect(rows(db)[0]!.content_hash).toBe(contentHash("the full story about vol-c"));
    await memoryUpdate(db, { id: s.id, metadata: {} });
    expect(rows(db)[0]!.content_hash).toBe(contentHash("short fact about vol-c"));
    await memoryUpdate(db, { id: s.id, text: "edited fact about vol-c" });
    expect(rows(db)[0]!.content_hash).toBe(contentHash("edited fact about vol-c"));
  });

  test("memoryRowHash ignores junk metadata", () => {
    expect(memoryRowHash("t", "not json")).toBe(contentHash("t"));
    expect(memoryRowHash("t", { original: 42 })).toBe(contentHash("t"));
    expect(memoryRowHash("t", { original: "   " })).toBe(contentHash("t"));
    expect(memoryRowHash("t", JSON.stringify({ original: "full" }))).toBe(contentHash("full"));
  });
});

describe("migration: recompute content_hash from metadata.original", () => {
  let tmp: string;
  let path: string;

  /** A row as an older build wrote it: compacted body in text, body hash. */
  const insertOldRow = (db: Database, id: string, full: string) => {
    const { body, description } = heuristicCompact(full);
    db.prepare(
      `INSERT INTO memories (id, text, content_hash, category, scope, importance, tier, access_count, created_at, metadata)
       VALUES (?, ?, ?, 'other', 'global', 0.5, 'peripheral', 0, ?, ?)`
    ).run(id, body, contentHash(body), Date.now(), JSON.stringify({ actor: "agent:mcp", description, original: full, status: "draft" }));
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lotl-dedup-mig-"));
    path = join(tmp, "t.sqlite");
    const db = openDatabase(path);
    initializeDatabase(db);
    // An older build never wrote the watermark; drop it if this open did.
    db.prepare(`DELETE FROM store_config WHERE key LIKE 'memories_hash%'`).run();
    db.close();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("old compacted row gets its full-text hash; FTS untouched; second open is a no-op", async () => {
    let db = openDatabase(path);
    insertOldRow(db, "old-a", A);
    db.prepare(
      `INSERT INTO memories (id, text, content_hash, category, scope, importance, tier, access_count, created_at, metadata)
       VALUES ('plain', 'a plain short memory', ?, 'other', 'global', 0.5, 'peripheral', 0, ?, NULL)`
    ).run(contentHash("a plain short memory"), Date.now());
    db.prepare(`DELETE FROM store_config WHERE key LIKE 'memories_hash%'`).run();
    // Sentinel: if the migration's UPDATE fired memories_au, the FTS row
    // would be rewritten from memories.text and the sentinel would vanish.
    const rowid = (db.prepare(`SELECT rowid FROM memories WHERE id='old-a'`).get() as { rowid: number }).rowid;
    db.prepare(`UPDATE memories_fts SET text = 'fts-sentinel' WHERE rowid = ?`).run(rowid);
    db.close();

    db = openDatabase(path);
    initializeDatabase(db); // migration runs here
    const r = db.prepare(`SELECT content_hash FROM memories WHERE id='old-a'`).get() as { content_hash: string };
    expect(r.content_hash).toBe(contentHash(A));
    expect((db.prepare(`SELECT content_hash FROM memories WHERE id='plain'`).get() as any).content_hash).toBe(contentHash("a plain short memory"));
    expect((db.prepare(`SELECT text FROM memories_fts WHERE rowid = ?`).get(rowid) as { text: string }).text).toBe("fts-sentinel");
    expect(count(db, "memories")).toBe(2);
    expect(count(db, "memories_fts")).toBe(2);

    // Trigger is back and still keeps FTS in sync.
    db.prepare(`UPDATE memories SET text = 'rewritten body' WHERE id='old-a'`).run();
    expect((db.prepare(`SELECT text FROM memories_fts WHERE rowid = ?`).get(rowid) as { text: string }).text).toBe("rewritten body");
    db.prepare(`UPDATE memories SET text = ? WHERE id='old-a'`).run(heuristicCompact(A).body);

    // Second open: nothing to do.
    expect(migrateMemoryHashesToFullText(db)).toEqual({ checked: 0, updated: 0 });
    db.close();
    db = openDatabase(path);
    initializeDatabase(db);
    expect(migrateMemoryHashesToFullText(db)).toEqual({ checked: 0, updated: 0 });
    expect(count(db, "memories")).toBe(2);

    // The fix it enables: B shares A's head and is now stored, A is a duplicate.
    expect((await memoryStore(db, { text: B })).status).toBe("created");
    expect((await memoryStore(db, { text: A })).status).toBe("duplicate");
    db.close();
  });

  test("two old rows with identical originals: both kept, same hash, re-store dedups", async () => {
    let db = openDatabase(path);
    insertOldRow(db, "twin-1", A);
    insertOldRow(db, "twin-2", A);
    db.close();

    db = openDatabase(path);
    initializeDatabase(db);
    const hashes = (db.prepare(`SELECT content_hash FROM memories ORDER BY id`).all() as { content_hash: string }[]).map(r => r.content_hash);
    expect(hashes).toEqual([contentHash(A), contentHash(A)]);
    expect(count(db, "memories")).toBe(2);
    const again = await memoryStore(db, { text: A });
    expect(again.status).toBe("duplicate");
    expect(["twin-1", "twin-2"]).toContain(again.id);
    expect(count(db, "memories")).toBe(2);
    db.close();
  });

  test("rows written after the first pass (e.g. by a not-yet-restarted old process) are picked up", () => {
    let db = openDatabase(path);
    initializeDatabase(db);
    insertOldRow(db, "late", B);
    db.close();
    db = openDatabase(path);
    initializeDatabase(db);
    expect((db.prepare(`SELECT content_hash FROM memories WHERE id='late'`).get() as any).content_hash).toBe(contentHash(B));
    db.close();
  });
});
