/**
 * Cosine dedup and LLM conflict resolution stay inside the store's scope.
 * A near-duplicate in another scope is not a duplicate, and the conflict
 * step can never UPDATE or DELETE a memory of another scope.
 * Embeddings and chat are mocked (bag-of-words vector, scripted reply).
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
  return { DIM, embed, chat: { reply: "DELETE" as string | null, prompts: [] as string[] } };
});

vi.mock("../src/remote-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/remote-config.js")>();
  const remote = {
    embed: async (t: string) => ({ embedding: fake.embed(t) }),
    embedBatch: async (ts: string[]) => ts.map(t => ({ embedding: fake.embed(t) })),
    chatComplete: async (p: string) => { fake.chat.prompts.push(p); return fake.chat.reply; },
  };
  return { ...actual, getRemoteConfig: () => ({ embed: { provider: "api", apiKey: "test" } }), getRemoteLLM: () => remote };
});

const { openDatabase } = await import("../src/db.js");
const { initializeDatabase } = await import("../src/store/db-init.js");
const { memoryStore } = await import("../src/memory/index.js");

describe("cosine dedup is per scope", () => {
  let tmp: string;
  let db: any;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.LOTL_MEMORY_CONFLICT;
    delete process.env.LOTL_MEMORY_CONFLICT; // llm: the destructive mode
    fake.chat.prompts = [];
    fake.chat.reply = "DELETE";
    tmp = mkdtempSync(join(tmpdir(), "lotl-dedup-scope-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
    db.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(scope TEXT PARTITION KEY, id TEXT PRIMARY KEY, embedding float[${fake.DIM}] distance_metric=cosine)`);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    if (saved === undefined) delete process.env.LOTL_MEMORY_CONFLICT; else process.env.LOTL_MEMORY_CONFLICT = saved;
    rmSync(tmp, { recursive: true, force: true });
  });

  const rows = () => db.prepare(`SELECT text, scope FROM memories ORDER BY created_at, rowid`).all() as { text: string; scope: string }[];

  test("a near-duplicate in another scope is stored, and the other scope's row is untouched", async () => {
    await memoryStore(db, { text: "the nightly deploy pipeline runs at two", scope: "proj-a" });
    const r = await memoryStore(db, { text: "The nightly deploy pipeline runs at two.", scope: "proj-b" });
    expect(r.status).toBe("created");
    expect(fake.chat.prompts).toHaveLength(0);
    expect(rows()).toEqual([
      { text: "the nightly deploy pipeline runs at two", scope: "proj-a" },
      { text: "The nightly deploy pipeline runs at two.", scope: "proj-b" },
    ]);
  });

  test("within one scope the conflict step still runs", async () => {
    await memoryStore(db, { text: "the nightly deploy pipeline runs at two", scope: "proj-a" });
    fake.chat.reply = "NONE";
    const r = await memoryStore(db, { text: "The nightly deploy pipeline runs at two.", scope: "proj-a" });
    expect(r.status).toBe("duplicate");
    expect(fake.chat.prompts).toHaveLength(1);
  });
});
