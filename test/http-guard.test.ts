/**
 * DNS-rebinding guard (Host/Origin) on `lotl mcp --http` and `lotl memory serve`,
 * plus idle expiry and the session cap on the MCP HTTP transport.
 * All runs use temp indexes; servers bind loopback on ephemeral ports.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { request, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { checkHostOrigin } from "../src/http-guard.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { startMemoryServer } from "../src/memory/server.js";
import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";

type Res = { status: number; headers: Record<string, any>; body: string };

/** Raw request so Host and Origin can be forged (fetch forbids setting Host). */
function raw(port: number, method: string, path: string, headers: Record<string, string>, body?: string, connectHost = "127.0.0.1"): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: connectHost, port, method, path, headers }, (res) => {
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
/**
 * POST whose body is held open: headers and the first half are sent, the rest
 * only when finish() is called. The server sees a request in flight for exactly
 * as long as the test wants.
 */
function rawHeld(port: number, path: string, headers: Record<string, string>, body: string) {
  const half = Math.floor(body.length / 2);
  let resolveRes!: (r: Res) => void;
  let rejectRes!: (e: Error) => void;
  const done = new Promise<Res>((res, rej) => { resolveRes = res; rejectRes = rej; });
  const req = request({ host: "127.0.0.1", port, method: "POST", path,
    headers: { ...headers, "content-length": String(Buffer.byteLength(body)) } }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolveRes({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on("error", rejectRes);
  req.write(body.slice(0, half));
  return { finish: () => { req.end(body.slice(half)); return done; } };
}
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

  const heldPing = (h: HttpServerHandle, sid: string) =>
    rawHeld(h.port, "/mcp", mcpHeaders(h.port, { "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" }), PING);
  /** Let the server see the request headers before the test acts. */
  const settle = async (h: HttpServerHandle) => { await raw(h.port, "GET", "/health", { host: `localhost:${h.port}` }); await sleep(30); };

  test("a session with a request in flight is not evicted at the cap and its response arrives", async () => {
    setEnv("LOTL_MCP_MAX_SESSIONS", "2");
    const h = await start();
    const a = await open(h);
    await sleep(5);
    const b = await open(h);
    const held = heldPing(h, a);          // a is the LRU and busy
    await settle(h);
    await open(h);                         // must evict b, not a
    expect(h.sessionCount()).toBe(2);
    expect((await ping(h, b)).status).toBe(404);
    const r = await held.finish();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).id).toBe(2);
  });

  test("a session with a request in flight is not expired by the sweep", async () => {
    setEnv("LOTL_MCP_SESSION_IDLE_MS", "200");
    const h = await start();
    const a = await open(h);
    const held = heldPing(h, a);
    await settle(h);
    await sleep(800);                      // several sweeps past the idle limit
    expect(h.sessionCount()).toBe(1);
    const r = await held.finish();
    expect(r.status).toBe(200);
    expect((await ping(h, a)).status).toBe(200); // idle clock restarted at the end
  });

  test("when every session is in flight at the cap, a new initialize still succeeds", async () => {
    setEnv("LOTL_MCP_MAX_SESSIONS", "2");
    const h = await start();
    const a = await open(h);
    const b = await open(h);
    const heldA = heldPing(h, a);
    const heldB = heldPing(h, b);
    await settle(h);
    const c = await open(h);               // soft cap: let it in
    expect(h.sessionCount()).toBe(3);
    expect((await heldA.finish()).status).toBe(200);
    expect((await heldB.finish()).status).toBe(200);
    expect((await ping(h, c)).status).toBe(200);
  });

  test("a session is evictable again once its request has finished", async () => {
    setEnv("LOTL_MCP_MAX_SESSIONS", "1");
    const h = await start();
    const a = await open(h);
    const held = heldPing(h, a);
    await settle(h);
    await open(h);                         // soft cap, a protected
    expect(h.sessionCount()).toBe(2);
    expect((await held.finish()).status).toBe(200);
    await sleep(30);                       // let the response close event land
    await open(h);                         // both idle now: back under the cap
    expect(h.sessionCount()).toBe(1);
    expect((await ping(h, a)).status).toBe(404);
  });

  test("an open GET stream counts as in flight until it closes", async () => {
    setEnv("LOTL_MCP_MAX_SESSIONS", "1");
    const h = await start();
    const a = await open(h);
    const stream = request({ host: "127.0.0.1", port: h.port, method: "GET", path: "/mcp",
      headers: { host: `localhost:${h.port}`, accept: "text/event-stream", "mcp-session-id": a, "mcp-protocol-version": "2025-03-26" } });
    stream.on("response", (res) => res.resume());
    stream.on("error", () => {});
    stream.end();
    await settle(h);
    await open(h);
    expect(h.sessionCount()).toBe(2);      // a protected while the stream is open
    stream.destroy();
    await sleep(50);
    await open(h);
    expect(h.sessionCount()).toBe(1);
    expect((await ping(h, a)).status).toBe(404);
  });

  test("POST /query requires application/json", async () => {
    const h = await start();
    const hd = (ct?: string) => ({ host: `localhost:${h.port}`, ...(ct ? { "content-type": ct } : {}) });
    expect((await raw(h.port, "POST", "/query", hd("text/plain"), "{}")).status).toBe(415);
    expect((await raw(h.port, "POST", "/query", hd(), "{}")).status).toBe(415);
    expect((await raw(h.port, "POST", "/search", hd("application/x-www-form-urlencoded"), "{}")).status).toBe(415);
    // handled: reaches validation (400 missing searches), not 415
    expect((await raw(h.port, "POST", "/query", hd("application/json; charset=utf-8"), "{}")).status).toBe(400);
    expect((await raw(h.port, "POST", "/query", hd("Application/JSON"), "{}")).status).toBe(400);
  });

  test("listen failure clears the sweep timer", async () => {
    const h = await start();
    const timers: unknown[] = [];
    const realSet = globalThis.setInterval;
    const setSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((...a: Parameters<typeof setInterval>) => {
      const t = realSet(...a); timers.push(t); return t;
    }) as typeof setInterval);
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      await expect(startMcpHttpServer(h.port, { quiet: true })).rejects.toThrow(/EADDRINUSE/);
      expect(timers.length).toBeGreaterThan(0);
      for (const t of timers) expect(clearSpy).toHaveBeenCalledWith(t);
    } finally {
      setSpy.mockRestore(); clearSpy.mockRestore();
    }
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

describe("http guard: wildcard bind", () => {
  test("a wildcard bind address is never an accepted Host or Origin", () => {
    for (const bindHost of ["0.0.0.0", "::", "[::]"]) {
      const h = bracketless(bindHost);
      expect(checkHostOrigin({ host: `${h}:7071` }, { bindHost })).toMatch(/Host/);
      expect(checkHostOrigin({ host: "localhost:7071", origin: `http://${h}:7071` }, { bindHost })).toMatch(/Origin/);
    }
    // a concrete bind address is still admitted
    expect(checkHostOrigin({ host: "192.168.1.5:7071" }, { bindHost: "192.168.1.5" })).toBeNull();
  });
});
function bracketless(h: string): string { return h === "::" ? "[::]" : h === "[::]" ? "[::]" : h; }

describe("memory serve: wildcard bind, IPv6, warning", () => {
  let db: ReturnType<typeof openDatabase>;
  let dir: string;
  const servers: Server[] = [];
  const listen = async (opts: Parameters<typeof startMemoryServer>[1]) => {
    const s = await startMemoryServer(db, opts);
    servers.push(s);
    return (s.address() as AddressInfo).port;
  };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lotl-memwild-"));
    db = openDatabase(join(dir, "t.sqlite"));
    initializeDatabase(db);
  });
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    vi.restoreAllMocks();
  });
  afterAll(() => {
    try { db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  test("bound to 0.0.0.0: Host 0.0.0.0 refused, listed name accepted", async () => {
    setEnv("LOTL_MEMORY_SERVE_TOKEN", undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const port = await listen({ host: "0.0.0.0", port: 0 });
    const bad = await raw(port, "GET", "/api/stats", { host: `0.0.0.0:${port}` });
    expect(bad.status).toBe(403);
    expect((await raw(port, "GET", "/api/stats", { host: `localhost:${port}`, origin: `http://0.0.0.0:${port}` })).status).toBe(403);
    expect((await raw(port, "GET", "/api/stats", { host: "mem.lan" })).status).toBe(403);
    setEnv("LOTL_HTTP_ALLOWED_HOSTS", "mem.lan");
    expect((await raw(port, "GET", "/api/stats", { host: "mem.lan" })).status).toBe(200);
  });

  test("--host ::1 answers a normal request", async (ctx) => {
    if (!(await hasIpv6Loopback())) return ctx.skip();
    const port = await listen({ host: "::1", port: 0 });
    const r = await raw(port, "GET", "/api/stats", { host: `[::1]:${port}` }, undefined, "::1");
    expect(r.status).toBe(200);
  });

  test("no-token warning for a non-loopback host, none for loopback or with a token", async () => {
    setEnv("LOTL_MEMORY_SERVE_TOKEN", undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await listen({ host: "127.0.0.1", port: 0 });
    expect(err).not.toHaveBeenCalled();
    await listen({ host: "0.0.0.0", port: 0, token: "s3cret" });
    expect(err).not.toHaveBeenCalled();
    await listen({ host: "0.0.0.0", port: 0 });
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toMatch(/without authentication/i);
  });
});

async function hasIpv6Loopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.once("error", () => resolve(false));
    s.listen(0, "::1", () => s.close(() => resolve(true)));
  });
}
