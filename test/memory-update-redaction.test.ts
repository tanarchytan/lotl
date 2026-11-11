/**
 * memoryUpdate redacts <private>...</private> spans first, like memoryStore:
 * the private text reaches no row text, metadata.original, memory_history,
 * content hash input or embed call; text empty after redaction is an error
 * and nothing is written. Embeddings are mocked and recorded.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fake = vi.hoisted(() => {
  const DIM = 32;
  const embedded: string[] = [];
  const embed = (text: string): number[] => {
    embedded.push(text);
    const v = new Array<number>(DIM).fill(0);
    for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
      v[(h >>> 0) % DIM]! += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map(x => x / n);
  };
  return { DIM, embed, embedded };
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
const { memoryStore, memoryUpdate } = await import("../src/memory/index.js");
const { contentHash } = await import("../src/memory/hash.js");

const SECRET = "SECRET-TOKEN-7d41";

describe("memoryUpdate redaction", () => {
  let tmp: string;
  let db: any;
  let savedOkf: string | undefined;

  beforeEach(() => {
    savedOkf = process.env.LOTL_OKF;
    process.env.LOTL_OKF = "on";
    fake.embedded.length = 0;
    tmp = mkdtempSync(join(tmpdir(), "lotl-update-redact-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
    db.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(scope TEXT PARTITION KEY, id TEXT PRIMARY KEY, embedding float[${fake.DIM}] distance_metric=cosine)`);
  });
  afterEach(() => {
    try { db.close(); } catch {}
    if (savedOkf === undefined) delete process.env.LOTL_OKF; else process.env.LOTL_OKF = savedOkf;
    rmSync(tmp, { recursive: true, force: true });
  });

  const rowOf = (id: string) => db.prepare(`SELECT text, content_hash, metadata FROM memories WHERE id = ?`).get(id) as { text: string; content_hash: string; metadata: string | null };
  const dump = (id: string) => JSON.stringify([rowOf(id), db.prepare(`SELECT * FROM memory_history WHERE memory_id = ?`).all(id)]);

  test("text-only update: private span reaches no row, history, hash or embed call", async () => {
    const { id } = await memoryStore(db, { text: "the demo site login note", scope: "s" });
    fake.embedded.length = 0;
    const res = await memoryUpdate(db, { id, text: `the demo site login is <private>${SECRET}</private> for staging` });
    expect(res.updated).toBe(true);
    const row = rowOf(id);
    expect(row.text).toBe("the demo site login is  for staging");
    expect(row.content_hash).toBe(contentHash(row.text));
    expect(dump(id)).not.toContain(SECRET);
    expect(fake.embedded.join("\n")).not.toContain(SECRET);
    expect(fake.embedded).toEqual([row.text]);
  });

  test("over-budget update with a private span: not in text or metadata.original", async () => {
    const { id } = await memoryStore(db, { text: "short note", scope: "s" });
    const big = `headline fact\n<private>${SECRET}</private>\n` + "filler ".repeat(400);
    await memoryUpdate(db, { id, text: big });
    const row = rowOf(id);
    expect(JSON.parse(row.metadata!).original).toBeTruthy();
    expect(dump(id)).not.toContain(SECRET);
    expect(fake.embedded.join("\n")).not.toContain(SECRET);
  });

  test("explicit metadata.original (and description) is redacted, text and hash follow", async () => {
    const { id } = await memoryStore(db, { text: "plain note about backups", scope: "s" });
    fake.embedded.length = 0;
    const res = await memoryUpdate(db, {
      id,
      text: `compact body <private>${SECRET}</private>`,
      metadata: { original: `full text <private>${SECRET}</private> of the note`, description: `about <private>${SECRET}</private> backups` },
    });
    expect(res.updated).toBe(true);
    const row = rowOf(id);
    const meta = JSON.parse(row.metadata!);
    expect(meta.original).toBe("full text  of the note");
    expect(meta.description).toBe("about  backups");
    expect(row.content_hash).toBe(contentHash("full text  of the note"));
    expect(dump(id)).not.toContain(SECRET);
    expect(fake.embedded.join("\n")).not.toContain(SECRET);
  });

  test("metadata-only update with a private original is redacted too", async () => {
    const { id } = await memoryStore(db, { text: "plain note about backups", scope: "s" });
    await memoryUpdate(db, { id, metadata: { original: `before <private>${SECRET}</private> after` } });
    const row = rowOf(id);
    expect(JSON.parse(row.metadata!).original).toBe("before  after");
    expect(row.content_hash).toBe(contentHash("before  after"));
    expect(dump(id)).not.toContain(SECRET);
  });

  test("an original that is empty after redaction is dropped", async () => {
    const { id } = await memoryStore(db, { text: "plain note about backups", scope: "s" });
    await memoryUpdate(db, { id, metadata: { original: `<private>${SECRET}</private>`, keep: 1 } });
    const row = rowOf(id);
    expect(JSON.parse(row.metadata!)).toEqual({ keep: 1 });
    expect(row.content_hash).toBe(contentHash(row.text));
  });

  test("text empty after redaction is an error and nothing is written", async () => {
    const { id } = await memoryStore(db, { text: "keep this note", scope: "s", importance: 0.4 });
    const before = dump(id);
    fake.embedded.length = 0;
    await expect(memoryUpdate(db, { id, text: `<private>${SECRET}</private>`, importance: 0.9, category: "decision" }))
      .rejects.toThrow(/empty after redacting/);
    expect(dump(id)).toBe(before);
    const r = db.prepare(`SELECT importance, category FROM memories WHERE id = ?`).get(id) as any;
    expect(r.importance).toBe(0.4);
    expect(r.category).not.toBe("decision");
    expect(fake.embedded).toEqual([]);
  });

  test("text without private spans is unchanged", async () => {
    const { id } = await memoryStore(db, { text: "old plain text", scope: "s" });
    await memoryUpdate(db, { id, text: "new plain text" });
    expect(rowOf(id).text).toBe("new plain text");
  });
});
