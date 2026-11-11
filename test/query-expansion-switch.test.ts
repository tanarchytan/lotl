/**
 * LOTL_QUERY_EXPANSION=off turns off LLM query expansion (document search
 * and memory recall) while the LOTL_QUERY_EXPANSION_* provider stays set for
 * the other chat operations (extraction, conflict resolution, reflect).
 * Added after Gemma 4 E2B expansions were measured as echoes of the query
 * (devnotes/metrics/local-llm-e2b-2026-11-11.md). Remote LLM is mocked.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fake = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("../src/remote-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/remote-config.js")>();
  const remote = {
    expandQuery: async (q: string) => {
      fake.calls.push(q);
      return [{ type: "lex", text: `${q} synonymword` }, { type: "vec", text: q }];
    },
    chatComplete: async () => null,
  };
  return {
    ...actual,
    getRemoteConfig: () => ({ queryExpansion: { provider: "api", apiKey: "k", url: "http://127.0.0.1:1/v1" } }),
    getRemoteLLM: () => remote,
  };
});

const { expandQuery } = await import("../src/store/search.js");
const { openDatabase } = await import("../src/db.js");
const { initializeDatabase } = await import("../src/store/db-init.js");
const { memoryStore, memoryRecall } = await import("../src/memory/index.js");
const { queryExpansionEnabled } = await import("../src/remote-config.js");

describe("LOTL_QUERY_EXPANSION", () => {
  let saved: string | undefined;
  let tmp: string;
  let db: any;

  beforeEach(() => {
    saved = process.env.LOTL_QUERY_EXPANSION;
    fake.calls = [];
    tmp = mkdtempSync(join(tmpdir(), "lotl-qe-switch-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
  });
  afterEach(() => {
    try { db.close(); } catch {}
    if (saved === undefined) delete process.env.LOTL_QUERY_EXPANSION; else process.env.LOTL_QUERY_EXPANSION = saved;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("queryExpansionEnabled: only 'off' (trimmed, any case) disables", () => {
    delete process.env.LOTL_QUERY_EXPANSION;
    expect(queryExpansionEnabled()).toBe(true);
    process.env.LOTL_QUERY_EXPANSION = " OFF ";
    expect(queryExpansionEnabled()).toBe(false);
    process.env.LOTL_QUERY_EXPANSION = "on";
    expect(queryExpansionEnabled()).toBe(true);
  });

  test("document search: off skips the remote call and returns no expansions", async () => {
    process.env.LOTL_QUERY_EXPANSION = "off";
    expect(await expandQuery("zitadel cookie secret", undefined, db)).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  test("document search: default still expands", async () => {
    delete process.env.LOTL_QUERY_EXPANSION;
    const out = await expandQuery("zitadel cookie secret", undefined, db);
    expect(fake.calls).toEqual(["zitadel cookie secret"]);
    expect(out.length).toBeGreaterThan(0);
  });

  test("memory recall: off never calls the LLM; default does (no FTS hit, so no strong signal)", async () => {
    for (const t of ["Zitadel stores the cookie secret in a file", "Proxmox backups run nightly", "Restic keeps seven daily snapshots"]) {
      await memoryStore(db, { text: t });
    }
    delete process.env.LOTL_QUERY_EXPANSION;
    await memoryRecall(db, { query: "kubernetes ingress controller", limit: 5 });
    expect(fake.calls.length).toBeGreaterThan(0);
    fake.calls = [];
    process.env.LOTL_QUERY_EXPANSION = "off";
    await memoryRecall(db, { query: "kubernetes ingress controller", limit: 5 });
    expect(fake.calls).toHaveLength(0);
  });
});
