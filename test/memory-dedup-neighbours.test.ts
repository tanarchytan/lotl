/**
 * The near-duplicate search looks past neighbours it has to skip. It skips
 * OKF-compacted rows and vectors whose memory row is gone; when the nearest
 * few are all of that kind, a real near-duplicate further down must still be
 * found. Embeddings are mocked (hashed bag-of-words vector).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fake = vi.hoisted(() => {
  const DIM = 64;
  const embed = (text: string): number[] => {
    const v = new Array<number>(DIM).fill(0);
    for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
      v[(h >>> 0) % DIM]! += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map(x => x / n);
  };
  return { DIM, embed };
});

vi.mock("../src/remote-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/remote-config.js")>();
  const remote = {
    embed: async (t: string) => ({ embedding: fake.embed(t) }),
    embedBatch: async (ts: string[]) => ts.map(t => ({ embedding: fake.embed(t) })),
    chatComplete: async () => "NONE",
  };
  return { ...actual, getRemoteConfig: () => ({ embed: { provider: "api", apiKey: "test" } }), getRemoteLLM: () => remote };
});

const { openDatabase } = await import("../src/db.js");
const { initializeDatabase } = await import("../src/store/db-init.js");
const { memoryStore } = await import("../src/memory/index.js");
const { MEMORY_DEDUP_NEIGHBOURS } = await import("../src/store/constants.js");

const QUERY = "the nightly deploy pipeline runs at two";
const NEAR = "the nightly deploy pipeline runs at two today"; // cosine ~0.94 to QUERY

describe("near-duplicate search depth", () => {
  let tmp: string;
  let db: any;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.LOTL_MEMORY_CONFLICT;
    process.env.LOTL_MEMORY_CONFLICT = "off"; // a near-duplicate is a plain duplicate
    tmp = mkdtempSync(join(tmpdir(), "lotl-dedup-k-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
    db.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(scope TEXT PARTITION KEY, id TEXT PRIMARY KEY, embedding float[${fake.DIM}] distance_metric=cosine)`);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    if (saved === undefined) delete process.env.LOTL_MEMORY_CONFLICT; else process.env.LOTL_MEMORY_CONFLICT = saved;
    rmSync(tmp, { recursive: true, force: true });
  });

  const addVector = (id: string, text: string) =>
    db.prepare(`INSERT INTO memories_vec (scope, id, embedding) VALUES ('global', ?, ?)`).run(id, new Float32Array(fake.embed(text)));
  const addCompactedRow = (id: string, body: string) => {
    db.prepare(`INSERT INTO memories (id, text, content_hash, category, scope, importance, tier, access_count, created_at, metadata)
                VALUES (?, ?, ?, 'fact', 'global', 0.5, 'peripheral', 0, ?, ?)`)
      .run(id, body, `h-${id}`, Date.now(), JSON.stringify({ original: `${body}\n...and a long tail that differs per row ${id}` }));
    addVector(id, body);
  };

  test("the search depth is a named constant well above the old 5", () => {
    expect(MEMORY_DEDUP_NEIGHBOURS).toBeGreaterThanOrEqual(20);
  });

  test("a near-duplicate behind more than five skipped neighbours is still found", async () => {
    const near = await memoryStore(db, { text: NEAR });
    // Six neighbours closer than NEAR (cosine 1.0 to QUERY) that must be skipped:
    // three compacted rows and three vectors whose row is gone.
    for (let i = 0; i < 3; i++) addCompactedRow(`compacted-${i}`, QUERY);
    for (let i = 0; i < 3; i++) addVector(`orphan-${i}`, QUERY);

    const r = await memoryStore(db, { text: QUERY });
    expect(r).toEqual({ id: near.id, status: "duplicate", duplicate_id: near.id });
  });

  test("with only skipped neighbours above the threshold the memory is stored", async () => {
    for (let i = 0; i < 8; i++) addCompactedRow(`compacted-${i}`, QUERY);
    await memoryStore(db, { text: "an unrelated note about the coffee machine" });
    expect((await memoryStore(db, { text: QUERY })).status).toBe("created");
  });
});
