/**
 * DNS-rebinding guard (Host/Origin) on `lotl mcp --http` and `lotl memory serve`,
 * plus idle expiry and the session cap on the MCP HTTP transport.
 * All runs use temp indexes; servers bind loopback on ephemeral ports.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { startMemoryServer } from "../src/memory/server.js";
import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";

type Res = { status: number; headers: Record<string, any>; body: string };

/** Raw request so Host and Origin can be forged (fetch forbids setting Host). */
function raw(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const INIT = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
});
const PING = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
const mcpHeaders = (port: number, extra: Record<string, string> = {}) => ({
  host: `localhost:${port}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  ...extra,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("MCP HTTP: Host/Origin guard", () => {
  let handle: HttpServerHandle;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lotl-guard-"));
    setEnv("INDEX_PATH", join(dir, "idx.sqlite"));
    setEnv("LOTL_CONFIG_DIR", join(dir, "cfg"));
    setEnv("LOTL_RECALL_NO_TOUCH", "on");
    handle = await startMcpHttpServer(0, { quiet: true });
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("accepts localhost:PORT and 127.0.0.1:PORT on /mcp", async () => {
    for (const host of [`localhost:${handle.port}`, `127.0.0.1:${handle.port}`]) {
      const r = await raw(handle.port, "POST", "/mcp", mcpHeaders(handle.port, { host }), INIT);
      expect(r.status).toBe(200);
    }
  });

  test.each(["evil.example", "localhost.evil.example", "evil.example:80", "evil.com:127.0.0.1", "127.0.0.1.evil.example"])(
    "refuses Host %s with 403 on /mcp, /health and /query", async (host) => {
      const h = mcpHeaders(handle.port, { host });
      const mcp = await raw(handle.port, "POST", "/mcp", h, INIT);
      expect(mcp.status).toBe(403);
      expect(JSON.parse(mcp.body).error).toMatch(/Host/);
      expect((await raw(handle.port, "GET", "/health", { host })).status).toBe(403);
      expect((await raw(handle.port, "POST", "/query", h, "{}")).status).toBe(403);
    });

  test("host check is case-insensitive", async () => {
    const r = await raw(handle.port, "GET", "/health", { host: `LocalHost:${handle.port}` });
    expect(r.status).toBe(200);
  });

  test("loopback Origin accepted, missing Origin accepted, foreign Origin refused", async () => {
    const ok = await raw(handle.port, "POST", "/mcp", mcpHeaders(handle.port, { origin: `http://localhost:${handle.port}` }), INIT);
    expect(ok.status).toBe(200);
    const ok6 = await raw(handle.port, "GET", "/health", { host: "[::1]", origin: "http://[::1]:3000" });
    expect(ok6.status).toBe(200);
    const none = await raw(handle.port, "GET", "/health", { host: `localhost:${handle.port}` });
    expect(none.status).toBe(200);
    for (const origin of ["http://evil.example", "http://localhost.evil.example", "null", "file://"]) {
      const bad = await raw(handle.port, "GET", "/health", { host: `localhost:${handle.port}`, origin });
      expect(bad.status).toBe(403);
      expect(JSON.parse(bad.body).error).toMatch(/Origin/);
    }
  });

  test("a refused request creates no session", async () => {
    const before = handle.sessionCount();
    const r = await raw(handle.port, "POST", "/mcp", mcpHeaders(handle.port, { host: "evil.example" }), INIT);
    expect(r.status).toBe(403);
    expect(r.headers["mcp-session-id"]).toBeUndefined();
    const r2 = await raw(handle.port, "POST", "/mcp", mcpHeaders(handle.port, { origin: "http://evil.example" }), INIT);
    expect(r2.status).toBe(403);
    expect(handle.sessionCount()).toBe(before);
  });

  test("LOTL_HTTP_ALLOWED_HOSTS / LOTL_HTTP_ALLOWED_ORIGINS admit extras", async () => {
    const h = mcpHeaders(handle.port, { host: "lotl.internal:8443", origin: "https://app.internal" });
    expect((await raw(handle.port, "POST", "/mcp", h, INIT)).status).toBe(403);
    setEnv("LOTL_HTTP_ALLOWED_HOSTS", "other.example, LOTL.internal");
    setEnv("LOTL_HTTP_ALLOWED_ORIGINS", "https://app.internal");
    expect((await raw(handle.port, "POST", "/mcp", h, INIT)).status).toBe(200);
    // still exact: a suffix of an allowed host is not allowed
    const sub = await raw(handle.port, "GET", "/health", { host: "x.lotl.internal" });
    expect(sub.status).toBe(403);
  });
});

