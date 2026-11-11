/**
 * Rewrites of a memory's text keep the rest of the row consistent:
 *  - the conflict UPDATE merge (LOTL_MEMORY_CONFLICT=llm) and memoryUpdate
 *    replace the row's vector with the embedding of the new text, and keep the
 *    old vector when the new text cannot be embedded;
 *  - a text-only memoryUpdate treats the new text as the full text and runs
 *    the write-time OKF budget on it, so metadata.original, description,
 *    draft status and content_hash follow the new text.
 * Embeddings and chat are mocked (hashed bag-of-words vector, scripted reply).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fake = vi.hoisted(() => {
  const DIM = 64;
  const failOn = new Set<string>();
  const embed = (text: string): number[] => {
    if (failOn.has(text)) throw new Error("embed provider down");
    const v = new Array<number>(DIM).fill(0);
    for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
      v[(h >>> 0) % DIM]! += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map(x => x / n);
  };
  return { DIM, embed, failOn, chat: { fn: async (_p: string): Promise<string> => "NONE" } };
});

vi.mock("../src/remote-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/remote-config.js")>();
  const remote = {
    embed: async (t: string) => ({ embedding: fake.embed(t) }),
    embedBatch: async (ts: string[]) => ts.map(t => ({ embedding: fake.embed(t) })),
    chatComplete: async (p: string) => fake.chat.fn(p),
  };
  return { ...actual, getRemoteConfig: () => ({ embed: { provider: "api", apiKey: "test" } }), getRemoteLLM: () => remote };
});

const { openDatabase } = await import("../src/db.js");
const { initializeDatabase } = await import("../src/store/db-init.js");
const { memoryStore, memoryUpdate } = await import("../src/memory/index.js");
const { contentHash } = await import("../src/memory/hash.js");
const { heuristicCompact } = await import("../src/okf/budget.js");
const { SqliteConceptSource } = await import("../src/okf/source.js");
const { buildMemoryId } = await import("../src/okf/concept.js");

const longText = (topic: string) =>
  [`${topic} headline for the quarterly storage review`, ...Array.from({ length: 8 }, (_, k) => `${topic} detail line ${k} with numbers ${k * 7}`)]
    .join("\n") + "\n" + `${topic} tail ${"filler ".repeat(120)}`.trim();

describe("memory text rewrites", () => {
  let tmp: string;
  let db: any;
  let saved: { conflict?: string; okf?: string };

  beforeEach(() => {
    saved = { conflict: process.env.LOTL_MEMORY_CONFLICT, okf: process.env.LOTL_OKF };
    delete process.env.LOTL_MEMORY_CONFLICT; // default: llm
    process.env.LOTL_OKF = "on";
    fake.chat.fn = async () => "NONE";
    fake.failOn.clear();
    tmp = mkdtempSync(join(tmpdir(), "lotl-update-vec-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
    db.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(scope TEXT PARTITION KEY, id TEXT PRIMARY KEY, embedding float[${fake.DIM}] distance_metric=cosine)`);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    if (saved.conflict === undefined) delete process.env.LOTL_MEMORY_CONFLICT; else process.env.LOTL_MEMORY_CONFLICT = saved.conflict;
    if (saved.okf === undefined) delete process.env.LOTL_OKF; else process.env.LOTL_OKF = saved.okf;
    rmSync(tmp, { recursive: true, force: true });
  });

  const vectorOf = (id: string): number[] | null => {
    const r = db.prepare(`SELECT embedding FROM memories_vec WHERE id = ?`).get(id) as { embedding: Buffer } | undefined;
    if (!r) return null;
    const b = r.embedding;
    return Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));
  };
  const expectVectorOf = (id: string, text: string) => {
    const got = vectorOf(id);
    expect(got).not.toBeNull();
    const want = fake.embed(text);
    got!.forEach((x, i) => expect(x).toBeCloseTo(want[i]!, 5));
  };
  const rowOf = (id: string) => {
    const r = db.prepare(`SELECT text, content_hash, metadata FROM memories WHERE id = ?`).get(id) as { text: string; content_hash: string; metadata: string | null };
    return { ...r, meta: r.metadata ? JSON.parse(r.metadata) : {} };
  };

  describe("conflict UPDATE merge", () => {
    const OLD = "backups of the build cache run nightly at two";
    const DUP = "Backups of the build cache run nightly at two!";
    const MERGED = "backups of the build cache run nightly at two and weekly on sunday";

    test("re-embeds the merged text into the row's vector", async () => {
      const a = await memoryStore(db, { text: OLD, scope: "proj" });
      fake.chat.fn = async (p) => p.startsWith("Compare") ? "UPDATE" : MERGED;
      const r = await memoryStore(db, { text: DUP, scope: "proj" });
      expect(r.status).toBe("duplicate");
      expect(rowOf(a.id).text).toBe(MERGED);
      expectVectorOf(a.id, MERGED);
      expect((db.prepare(`SELECT count(*) AS n FROM memories_vec`).get() as { n: number }).n).toBe(1);
    });

    test("keeps the old vector when the merged text cannot be embedded", async () => {
      const a = await memoryStore(db, { text: OLD, scope: "proj" });
      fake.failOn.add(MERGED + " (unembeddable)");
      fake.chat.fn = async (p) => p.startsWith("Compare") ? "UPDATE" : MERGED + " (unembeddable)";
      await memoryStore(db, { text: DUP, scope: "proj" });
      expect(rowOf(a.id).text).toBe(MERGED + " (unembeddable)");
      expectVectorOf(a.id, OLD);
    });
  });

  describe("memoryUpdate vector", () => {
    test("replaces the vector with the new text's embedding", async () => {
      const a = await memoryStore(db, { text: "the release train leaves on thursdays" });
      await memoryUpdate(db, { id: a.id, text: "the release train leaves on fridays" });
      expectVectorOf(a.id, "the release train leaves on fridays");
    });

    test("keeps the old vector when the new text cannot be embedded", async () => {
      const a = await memoryStore(db, { text: "the release train leaves on mondays" });
      fake.failOn.add("the release train leaves on tuesdays");
      expect((await memoryUpdate(db, { id: a.id, text: "the release train leaves on tuesdays" })).updated).toBe(true);
      expect(rowOf(a.id).text).toBe("the release train leaves on tuesdays");
      expectVectorOf(a.id, "the release train leaves on mondays");
    });
  });

  describe("text-only memoryUpdate on a compacted row", () => {
    test("short new text: becomes the whole row, original/description/draft dropped, hash follows", async () => {
      const A = longText("alpha");
      const a = await memoryStore(db, { text: A, metadata: { source: "unit" } });
      const before = rowOf(a.id);
      expect(before.meta.original).toBe(A);
      expect(before.meta.status).toBe("draft");

      const NEW = "alpha storage review moved to the second week of the month";
      await memoryUpdate(db, { id: a.id, text: NEW });
      const after = rowOf(a.id);
      expect(after.text).toBe(NEW);
      expect(after.meta.original).toBeUndefined();
      expect(after.meta.description).toBeUndefined();
      expect(after.meta.status).toBeUndefined();
      expect(after.meta.source).toBe("unit");
      expect(after.meta.actor).toBe(before.meta.actor);
      expect(after.content_hash).toBe(contentHash(NEW));
      expectVectorOf(a.id, NEW);

      const concept = new SqliteConceptSource(db).getConcept(buildMemoryId("global", a.id))!;
      expect(concept.body).toBe(NEW);
      // The replaced full text stays recoverable from memory_history.
      const hist = db.prepare(`SELECT old_value, new_value FROM memory_history WHERE memory_id = ? AND action = 'UPDATE'`).get(a.id) as { old_value: string; new_value: string };
      expect(hist).toEqual({ old_value: A, new_value: NEW });
      // Exact dedup now matches the new text, not the old original.
      expect((await memoryStore(db, { text: NEW })).status).toBe("duplicate");
      expect((await memoryStore(db, { text: A })).status).toBe("created");
    });

    test("long new text: compacted again like the write path, original and hash follow", async () => {
      const A = longText("alpha");
      const B = longText("bravo");
      const a = await memoryStore(db, { text: A });
      await memoryUpdate(db, { id: a.id, text: B });
      const after = rowOf(a.id);
      const { body, description } = heuristicCompact(B);
      expect(after.text).toBe(body);
      expect(after.meta.original).toBe(B);
      expect(after.meta.description).toBe(description);
      expect(after.meta.status).toBe("draft");
      expect(after.content_hash).toBe(contentHash(B));
      expectVectorOf(a.id, body);
      expect(new SqliteConceptSource(db).getConcept(buildMemoryId("global", a.id))!.body).toBe(B);
      expect((await memoryStore(db, { text: B })).status).toBe("duplicate");
    });

    test("LOTL_OKF=off: the long new text is stored whole and the stale original is dropped", async () => {
      const A = longText("alpha");
      const B = longText("bravo");
      const a = await memoryStore(db, { text: A });
      process.env.LOTL_OKF = "off";
      await memoryUpdate(db, { id: a.id, text: B });
      const after = rowOf(a.id);
      expect(after.text).toBe(B);
      expect(after.meta.original).toBeUndefined();
      expect(after.meta.status).toBeUndefined();
      expect(after.content_hash).toBe(contentHash(B));
    });

    test("an uncompacted row updated with an over-budget text is compacted, as a store would be", async () => {
      const a = await memoryStore(db, { text: "short note about the storage review" });
      const B = longText("charlie");
      await memoryUpdate(db, { id: a.id, text: B });
      const after = rowOf(a.id);
      expect(after.meta.original).toBe(B);
      expect(after.text).toBe(heuristicCompact(B).body);
      expect(after.content_hash).toBe(contentHash(B));
    });

    test("text with explicit metadata is taken as given (the memory compact path)", async () => {
      const a = await memoryStore(db, { text: "plain row" });
      await memoryUpdate(db, { id: a.id, text: "body", metadata: { original: "the full original", description: "d" } });
      const after = rowOf(a.id);
      expect(after.text).toBe("body");
      expect(after.meta).toEqual({ original: "the full original", description: "d" });
      expect(after.content_hash).toBe(contentHash("the full original"));
    });

    test("a non-draft status set by the user survives a text-only update", async () => {
      const a = await memoryStore(db, { text: "row with a status", metadata: { status: "pinned" } });
      await memoryUpdate(db, { id: a.id, text: "row with a status, edited" });
      expect(rowOf(a.id).meta.status).toBe("pinned");
    });
  });
});
