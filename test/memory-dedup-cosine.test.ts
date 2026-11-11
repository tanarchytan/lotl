/**
 * Cosine dedup never drops a memory on the strength of compacted bodies.
 *
 * The vector of an OKF-compacted memory is the vector of its body (first
 * lines of the text). Two long memories with the same head have identical
 * bodies, cosine 1.0, so the near-duplicate check (and the LLM conflict
 * resolution behind it) used to drop the second even after exact dedup was
 * fixed. Now: cosine dedup only runs between two uncompacted texts.
 *
 * Embeddings come from a mocked remote provider: a deterministic hashed
 * bag-of-words vector, so identical text gives cosine 1.0 with no model.
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
  return { DIM, embed, chat: { fn: async (_p: string): Promise<string> => "NONE", prompts: [] as string[] } };
});

vi.mock("../src/remote-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/remote-config.js")>();
  const remote = {
    embed: async (t: string) => ({ embedding: fake.embed(t) }),
    embedBatch: async (ts: string[]) => ts.map(t => ({ embedding: fake.embed(t) })),
    chatComplete: async (p: string) => { fake.chat.prompts.push(p); return fake.chat.fn(p); },
  };
  return { ...actual, getRemoteConfig: () => ({ embed: { provider: "api", apiKey: "test" } }), getRemoteLLM: () => remote };
});

const { openDatabase } = await import("../src/db.js");
const { initializeDatabase } = await import("../src/store/db-init.js");
const { memoryStore } = await import("../src/memory/index.js");
const { contentHash } = await import("../src/memory/hash.js");
const { SqliteConceptSource } = await import("../src/okf/source.js");
const { buildMemoryId } = await import("../src/okf/concept.js");
const { heuristicCompact } = await import("../src/okf/budget.js");

const HEAD = Array.from({ length: 6 }, (_, k) => `shared header line ${k} for the nightly backup job report`).join("\n");
const longWith = (tail: string) => `${HEAD}\n${tail} ${"pad ".repeat(150)}`.trim();
const A = longWith("UNIQUE TAIL A: backup FAILED on vol-a");
const B = longWith("UNIQUE TAIL B: backup ok on vol-b");

describe("cosine dedup vs OKF compaction", () => {
  let tmp: string;
  let db: any;
  let savedOkf: string | undefined;

  beforeEach(() => {
    savedOkf = process.env.LOTL_OKF;
    process.env.LOTL_OKF = "on";
    fake.chat.fn = async () => "NONE";
    fake.chat.prompts = [];
    tmp = mkdtempSync(join(tmpdir(), "lotl-dedup-cos-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
    // memoryStore caches "vec table ready" per process, so give every fresh
    // DB the table up front.
    db.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(scope TEXT PARTITION KEY, id TEXT PRIMARY KEY, embedding float[${fake.DIM}] distance_metric=cosine)`);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    if (savedOkf === undefined) delete process.env.LOTL_OKF;
    else process.env.LOTL_OKF = savedOkf;
    rmSync(tmp, { recursive: true, force: true });
  });

  const vecCount = () => (db.prepare(`SELECT count(*) AS n FROM memories_vec`).get() as { n: number }).n;

  test("same head, different tail: stored as new even though bodies are cosine 1.0, LLM never asked", async () => {
    expect(heuristicCompact(A).body).toBe(heuristicCompact(B).body);
    const a = await memoryStore(db, { text: A });
    const b = await memoryStore(db, { text: B });
    expect(a.status).toBe("created");
    expect(b.status).toBe("created");
    expect(vecCount()).toBe(2);
    expect(fake.chat.prompts).toHaveLength(0);

    const src = new SqliteConceptSource(db);
    expect(src.getConcept(buildMemoryId("global", a.id))!.body).toBe(A);
    expect(src.getConcept(buildMemoryId("global", b.id))!.body).toBe(B);
  });

  test("LLM failure fallback (which used to mean duplicate) cannot drop a compacted memory", async () => {
    fake.chat.fn = async () => { throw new Error("provider down"); };
    await memoryStore(db, { text: A });
    expect((await memoryStore(db, { text: B })).status).toBe("created");
  });

  test("short text identical to a compacted row's body does not dedup against it", async () => {
    await memoryStore(db, { text: A });
    const body = heuristicCompact(A).body;
    const s = await memoryStore(db, { text: body });
    expect(s.status).toBe("created");
    expect(fake.chat.prompts).toHaveLength(0);
  });

  test("uncompacted near-duplicates still go through cosine + LLM resolution (unchanged)", async () => {
    const a = await memoryStore(db, { text: "the deploy pipeline runs on node 22 every night" });
    const dup = await memoryStore(db, { text: "The deploy pipeline runs on Node 22 every night." });
    // The trailing "." defeats the (case-insensitive) hash; the bag-of-words
    // vectors are identical, so this is a cosine match.
    expect(dup).toEqual({ id: a.id, status: "duplicate", duplicate_id: a.id });
    expect(fake.chat.prompts).toHaveLength(1);
    expect(fake.chat.prompts[0]).toContain("the deploy pipeline runs on node 22 every night");
  });

  test("LLM UPDATE merge keeps content_hash consistent with the merged text", async () => {
    const a = await memoryStore(db, { text: "backups run nightly at 02:00 on vol-a" });
    fake.chat.fn = async (p: string) => p.startsWith("Compare") ? "UPDATE" : "backups run nightly at 02:00 on vol-a and vol-b";
    const r = await memoryStore(db, { text: "Backups run nightly at 02:00 on vol-a!" });
    expect(r).toEqual({ id: a.id, status: "duplicate", duplicate_id: a.id });
    const row = db.prepare(`SELECT text, content_hash FROM memories WHERE id = ?`).get(a.id) as { text: string; content_hash: string };
    expect(row.text).toBe("backups run nightly at 02:00 on vol-a and vol-b");
    expect(row.content_hash).toBe(contentHash(row.text));
    // And the merged text now exact-dedups.
    fake.chat.fn = async () => "ADD";
    expect((await memoryStore(db, { text: "backups run nightly at 02:00 on vol-a and vol-b" })).status).toBe("duplicate");
  });

  test("LOTL_OKF=off: long texts are not compacted, cosine dedup behaves as before", async () => {
    process.env.LOTL_OKF = "off";
    const a = await memoryStore(db, { text: A });
    const b = await memoryStore(db, { text: B });
    // Full-text vectors of A and B are near-identical (shared head + padding),
    // so with OKF off the pre-existing cosine + LLM path decides: NONE = dup.
    expect(b).toEqual({ id: a.id, status: "duplicate", duplicate_id: a.id });
    expect(fake.chat.prompts).toHaveLength(1);
    expect(fake.chat.prompts[0]).toContain("UNIQUE TAIL A");
    expect(fake.chat.prompts[0]).toContain("UNIQUE TAIL B");
  });
});