describe("MCP HTTP: session cleanup", () => {
  let handle: HttpServerHandle | undefined;
  let dir: string;

  const start = async () => {
    dir = mkdtempSync(join(tmpdir(), "lotl-sess-"));
    setEnv("INDEX_PATH", join(dir, "idx.sqlite"));
    setEnv("LOTL_CONFIG_DIR", join(dir, "cfg"));
    setEnv("LOTL_RECALL_NO_TOUCH", "on");
    handle = await startMcpHttpServer(0, { quiet: true });
    return handle;
  };
  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const open = async (h: HttpServerHandle) => {
    const r = await raw(h.port, "POST", "/mcp", mcpHeaders(h.port), INIT);
    expect(r.status).toBe(200);
    return r.headers["mcp-session-id"] as string;
  };
  const ping = (h: HttpServerHandle, sid: string) =>
    raw(h.port, "POST", "/mcp", mcpHeaders(h.port, { "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" }), PING);

  test("DELETE frees the session", async () => {
    const h = await start();
    const sid = await open(h);
    expect(h.sessionCount()).toBe(1);
    const del = await raw(h.port, "DELETE", "/mcp", mcpHeaders(h.port, { "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" }));
    expect(del.status).toBe(200);
    expect(h.sessionCount()).toBe(0);
    expect((await ping(h, sid)).status).toBe(404);
  });

  test("idle session is expired by the sweep; later request gets unknown-session 404", async () => {
    setEnv("LOTL_MCP_SESSION_IDLE_MS", "200");
    const h = await start();
    const sid = await open(h);
    expect((await ping(h, sid)).status).toBe(200);
    await sleep(900);
    expect(h.sessionCount()).toBe(0);
    const r = await ping(h, sid);
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).error.message).toBe("Session not found");
  });

  test("cap evicts the least recently used session; an active session survives", async () => {
    setEnv("LOTL_MCP_MAX_SESSIONS", "3");
    const h = await start();
    const a = await open(h);
    const b = await open(h);
    const c = await open(h);
    await sleep(5);
    expect((await ping(h, a)).status).toBe(200); // a is now fresher than b
    const d = await open(h);                       // evicts b (LRU)
    expect(h.sessionCount()).toBe(3);
    expect((await ping(h, b)).status).toBe(404);
    for (const s of [a, c, d]) expect((await ping(h, s)).status).toBe(200);
    await sleep(5);
    await ping(h, a); await ping(h, d);
    await open(h);                                  // evicts c
    expect((await ping(h, c)).status).toBe(404);
    expect((await ping(h, a)).status).toBe(200);
  });

  test("stop clears the sweep timer and sessions", async () => {
    setEnv("LOTL_MCP_SESSION_IDLE_MS", "200");
    const h = await start();
    await open(h);
    await h.stop();
    expect(h.sessionCount()).toBe(0);
  });
});

describe("memory serve: Host/Origin guard", () => {
  let server: Server;
  let db: ReturnType<typeof openDatabase>;
  let dir: string;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lotl-memguard-"));
    db = openDatabase(join(dir, "t.sqlite"));
    initializeDatabase(db);
    server = await startMemoryServer(db, { host: "127.0.0.1", port: 0 });
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  test("accepts localhost and 127.0.0.1 hosts, no Origin or loopback Origin", async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      expect((await raw(port, "GET", "/api/stats", { host })).status).toBe(200);
    }
    expect((await raw(port, "GET", "/api/stats", { host: `localhost:${port}`, origin: `http://127.0.0.1:${port}` })).status).toBe(200);
  });

  test.each(["evil.example", "localhost.evil.example", "evil.com:127.0.0.1"])("refuses Host %s", async (host) => {
    for (const [m, p] of [["GET", "/"], ["GET", "/api/memories"], ["DELETE", "/api/memory/x"]] as const) {
      const r = await raw(port, m, p, { host });
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body).error).toMatch(/Host/);
    }
  });

  test("refuses foreign Origin, even with a loopback Host", async () => {
    const r = await raw(port, "DELETE", "/api/memory/x", { host: `localhost:${port}`, origin: "http://evil.example" });
    expect(r.status).toBe(403);
  });

  test("env allow-lists admit an extra host and origin", async () => {
    const h = { host: "mem.internal", origin: "https://mem.internal" };
    expect((await raw(port, "GET", "/api/stats", h)).status).toBe(403);
    setEnv("LOTL_HTTP_ALLOWED_HOSTS", "mem.internal");
    setEnv("LOTL_HTTP_ALLOWED_ORIGINS", "https://mem.internal");
    expect((await raw(port, "GET", "/api/stats", h)).status).toBe(200);
  });
});
