/**
 * memoryStore + LOTL_MEMORY_CONFLICT. Embeddings and chat are mocked: a
 * hashed bag-of-words vector (identical words => cosine 1.0) and a scripted
 * chat reply, so no model or server is needed.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fake = vi.hoisted(() => {
  const DIM = 64;
  const embed = (text: string): number[] => {
    const v = new Array<number>(DIM).fill(0);
    // Digits are ignored so "VM 104" and "VM 105" embed identically: the
    // near-duplicate case where a wrong LLM call loses one of them.
    for (const tok of text.toLowerCase().replace(/\d+/g, " ").split(/\W+/).filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
      v[(h >>> 0) % DIM]! += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map(x => x / n);
  };
  return { DIM, embed, chat: { fn: async (_p: string): Promise<string | null> => "NONE", prompts: [] as string[] } };
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
const { memoryStore, extractAndStore } = await import("../src/memory/index.js");

const OLD = "Restore test of VM 104 took 23 minutes for 41 GB.";
const NEW = "Restore test of VM 105 took 58 minutes for 120 GB.";

describe("LOTL_MEMORY_CONFLICT", () => {
  let tmp: string;
  let db: any;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.LOTL_MEMORY_CONFLICT;
    fake.chat.prompts = [];
    fake.chat.fn = async () => "NONE";
    tmp = mkdtempSync(join(tmpdir(), "lotl-conflict-mode-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
    db.exec(`CREATE VIRTUAL TABLE memories_vec USING vec0(scope TEXT PARTITION KEY, id TEXT PRIMARY KEY, embedding float[${fake.DIM}] distance_metric=cosine)`);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    if (saved === undefined) delete process.env.LOTL_MEMORY_CONFLICT; else process.env.LOTL_MEMORY_CONFLICT = saved;
    rmSync(tmp, { recursive: true, force: true });
  });

  const texts = () => (db.prepare(`SELECT text FROM memories ORDER BY created_at, rowid`).all() as { text: string }[]).map(r => r.text);
  const history = () => db.prepare(`SELECT action, old_value, new_value FROM memory_history ORDER BY id`).all() as { action: string; old_value: string | null; new_value: string | null }[];
  const TEA = "David prefers tea in the morning before the daily standup meeting at work with the team";
  const COFFEE = "David prefers coffee in the morning before the daily standup meeting at work with the team";

  test("default (llm): a wrong DELETE removes the existing memory, as before", async () => {
    delete process.env.LOTL_MEMORY_CONFLICT;
    await memoryStore(db, { text: OLD });
    fake.chat.fn = async () => "DELETE";
    await memoryStore(db, { text: NEW });
    expect(texts()).toEqual([NEW]);
  });

  test("guarded: DELETE keeps both", async () => {
    process.env.LOTL_MEMORY_CONFLICT = "guarded";
    await memoryStore(db, { text: OLD });
    fake.chat.fn = async () => "DELETE";
    const r = await memoryStore(db, { text: NEW });
    expect(r.status).toBe("created");
    expect(texts()).toEqual([OLD, NEW]);
  });

  test("guarded: NONE that would drop new numbers stores the new memory", async () => {
    process.env.LOTL_MEMORY_CONFLICT = "guarded";
    await memoryStore(db, { text: OLD });
    fake.chat.fn = async () => "NONE";
    expect((await memoryStore(db, { text: NEW })).status).toBe("created");
    expect(texts()).toEqual([OLD, NEW]);
  });

  test("guarded: lossy UPDATE merge keeps both rows unchanged", async () => {
    process.env.LOTL_MEMORY_CONFLICT = "guarded";
    await memoryStore(db, { text: OLD });
    fake.chat.fn = async (p) => (p.startsWith("Compare") ? "UPDATE" : "Restore test of VM 104 took 23 minutes.");
    await memoryStore(db, { text: NEW });
    expect(texts()).toEqual([OLD, NEW]);
  });

  test("guarded: true duplicate still dedups", async () => {
    process.env.LOTL_MEMORY_CONFLICT = "guarded";
    const a = await memoryStore(db, { text: "the deploy pipeline runs every night" });
    fake.chat.fn = async () => "NONE";
    expect(await memoryStore(db, { text: "The deploy pipeline runs every night." })).toEqual({ id: a.id, status: "duplicate", duplicate_id: a.id });
  });

  test("llm: UPDATE rewrites the existing row, recomputes the hash and logs history", async () => {
    delete process.env.LOTL_MEMORY_CONFLICT;
    const a = await memoryStore(db, { text: OLD });
    const merged = "Restore tests: VM 104 took 23 minutes for 41 GB, VM 105 took 58 minutes for 120 GB.";
    fake.chat.fn = async (p) => (p.startsWith("Compare") ? "UPDATE" : merged);
    expect(await memoryStore(db, { text: NEW })).toEqual({ id: a.id, status: "duplicate", duplicate_id: a.id });
    expect(texts()).toEqual([merged]);
    const { memoryRowHash } = await import("../src/memory/hash.js");
    const row = db.prepare(`SELECT content_hash, metadata FROM memories WHERE id = ?`).get(a.id) as { content_hash: string; metadata: string | null };
    expect(row.content_hash).toBe(memoryRowHash(merged, row.metadata));
    expect(history().at(-1)).toEqual({ action: "UPDATE", old_value: OLD, new_value: merged });
  });

  test("llm: a thrown chat error keeps the old behaviour (near-duplicate dropped)", async () => {
    delete process.env.LOTL_MEMORY_CONFLICT;
    await memoryStore(db, { text: OLD });
    fake.chat.fn = async () => { throw new Error("boom"); };
    expect((await memoryStore(db, { text: NEW })).status).toBe("duplicate");
    expect(texts()).toEqual([OLD]);
  });

  test("guarded: UPDATE with a clean merge still never rewrites; no merge call is made", async () => {
    process.env.LOTL_MEMORY_CONFLICT = "guarded";
    await memoryStore(db, { text: TEA });
    fake.chat.fn = async (p) => (p.startsWith("Compare") ? "UPDATE" : COFFEE);
    expect((await memoryStore(db, { text: COFFEE })).status).toBe("created");
    expect(texts()).toEqual([TEA, COFFEE]);
    expect(fake.chat.prompts).toHaveLength(1);
    expect(history().map(h => h.action)).toEqual(["ADD", "ADD"]);
  });

  test("guarded: a null reply (timeout, HTTP error) does not drop a new fact", async () => {
    process.env.LOTL_MEMORY_CONFLICT = "guarded";
    await memoryStore(db, { text: OLD });
    fake.chat.fn = async () => null;
    expect((await memoryStore(db, { text: NEW })).status).toBe("created");
    expect(texts()).toEqual([OLD, NEW]);
  });

  test("guarded: a thrown chat error does not drop a new fact", async () => {
    process.env.LOTL_MEMORY_CONFLICT = "guarded";
    await memoryStore(db, { text: OLD });
    fake.chat.fn = async () => { throw new Error("boom"); };
    expect((await memoryStore(db, { text: NEW })).status).toBe("created");
    expect(texts()).toEqual([OLD, NEW]);
  });

  test("guarded: a null reply still dedups a restatement with no new words", async () => {
    process.env.LOTL_MEMORY_CONFLICT = "guarded";
    const a = await memoryStore(db, { text: "the deploy pipeline runs every night" });
    fake.chat.fn = async () => null;
    expect((await memoryStore(db, { text: "The deploy pipeline runs every night." })).duplicate_id).toBe(a.id);
  });

  test("notes extraction drives the real memoryStore (subject prefix, scope, actor)", async () => {
    const savedStyle = process.env.LOTL_EXTRACT_PROMPT;
    process.env.LOTL_EXTRACT_PROMPT = "notes";
    try {
      fake.chat.fn = async (p) => (p.startsWith("Turn these notes")
        ? "PROJECT: NAS\nTOPIC: backups\n[decision] Nightly backups moved to restic on B2, keeping 7 daily snapshots.\n[fact] Restore of the photos share has not been tested yet."
        : "NONE");
      const r = await extractAndStore(db, "Backup work. Moved nightly NAS backups to restic on B2, keeping 7 daily. Restore of the photos share is not tested yet.", "nas");
      expect(r.stored).toBeGreaterThanOrEqual(2);
      const rows = db.prepare(`SELECT text, scope, category, metadata FROM memories`).all() as { text: string; scope: string; category: string; metadata: string }[];
      expect(rows.map(x => x.text)).toEqual(expect.arrayContaining([
        "NAS: Nightly backups moved to restic on B2, keeping 7 daily snapshots.",
        "NAS, backups: Restore of the photos share has not been tested yet.",
      ]));
      expect(rows.every(x => x.scope === "nas")).toBe(true);
      expect(rows.some(x => x.category === "decision")).toBe(true);
      expect(JSON.parse(rows[0]!.metadata).actor).toBe("process:lotl/extractor");
    } finally {
      if (savedStyle === undefined) delete process.env.LOTL_EXTRACT_PROMPT; else process.env.LOTL_EXTRACT_PROMPT = savedStyle;
    }
  });

  test("unknown value behaves as guarded", async () => {
    process.env.LOTL_MEMORY_CONFLICT = "guard-typo-mode-test";
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await memoryStore(db, { text: OLD });
      fake.chat.fn = async () => "DELETE";
      expect((await memoryStore(db, { text: NEW })).status).toBe("created");
      expect(texts()).toEqual([OLD, NEW]);
    } finally {
      err.mockRestore();
    }
  });

  test("off: the LLM is never asked and a near-duplicate is a duplicate (no-LLM behaviour)", async () => {
    process.env.LOTL_MEMORY_CONFLICT = "off";
    const a = await memoryStore(db, { text: OLD });
    fake.chat.fn = async () => "ADD";
    expect((await memoryStore(db, { text: NEW })).status).toBe("duplicate");
    expect(fake.chat.prompts).toHaveLength(0);
    expect(texts()).toEqual([OLD]);
    expect(a.status).toBe("created");
  });
});
