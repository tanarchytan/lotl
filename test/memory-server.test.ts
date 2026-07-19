/**
 * memory-server.test.ts — HTTP API tests for the memory web server.
 *
 * Exercises the JSON API end-to-end against a throwaway temp index:
 * list + filter, get, PATCH (edit), DELETE, token auth, and the
 * BLOB-column exclusion guard.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { startMemoryServer } from "../src/memory/server.js";

describe("memory server API", () => {
  let db: ReturnType<typeof openDatabase>;
  let tmpDir: string;
  let server: Server;
  let base: string;

  const insert = (id: string, text: string, opts: { category?: string; scope?: string; importance?: number } = {}) => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO memories (id, text, content_hash, category, scope, importance, tier, access_count, created_at, last_accessed)
      VALUES (?, ?, ?, ?, ?, ?, 'peripheral', 0, ?, ?)
    `).run(id, text, id, opts.category ?? "fact", opts.scope ?? "global", opts.importance ?? 0.5, now, now);
  };

  const startWith = async (token?: string) => {
    server = await startMemoryServer(db, { host: "127.0.0.1", port: 0, token });
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lotl-memserver-"));
    db = openDatabase(join(tmpDir, "test.sqlite"));
    initializeDatabase(db);
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { db.close(); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test("lists memories with filters and pagination", async () => {
    insert("a1", "alpha fact", { category: "fact", scope: "global" });
    insert("b2", "beta decision", { category: "decision", scope: "projectX" });
    await startWith();

    const all = await (await fetch(`${base}/api/memories`)).json();
    expect(all.total).toBe(2);
    expect(all.memories).toHaveLength(2);

    const byCat = await (await fetch(`${base}/api/memories?category=decision`)).json();
    expect(byCat.total).toBe(1);
    expect(byCat.memories[0].id).toBe("b2");

    const byQuery = await (await fetch(`${base}/api/memories?q=alpha`)).json();
    expect(byQuery.total).toBe(1);
    expect(byQuery.memories[0].id).toBe("a1");

    const paged = await (await fetch(`${base}/api/memories?limit=1&offset=1`)).json();
    expect(paged.memories).toHaveLength(1);
    expect(paged.total).toBe(2);
  });

  test("never leaks vector/hash columns", async () => {
    insert("a1", "alpha", {});
    await startWith();
    const row = (await (await fetch(`${base}/api/memories`)).json()).memories[0];
    expect(row).not.toHaveProperty("fact_embedding");
    expect(row).not.toHaveProperty("content_hash");
    expect(row).toHaveProperty("text", "alpha");
  });

  test("gets a single memory, 404 for missing", async () => {
    insert("a1", "alpha", {});
    await startWith();
    const ok = await fetch(`${base}/api/memory/a1`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).text).toBe("alpha");

    const missing = await fetch(`${base}/api/memory/nope`);
    expect(missing.status).toBe(404);
  });

  test("PATCH edits text, category, importance", async () => {
    insert("a1", "old text", { category: "fact", importance: 0.5 });
    await startWith();
    const res = await fetch(`${base}/api/memory/a1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "new text", category: "decision", importance: 0.9 }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.text).toBe("new text");
    expect(updated.category).toBe("decision");
    expect(updated.importance).toBeCloseTo(0.9);

    const persisted = db.prepare(`SELECT text, category FROM memories WHERE id = 'a1'`).get() as any;
    expect(persisted.text).toBe("new text");
    expect(persisted.category).toBe("decision");
  });

  test("PATCH rejects an invalid category", async () => {
    insert("a1", "x", {});
    await startWith();
    const res = await fetch(`${base}/api/memory/a1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  test("DELETE removes a memory", async () => {
    insert("a1", "gone soon", {});
    await startWith();
    const res = await fetch(`${base}/api/memory/a1`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
    const count = (db.prepare(`SELECT COUNT(*) as c FROM memories`).get() as any).c;
    expect(count).toBe(0);

    const again = await fetch(`${base}/api/memory/a1`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  test("token auth blocks unauthenticated requests", async () => {
    insert("a1", "secret", {});
    await startWith("s3cret");

    const noTok = await fetch(`${base}/api/stats`);
    expect(noTok.status).toBe(401);

    const badTok = await fetch(`${base}/api/stats?token=wrong`);
    expect(badTok.status).toBe(401);

    const goodHeader = await fetch(`${base}/api/stats`, { headers: { authorization: "Bearer s3cret" } });
    expect(goodHeader.status).toBe(200);

    const goodQuery = await fetch(`${base}/api/stats?token=s3cret`);
    expect(goodQuery.status).toBe(200);
  });

  test("stats reports totals and scopes", async () => {
    insert("a1", "x", { scope: "global" });
    insert("b2", "y", { scope: "projectX" });
    await startWith();
    const stats = await (await fetch(`${base}/api/stats`)).json();
    expect(stats.total).toBe(2);
    expect(stats.scopes).toContain("projectX");
    expect(stats.byScope.global).toBe(1);
  });
});
