/**
 * createMcpServer runs the startup decay pass once per database, not once per
 * server. `lotl mcp --http` builds an McpServer per session, so every new
 * session used to run a full decay pass (~45 ms and a write transaction over
 * every memory at 25k memories, measured 2026-11-10).
 */

import { describe, test, expect, vi } from "vitest";

const decay = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("../src/memory/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/memory/index.js")>();
  return {
    ...actual,
    runDecayPass: (db: unknown) => {
      decay.calls.push(db);
      return { processed: 0, promoted: 0, demoted: 0, stale: 0 };
    },
  };
});

const { createMcpServer } = await import("../src/mcp/server.js");

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("createMcpServer startup decay", () => {
  test("runs once per database across many servers (HTTP sessions)", async () => {
    const dbA = {};
    const storeA = { internal: { db: dbA } } as any;
    for (let i = 0; i < 5; i++) await createMcpServer(storeA);
    await settle();
    expect(decay.calls.filter((d) => d === dbA)).toHaveLength(1);

    const dbB = {};
    await createMcpServer({ internal: { db: dbB } } as any);
    await settle();
    expect(decay.calls.filter((d) => d === dbB)).toHaveLength(1);
  });
});
