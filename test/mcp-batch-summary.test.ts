/**
 * memory_add_batch text summary counts per-item errors (and names the first
 * message), not only created and duplicate. Temp index only, no embed provider.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";

let handle: HttpServerHandle;
let dir: string;
let sid: string;
let n = 100;
const saved: Record<string, string | undefined> = {};

async function rpc(body: object, session?: string) {
  const res = await fetch(`http://localhost:${handle.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session, "mcp-protocol-version": "2025-03-26" } : {}),
    },
    body: JSON.stringify(body),
  });
  return { res, json: await res.json() };
}
async function call(name: string, args: Record<string, unknown>) {
  const { res, json } = await rpc({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }, sid);
  expect(res.status).toBe(200);
  return json.result ?? { isError: true, content: [{ text: JSON.stringify(json.error) }] };
}
const msg = (r: any) => String(r.content?.[0]?.text ?? "");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lotl-batch-summary-"));
  for (const [k, v] of Object.entries({ INDEX_PATH: join(dir, "idx.sqlite"), LOTL_CONFIG_DIR: join(dir, "cfg"), LOTL_RECALL_NO_TOUCH: "on" })) {
    saved[k] = process.env[k]; process.env[k] = v;
  }
  handle = await startMcpHttpServer(0, { quiet: true });
  const { res } = await rpc({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  sid = res.headers.get("mcp-session-id")!;
});
afterAll(async () => {
  await handle.stop();
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("MCP memory_add_batch summary", () => {
  test("counts created and duplicate as before when nothing failed", async () => {
    const r = await call("memory_add_batch", { items: [{ text: "summary probe alpha", scope: "sum1" }, { text: "summary probe alpha", scope: "sum1" }] });
    expect(r.isError).toBeFalsy();
    expect(msg(r)).toBe("Batched 2 memories: 1 created, 1 duplicate.");
  });

  test("counts errors and names the first message", async () => {
    const r = await call("memory_add_batch", {
      items: [
        { text: "summary probe beta", scope: "sum2" },
        { text: "   ", scope: "sum2" },
        { text: "<private>hidden words</private>", scope: "sum2" },
        { text: "summary probe beta", scope: "sum2" },
      ],
    });
    expect(r.isError).toBeFalsy();
    const text = msg(r);
    expect(text).toContain("Batched 4 memories: 1 created, 1 duplicate, 2 errors.");
    expect(text).toContain("First error (item 1): ");
    const results = r.structuredContent.results;
    expect(text).toContain(results[1].error);
    expect(results.map((x: any) => x.status)).toEqual(["created", "error", "error", "duplicate"]);
    expect(text).not.toContain("hidden words");
  });

  test("a single error reads as 1 error", async () => {
    const r = await call("memory_add_batch", { items: [{ text: " ", scope: "sum3" }] });
    expect(msg(r)).toContain("0 created, 0 duplicate, 1 error.");
  });
});
