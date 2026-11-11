/**
 * memoryEmbedMissing backfills vectors for memories stored without one
 * (e.g. while no embedding provider was configured). Dry run counts and
 * writes nothing; a real run embeds in batches, only rows that lack a
 * vector, into the row's scope partition; re-running is a no-op.
 * Embeddings are mocked (hashed bag-of-words vector); the provider can be
 * switched off or made to fail per text.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fake = vi.hoisted(() => {
  const DIM = 64;
  const state = { provider: true, failOn: new Set<string>(), batchCalls: [] as number[] };
  const embed = (text: string): number[] => {
    if (state.failOn.has(text)) throw new Error("embed failed");
    const v = new Array<number>(DIM).fill(0);
    for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
      v[(h >>> 0) % DIM]! += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map(x => x / n);
  };
  return { DIM, embed, state };
});

vi.mock("../src/remote-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/remote-config.js")>();
  const remote = {
    embed: async (t: string) => ({ embedding: fake.embed(t) }),
    embedBatch: async (ts: string[]) => { fake.state.batchCalls.push(ts.length); return ts.map(t => ({ embedding: fake.embed(t) })); },
    chatComplete: async () => "NONE",
  };
  return {
    ...actual,
    getRemoteConfig: () => (fake.state.provider ? { embed: { provider: "api", apiKey: "test" } } : null),
    getRemoteLLM: () => (fake.state.provider ? remote : null),
  };
});

const { openDatabase } = await import("../src/db.js");
const { initializeDatabase } = await import("../src/store/db-init.js");
const { memoryEmbedMissing } = await import("../src/memory/index.js");

describe("memoryEmbedMissing", () => {
  let tmp: string;
  let db: any;
  let savedBackend: string | undefined;
  let seq = 0;

  beforeEach(() => {
    savedBackend = process.env.LOTL_EMBED_BACKEND;
    delete process.env.LOTL_EMBED_BACKEND;
    fake.state.provider = true;
    fake.state.failOn.clear();
    fake.state.batchCalls = [];
    tmp = mkdtempSync(join(tmpdir(), "lotl-embed-missing-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    if (savedBackend === undefined) delete process.env.LOTL_EMBED_BACKEND; else process.env.LOTL_EMBED_BACKEND = savedBackend;
    rmSync(tmp, { recursive: true, force: true });
  });

  // Texts are unique per test run so the module's embedding cache never
  // answers for a text another test embedded.
  const addRow = (text: string, scope = "global") => {
    const id = `m-${++seq}`;
    db.prepare(`INSERT INTO memories (id, text, content_hash, category, scope, importance, tier, access_count, created_at, metadata)
                VALUES (?, ?, ?, 'fact', ?, 0.5, 'peripheral', 0, ?, NULL)`).run(id, `${text} #${seq}`, `h-${id}`, scope, Date.now());
    return { id, text: `${text} #${seq}`, scope };
  };
  const createVecTable = (dim = fake.DIM) =>
    db.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(scope TEXT PARTITION KEY, id TEXT PRIMARY KEY, embedding float[${dim}] distance_metric=cosine)`);
  const putVector = (id: string, scope: string, vec: number[]) =>
    db.prepare(`INSERT INTO memories_vec (scope, id, embedding) VALUES (?, ?, ?)`).run(scope, id, new Float32Array(vec));
  const vectorOf = (id: string): number[] | null => {
    const r = db.prepare(`SELECT embedding FROM memories_vec WHERE id = ?`).get(id) as { embedding: Buffer } | undefined;
    if (!r) return null;
    return Array.from(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4));
  };
  const vecCount = () => (db.prepare(`SELECT count(*) AS n FROM memories_vec`).get() as { n: number }).n;
  const hasVecTable = () => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'memories_vec'`).get();
  const expectClose = (got: number[] | null, want: number[]) => {
    expect(got).not.toBeNull();
    got!.forEach((x, i) => expect(x).toBeCloseTo(want[i]!, 5));
  };

  test("dry run counts the rows without a vector and writes nothing", async () => {
    createVecTable();
    const has = addRow("deploy notes with a vector");
    putVector(has.id, has.scope, fake.embed("something else entirely"));
    addRow("backup notes without a vector");
    addRow("release notes without a vector", "proj-a");

    const r = await memoryEmbedMissing(db, { dryRun: true });
    expect(r).toEqual({ missing: 2, embedded: 0, failed: 0, dryRun: true, provider: "remote" });
    expect(vecCount()).toBe(1);
    expect(fake.state.batchCalls).toEqual([]);
  });

  test("dry run on an index that never had a vector table counts every row and creates nothing", async () => {
    addRow("a");
    addRow("b");
    expect(await memoryEmbedMissing(db, { dryRun: true })).toMatchObject({ missing: 2, embedded: 0 });
    expect(hasVecTable()).toBe(false);
  });

  test("embeds only rows without a vector, into their scope, and leaves existing vectors alone", async () => {
    createVecTable();
    const has = addRow("deploy notes with a vector");
    const keep = fake.embed("something else entirely");
    putVector(has.id, has.scope, keep);
    const a = addRow("backup notes without a vector");
    const b = addRow("release notes without a vector", "proj-a");

    const r = await memoryEmbedMissing(db);
    expect(r).toEqual({ missing: 2, embedded: 2, failed: 0, dryRun: false, provider: "remote" });
    expectClose(vectorOf(a.id), fake.embed(a.text));
    expectClose(vectorOf(b.id), fake.embed(b.text));
    expectClose(vectorOf(has.id), keep);
    const scopeOf = db.prepare(`SELECT scope FROM memories_vec WHERE id = ?`);
    expect((scopeOf.get(b.id) as { scope: string }).scope).toBe("proj-a");

    // Idempotent.
    expect(await memoryEmbedMissing(db)).toEqual({ missing: 0, embedded: 0, failed: 0, dryRun: false, provider: "remote" });
    expect(vecCount()).toBe(3);
  });

  test("works in batches of batchSize", async () => {
    createVecTable();
    for (let i = 0; i < 5; i++) addRow(`batched memory number ${i}`);
    const r = await memoryEmbedMissing(db, { batchSize: 2 });
    expect(r.embedded).toBe(5);
    expect(fake.state.batchCalls).toEqual([2, 2, 1]);
  });

  test("scope option limits the backfill to one scope", async () => {
    createVecTable();
    addRow("in scope a", "proj-a");
    addRow("in scope b", "proj-b");
    expect(await memoryEmbedMissing(db, { scope: "proj-a" })).toMatchObject({ missing: 1, embedded: 1 });
    expect(await memoryEmbedMissing(db, { dryRun: true })).toMatchObject({ missing: 1 });
  });

  test("creates the vector table when the index never had one", async () => {
    const a = addRow("first memory ever embedded");
    expect(await memoryEmbedMissing(db)).toMatchObject({ missing: 1, embedded: 1 });
    expectClose(vectorOf(a.id), fake.embed(a.text));
  });

  test("a row the provider cannot embed is counted as failed and retried next run", async () => {
    createVecTable();
    const ok = addRow("embeddable memory");
    const bad = addRow("unembeddable memory");
    fake.state.failOn.add(bad.text);
    expect(await memoryEmbedMissing(db)).toMatchObject({ missing: 2, embedded: 1, failed: 1 });
    expect(vectorOf(ok.id)).not.toBeNull();
    expect(vectorOf(bad.id)).toBeNull();
    fake.state.failOn.clear();
    expect(await memoryEmbedMissing(db)).toMatchObject({ missing: 1, embedded: 1, failed: 0 });
  });

  test("no provider: dry run says so, a real run writes nothing", async () => {
    createVecTable();
    addRow("waiting for a provider");
    fake.state.provider = false;
    expect(await memoryEmbedMissing(db, { dryRun: true })).toEqual({ missing: 1, embedded: 0, failed: 0, dryRun: true, provider: "none" });
    const r = await memoryEmbedMissing(db);
    expect(r).toMatchObject({ missing: 1, embedded: 0, provider: "none" });
    expect(r.aborted).toMatch(/no embedding provider/);
    expect(vecCount()).toBe(0);
  });

  test("a vector table of another dimension is never dropped or written", async () => {
    createVecTable(32);
    const has = addRow("existing 32-dim vector");
    putVector(has.id, has.scope, new Array(32).fill(0).map((_, i) => (i === 0 ? 1 : 0)));
    addRow("needs a vector");
    const r = await memoryEmbedMissing(db);
    expect(r).toMatchObject({ missing: 1, embedded: 0 });
    expect(r.aborted).toMatch(/dimension/);
    expect(vecCount()).toBe(1);
    expect(vectorOf(has.id)).toHaveLength(32);
  });
});
