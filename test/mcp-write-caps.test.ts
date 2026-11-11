/**
 * Input caps on MCP write tools: an over-limit call returns a normal tool error
 * (isError) naming the field and the limit, writes nothing, and the server keeps
 * serving. Temp index only.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";
import {
  MCP_MAX_MEMORY_TEXT_CHARS,
  MCP_MAX_BATCH_ITEMS,
  MCP_MAX_KNOWLEDGE_FIELD_CHARS,
  MCP_MAX_EXTRACT_TEXT_CHARS,
  MCP_MAX_METADATA_CHARS,
  MCP_MAX_SCOPE_CHARS,
  MCP_MAX_SCOPES,
} from "../src/store/constants.js";

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
  dir = mkdtempSync(join(tmpdir(), "lotl-caps-"));
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

const tooBig = (len: number) => "x".repeat(len + 1);

describe("MCP write tool caps", () => {
  test("limits are the documented values", () => {
    expect(MCP_MAX_MEMORY_TEXT_CHARS).toBe(64 * 1024);
    expect(MCP_MAX_KNOWLEDGE_FIELD_CHARS).toBe(1024);
    expect(MCP_MAX_EXTRACT_TEXT_CHARS).toBe(256 * 1024);
  });

  test("memory_add: text over the limit is a tool error naming field and limit", async () => {
    const r = await call("memory_add", { text: tooBig(MCP_MAX_MEMORY_TEXT_CHARS) });
    expect(r.isError).toBe(true);
    expect(msg(r)).toMatch(/memory_add/);
    expect(msg(r)).toMatch(/text/);
    expect(msg(r)).toContain(String(MCP_MAX_MEMORY_TEXT_CHARS));
  });

  test("memory_add: oversized metadata and scope are refused", async () => {
    const m = await call("memory_add", { text: "small note one", metadata: { blob: tooBig(MCP_MAX_METADATA_CHARS) } });
    expect(m.isError).toBe(true);
    expect(msg(m)).toMatch(/metadata/);
    const s = await call("memory_add", { text: "small note one", scope: tooBig(MCP_MAX_SCOPE_CHARS) });
    expect(s.isError).toBe(true);
    expect(msg(s)).toMatch(/scope/);
  });

  test("memory_add: text at the limit is accepted", async () => {
    const r = await call("memory_add", { text: "a".repeat(MCP_MAX_MEMORY_TEXT_CHARS) });
    expect(r.isError).not.toBe(true);
    expect(msg(r)).toMatch(/Memory stored|Duplicate/);
  });

  test("memory_add_batch: too many items, oversized item text, oversized turns", async () => {
    const many = await call("memory_add_batch", { items: Array.from({ length: MCP_MAX_BATCH_ITEMS + 1 }, () => ({ text: "t" })) });
    expect(many.isError).toBe(true);
    expect(msg(many)).toMatch(/items/);
    expect(msg(many)).toContain(String(MCP_MAX_BATCH_ITEMS));

    const big = await call("memory_add_batch", { items: [{ text: "fine" }, { text: tooBig(MCP_MAX_MEMORY_TEXT_CHARS) }] });
    expect(big.isError).toBe(true);
    expect(msg(big)).toMatch(/items\[1\]\.text/);
    expect(msg(big)).toContain(String(MCP_MAX_MEMORY_TEXT_CHARS));

    const turns = await call("memory_add_batch", { items: [{ turns: [{ role: "user", content: tooBig(MCP_MAX_MEMORY_TEXT_CHARS) }] }] });
    expect(turns.isError).toBe(true);
    expect(msg(turns)).toMatch(/items\[0\]\.turns/);
  });

  test("memory_update: oversized text is refused", async () => {
    const r = await call("memory_update", { id: "none", text: tooBig(MCP_MAX_MEMORY_TEXT_CHARS) });
    expect(r.isError).toBe(true);
    expect(msg(r)).toMatch(/memory_update/);
  });

  test("memory_extract: oversized text is refused", async () => {
    const r = await call("memory_extract", { text: tooBig(MCP_MAX_EXTRACT_TEXT_CHARS) });
    expect(r.isError).toBe(true);
    expect(msg(r)).toMatch(/memory_extract/);
    expect(msg(r)).toContain(String(MCP_MAX_EXTRACT_TEXT_CHARS));
  });

  test("memory_register_scopes: too many or oversized scope keys are refused", async () => {
    const many = await call("memory_register_scopes", { scopes: Array.from({ length: MCP_MAX_SCOPES + 1 }, (_, i) => `s${i}`), dimensions: 4 });
    expect(many.isError).toBe(true);
    expect(msg(many)).toContain(String(MCP_MAX_SCOPES));
    const big = await call("memory_register_scopes", { scopes: [tooBig(MCP_MAX_SCOPE_CHARS)], dimensions: 4 });
    expect(big.isError).toBe(true);
    expect(msg(big)).toMatch(/scopes\[0\]/);
  });

  test.each(["subject", "predicate", "object"])("knowledge_add: %s over the limit is refused", async (field) => {
    const args: Record<string, string> = { subject: "alpha", predicate: "uses", object: "beta" };
    args[field] = tooBig(MCP_MAX_KNOWLEDGE_FIELD_CHARS);
    const r = await call("knowledge_add", args);
    expect(r.isError).toBe(true);
    expect(msg(r)).toContain(field);
    expect(msg(r)).toContain(String(MCP_MAX_KNOWLEDGE_FIELD_CHARS));
  });

  test("knowledge_add: fields at the limit are accepted", async () => {
    const r = await call("knowledge_add", { subject: "a".repeat(MCP_MAX_KNOWLEDGE_FIELD_CHARS), predicate: "uses", object: "b" });
    expect(r.isError).not.toBe(true);
    expect(msg(r)).toMatch(/Fact stored/);
  });

  test("the session keeps serving after refused calls", async () => {
    const r = await call("memory_stats", {});
    expect(r.isError).not.toBe(true);
  });
});
