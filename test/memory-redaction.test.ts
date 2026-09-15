/**
 * Redaction on capture: <private>...</private> spans must never reach the
 * DB (text column, metadata.original, memory_history) or survive into a
 * stored embedding target. See src/memory/redact.ts + memoryStore/
 * memoryStoreBatch in src/memory/index.ts for the enforcement points.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { memoryStore, memoryStoreBatch } from "../src/memory/index.js";
import { redactPrivate } from "../src/memory/redact.js";

describe("redaction on capture", () => {
  let db: any, tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lotl-redact-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
  });
  afterEach(() => {
    try { db.close(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  test("private span stripped from stored text column", async () => {
    const res = await memoryStore(db, {
      text: "User's password is <private>hunter2</private> for the demo site.",
      category: "fact",
      scope: "global",
    });
    const row = db.prepare(`SELECT text FROM memories WHERE id = ?`).get((res as any).id) as any;
    expect(row.text).not.toContain("hunter2");
    expect(row.text).not.toContain("<private>");
  });

  test("over-budget memory with a private span: secret is in neither text nor metadata.original", async () => {
    const secret = "SECRET-DO-NOT-STORE-9f3a";
    const big = `headline fact\n<private>${secret}</private>\n` + "filler ".repeat(400);

    const res = await memoryStore(db, { text: big, category: "fact", scope: "global" });
    const row = db.prepare(`SELECT text, metadata FROM memories WHERE id = ?`).get((res as any).id) as any;

    // Sanity: this fixture actually triggers OKF compaction.
    expect(row.text.length).toBeLessThanOrEqual(500);
    expect(row.metadata).toBeTruthy();

    const metadata = JSON.parse(row.metadata);
    expect(metadata.original).toBeTruthy();
    expect(metadata.original).not.toContain(secret);
    expect(row.text).not.toContain(secret);
  });

  test("private text never reaches memory_history", async () => {
    const secret = "hunter2";
    const res = await memoryStore(db, {
      text: `Login note: <private>${secret}</private> is the password.`,
      category: "fact",
      scope: "global",
    });
    const hist = db.prepare(`SELECT new_value FROM memory_history WHERE memory_id = ?`).get((res as any).id) as any;
    expect(hist.new_value).not.toContain(secret);
  });

  test("text with no private tags is stored byte-identical", async () => {
    const text = "Plain fact with no secrets in it at all.";
    const res = await memoryStore(db, { text, category: "fact", scope: "global" });
    const row = db.prepare(`SELECT text FROM memories WHERE id = ?`).get((res as any).id) as any;
    expect(row.text).toBe(text);
  });

  test("entirely-private memory throws", async () => {
    await expect(
      memoryStore(db, { text: "<private>only secret content, nothing else</private>", category: "fact", scope: "global" })
    ).rejects.toThrow();

    const count = (db.prepare(`SELECT count(*) as c FROM memories`).get() as any).c;
    expect(count).toBe(0);
  });

  test("memoryStoreBatch redacts private spans per item", async () => {
    const secret = "batch-secret-value";
    const results = await memoryStoreBatch(db, [
      { text: `Fact one, plain.`, category: "fact", scope: "global" },
      { text: `Fact two has <private>${secret}</private> embedded in it.`, category: "fact", scope: "global" },
    ]);

    const row2 = db.prepare(`SELECT text FROM memories WHERE id = ?`).get(results[1]!.id) as any;
    expect(row2.text).not.toContain(secret);
    expect(row2.text).not.toContain("<private>");

    const hist = db.prepare(`SELECT new_value FROM memory_history WHERE memory_id = ?`).get(results[1]!.id) as any;
    expect(hist.new_value).not.toContain(secret);
  });

  test("memoryStoreBatch throws when an item is entirely private", async () => {
    await expect(
      memoryStoreBatch(db, [
        { text: "Fine, keep this one.", category: "fact", scope: "global" },
        { text: "<private>nothing survives redaction</private>", category: "fact", scope: "global" },
      ])
    ).rejects.toThrow();
  });
});

describe("redactPrivate string edges", () => {
  test("nested spans leave nothing behind", () => {
    const out = redactPrivate("keep <private>a<private>b</private>c</private> keep");
    expect(out).not.toContain("a");
    expect(out).not.toContain("b");
    expect(out).not.toContain("c");
    expect(out).not.toContain("private");
  });

  test("orphan close tag fails closed", () => {
    expect(redactPrivate("leaked</private> safe")).toBe(" safe");
  });

  test("unclosed open tag strips to end of string", () => {
    expect(redactPrivate("safe <private>never ends")).toBe("safe ");
  });

  test("multiple spans and mixed case", () => {
    expect(redactPrivate("a<private>x</private>b<PRIVATE>y</PRIVATE>c")).toBe("abc");
  });

  test("no tags means byte-identical", () => {
    const s = "plain text\nwith newlines and < angle > brackets";
    expect(redactPrivate(s)).toBe(s);
  });
});
