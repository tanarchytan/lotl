/**
 * memory/server.ts — Local web UI to view, edit, and delete memories.
 *
 * A single-file, dependency-free HTTP server (Node `http`) that serves a
 * small SPA plus a JSON API over the memory store. Intended for local
 * inspection of sensitive-project indexes — binds to 127.0.0.1 by default
 * and all mutations go through the sanctioned SDK functions (memoryUpdate,
 * memoryForget), never raw DELETE/UPDATE outside the store layer.
 *
 * Point it at any index via INDEX_PATH (per-project isolation) — the caller
 * passes an already-resolved Database, so `lotl memory serve` from a repo
 * with a project-scoped .mcp.json inspects that repo's private memories.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Database } from "../db.js";
import {
  memoryForget,
  memoryUpdate,
  memoryStats,
  MEMORY_CATEGORIES,
  type MemoryCategory,
} from "./index.js";

export type MemoryServerOptions = {
  /** Bind host. Default 127.0.0.1 — do not expose sensitive indexes on 0.0.0.0. */
  host?: string;
  /** Bind port. Default 7071. */
  port?: number;
  /**
   * Optional bearer token. When set, every request must present it via
   * `Authorization: Bearer <token>` or `?token=<token>`. Defaults to the
   * LOTL_MEMORY_SERVE_TOKEN env var. Localhost binding is the primary guard;
   * the token is defense-in-depth for shared machines.
   */
  token?: string;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7071;
const LIST_LIMIT_MAX = 500;

type MemoryRow = {
  id: string;
  text: string;
  category: string;
  scope: string;
  importance: number;
  tier: string;
  access_count: number;
  created_at: number;
  last_accessed: number | null;
  metadata: string | null;
};

// Explicit column list — never SELECT * here. The memories table also holds
// `fact_embedding` (a raw vector BLOB) and `content_hash`; serializing those
// into JSON would dump binary vectors over the wire. Keep the API to the
// human-meaningful columns only.
const MEMORY_COLUMNS =
  "id, text, category, scope, importance, tier, access_count, created_at, last_accessed, metadata";

type ListFilters = {
  scope?: string;
  category?: string;
  tier?: string;
  q?: string;
  limit: number;
  offset: number;
};

// =============================================================================
// Data access — reads are raw SELECTs (mirrors the memory_list MCP tool),
// writes delegate to the SDK so history + re-embedding stay consistent.
// =============================================================================

function listMemories(db: Database, filters: ListFilters): { rows: MemoryRow[]; total: number } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.scope) { clauses.push("scope = ?"); params.push(filters.scope); }
  if (filters.category) { clauses.push("category = ?"); params.push(filters.category); }
  if (filters.tier) { clauses.push("tier = ?"); params.push(filters.tier); }
  if (filters.q) { clauses.push("text LIKE ?"); params.push(`%${filters.q}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const total = (db.prepare(`SELECT COUNT(*) as count FROM memories ${where}`).get(...params) as { count: number }).count;
  const rows = db.prepare(
    `SELECT ${MEMORY_COLUMNS} FROM memories ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, filters.limit, filters.offset) as MemoryRow[];
  return { rows, total };
}

function getMemory(db: Database, id: string): MemoryRow | null {
  return (db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined) ?? null;
}

function distinctScopes(db: Database): string[] {
  const rows = db.prepare(`SELECT DISTINCT scope FROM memories ORDER BY scope`).all() as { scope: string }[];
  return rows.map(r => r.scope);
}

// =============================================================================
// HTTP helpers
// =============================================================================

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

/** Constant-time token compare so a bad token can't be timed out. */
function tokenMatches(expected: string, got: string | null): boolean {
  if (!got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return url.searchParams.get("token");
}

function parseListFilters(url: URL): ListFilters {
  const num = (v: string | null, fallback: number): number => {
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    scope: url.searchParams.get("scope") || undefined,
    category: url.searchParams.get("category") || undefined,
    tier: url.searchParams.get("tier") || undefined,
    q: url.searchParams.get("q") || undefined,
    limit: Math.min(num(url.searchParams.get("limit"), 50), LIST_LIMIT_MAX),
    offset: num(url.searchParams.get("offset"), 0),
  };
}

function isMemoryCategory(v: unknown): v is MemoryCategory {
  return typeof v === "string" && (MEMORY_CATEGORIES as readonly string[]).includes(v);
}

// =============================================================================
// API routing
// =============================================================================

async function handleApi(
  db: Database,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const method = req.method || "GET";
  const path = url.pathname;

  // GET /api/stats
  if (method === "GET" && path === "/api/stats") {
    return sendJson(res, 200, { ...memoryStats(db), scopes: distinctScopes(db) });
  }

  // GET /api/memories
  if (method === "GET" && path === "/api/memories") {
    const filters = parseListFilters(url);
    const { rows, total } = listMemories(db, filters);
    return sendJson(res, 200, { total, limit: filters.limit, offset: filters.offset, memories: rows });
  }

  // /api/memory/:id
  const idMatch = path.match(/^\/api\/memory\/([^/]+)$/);
  if (idMatch) {
    const id = decodeURIComponent(idMatch[1]!);

    if (method === "GET") {
      const row = getMemory(db, id);
      return row ? sendJson(res, 200, row) : sendJson(res, 404, { error: "not found" });
    }

    if (method === "PATCH" || method === "PUT") {
      let body: Record<string, unknown>;
      try {
        body = (await readJsonBody(req)) as Record<string, unknown>;
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof Error ? err.message : "bad json" });
      }
      if (body.category !== undefined && !isMemoryCategory(body.category)) {
        return sendJson(res, 400, { error: `category must be one of ${MEMORY_CATEGORIES.join(", ")}` });
      }
      const result = await memoryUpdate(db, {
        id,
        text: typeof body.text === "string" ? body.text : undefined,
        importance: typeof body.importance === "number" ? body.importance : undefined,
        category: isMemoryCategory(body.category) ? body.category : undefined,
        metadata: body.metadata !== undefined && typeof body.metadata === "object" && body.metadata !== null
          ? (body.metadata as Record<string, unknown>)
          : undefined,
      });
      if (!result.updated) return sendJson(res, 404, { error: "not found or no changes" });
      return sendJson(res, 200, getMemory(db, id));
    }

    if (method === "DELETE") {
      const result = memoryForget(db, id);
      return result.deleted
        ? sendJson(res, 200, { deleted: true, id })
        : sendJson(res, 404, { error: "not found" });
    }

    res.writeHead(405, { allow: "GET, PATCH, DELETE" });
    return void res.end();
  }

  return sendJson(res, 404, { error: "no such route" });
}

// =============================================================================
// Server
// =============================================================================

/**
 * Start the memory web server. Resolves with the listening `Server` so the
 * caller can await `close()` on shutdown. The provided `db` is owned by the
 * caller and is not closed here.
 */
export function startMemoryServer(db: Database, options: MemoryServerOptions = {}): Promise<Server> {
  const host = options.host || DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const token = options.token ?? process.env.LOTL_MEMORY_SERVE_TOKEN ?? "";

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url || "/", `http://${host}:${port}`);

        if (token && !tokenMatches(token, extractToken(req, url))) {
          return sendJson(res, 401, { error: "unauthorized" });
        }

        if (url.pathname.startsWith("/api/")) {
          return await handleApi(db, req, res, url);
        }

        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return void res.end(renderHtml());
        }

        res.writeHead(404).end("not found");
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
      }
    })();
  });

  return new Promise<Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

// =============================================================================
// Inline SPA — no build step, no external assets. Vanilla JS + fetch.
// =============================================================================

function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lotl memories</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0e0f13; color: #d7dae0; }
  header { padding: 12px 16px; border-bottom: 1px solid #23262d; display: flex;
           gap: 12px; align-items: center; flex-wrap: wrap; position: sticky; top: 0;
           background: #0e0f13; z-index: 5; }
  h1 { font-size: 15px; margin: 0; color: #8ab4f8; letter-spacing: .5px; }
  .stats { color: #7a7f8a; font-size: 12px; }
  input, select, textarea, button { font: inherit; background: #171a20; color: #d7dae0;
           border: 1px solid #2a2e37; border-radius: 6px; padding: 6px 8px; }
  input:focus, select:focus, textarea:focus { outline: 1px solid #3a6ea5; }
  button { cursor: pointer; }
  button.primary { background: #1f3a5f; border-color: #2f5686; color: #cfe0ff; }
  button.danger { background: #3a1f24; border-color: #6b2f38; color: #ffd0d5; }
  main { padding: 16px; max-width: 1000px; margin: 0 auto; }
  .row { border: 1px solid #23262d; border-radius: 8px; padding: 12px; margin-bottom: 10px;
         background: #12141a; }
  .meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: #7a7f8a;
          margin-bottom: 8px; align-items: center; }
  .tag { padding: 1px 7px; border-radius: 999px; font-size: 11px; border: 1px solid #2a2e37; }
  .tag.cat { color: #a6e3a1; border-color: #34503a; }
  .tag.scope { color: #f9e2af; border-color: #574f2f; }
  .tag.tier { color: #89dceb; border-color: #2f4f57; }
  .text { white-space: pre-wrap; word-break: break-word; }
  .actions { margin-top: 8px; display: flex; gap: 8px; }
  textarea { width: 100%; min-height: 90px; resize: vertical; }
  .edit { display: none; margin-top: 8px; }
  .edit.open { display: block; }
  .edit .fields { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .empty { color: #7a7f8a; text-align: center; padding: 40px; }
  .toast { position: fixed; bottom: 16px; right: 16px; background: #1f3a5f;
           border: 1px solid #2f5686; padding: 10px 14px; border-radius: 8px;
           opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .pager { display: flex; gap: 8px; justify-content: center; margin: 16px 0; align-items: center; }
</style>
</head>
<body>
<header>
  <h1>lotl · memories</h1>
  <input id="q" placeholder="search text…" style="min-width:180px">
  <select id="scope"><option value="">all scopes</option></select>
  <select id="category">
    <option value="">all categories</option>
    <option>preference</option><option>fact</option><option>decision</option>
    <option>entity</option><option>reflection</option><option>other</option>
  </select>
  <select id="tier">
    <option value="">all tiers</option>
    <option>peripheral</option><option>working</option><option>core</option>
  </select>
  <span class="stats" id="stats"></span>
</header>
<main>
  <div id="list"></div>
  <div class="pager">
    <button id="prev">← prev</button>
    <span id="pageinfo" class="stats"></span>
    <button id="next">next →</button>
  </div>
</main>
<div class="toast" id="toast"></div>
<script>
const $ = (s) => document.querySelector(s);
const state = { limit: 50, offset: 0, total: 0 };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const token = new URLSearchParams(location.search).get("token");
const withTok = (u) => token ? u + (u.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token) : u;

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1800);
}

async function api(path, opts) {
  const res = await fetch(withTok(path), opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.status); }
  return res.status === 200 ? res.json() : null;
}

function fmtDate(ms) { return ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "—"; }

function rowHtml(m) {
  return \`<div class="row" data-id="\${esc(m.id)}">
    <div class="meta">
      <span class="tag cat">\${esc(m.category)}</span>
      <span class="tag scope">\${esc(m.scope)}</span>
      <span class="tag tier">\${esc(m.tier)}</span>
      <span>imp \${(+m.importance).toFixed(2)}</span>
      <span>acc \${m.access_count}</span>
      <span>\${fmtDate(m.created_at)}</span>
      <span style="color:#4a4e57">\${esc(m.id).slice(0, 8)}</span>
    </div>
    <div class="text">\${esc(m.text)}</div>
    <div class="actions">
      <button class="edit-btn">edit</button>
      <button class="danger del-btn">delete</button>
    </div>
    <div class="edit">
      <textarea class="e-text">\${esc(m.text)}</textarea>
      <div class="fields">
        <select class="e-cat">\${["preference","fact","decision","entity","reflection","other"]
          .map(c => \`<option \${c===m.category?"selected":""}>\${c}</option>\`).join("")}</select>
        <input class="e-imp" type="number" step="0.05" min="0" max="1" value="\${(+m.importance).toFixed(2)}" style="width:90px">
        <button class="primary save-btn">save</button>
        <button class="cancel-btn">cancel</button>
      </div>
    </div>
  </div>\`;
}

async function load() {
  const p = new URLSearchParams();
  if ($("#q").value) p.set("q", $("#q").value);
  if ($("#scope").value) p.set("scope", $("#scope").value);
  if ($("#category").value) p.set("category", $("#category").value);
  if ($("#tier").value) p.set("tier", $("#tier").value);
  p.set("limit", state.limit); p.set("offset", state.offset);
  const data = await api("/api/memories?" + p.toString());
  state.total = data.total;
  $("#list").innerHTML = data.memories.length
    ? data.memories.map(rowHtml).join("")
    : '<div class="empty">no memories match</div>';
  const from = data.total ? state.offset + 1 : 0;
  const to = Math.min(state.offset + state.limit, data.total);
  $("#pageinfo").textContent = \`\${from}–\${to} of \${data.total}\`;
  $("#prev").disabled = state.offset === 0;
  $("#next").disabled = state.offset + state.limit >= data.total;
}

async function loadStats() {
  const s = await api("/api/stats");
  $("#stats").textContent = \`\${s.total} memories · \${Object.keys(s.byScope).length} scopes\`;
  const sel = $("#scope");
  for (const sc of s.scopes) {
    const o = document.createElement("option"); o.value = sc; o.textContent = sc; sel.appendChild(o);
  }
}

$("#list").addEventListener("click", async (e) => {
  const row = e.target.closest(".row"); if (!row) return;
  const id = row.dataset.id;
  if (e.target.classList.contains("edit-btn")) row.querySelector(".edit").classList.add("open");
  if (e.target.classList.contains("cancel-btn")) row.querySelector(".edit").classList.remove("open");
  if (e.target.classList.contains("save-btn")) {
    try {
      await api("/api/memory/" + encodeURIComponent(id), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: row.querySelector(".e-text").value,
          category: row.querySelector(".e-cat").value,
          importance: parseFloat(row.querySelector(".e-imp").value),
        }),
      });
      toast("saved"); await load();
    } catch (err) { toast("error: " + err.message); }
  }
  if (e.target.classList.contains("del-btn")) {
    if (!confirm("Delete this memory? This cannot be undone.")) return;
    try {
      await api("/api/memory/" + encodeURIComponent(id), { method: "DELETE" });
      toast("deleted"); await load(); await refreshStats();
    } catch (err) { toast("error: " + err.message); }
  }
});

async function refreshStats() {
  const s = await api("/api/stats");
  $("#stats").textContent = \`\${s.total} memories · \${Object.keys(s.byScope).length} scopes\`;
}

let debounce;
$("#q").addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(() => { state.offset = 0; load(); }, 250); });
for (const id of ["#scope", "#category", "#tier"]) $(id).addEventListener("change", () => { state.offset = 0; load(); });
$("#prev").addEventListener("click", () => { state.offset = Math.max(0, state.offset - state.limit); load(); });
$("#next").addEventListener("click", () => { state.offset += state.limit; load(); });

loadStats().then(load).catch(err => { $("#list").innerHTML = '<div class="empty">error: ' + esc(err.message) + '</div>'; });
</script>
</body>
</html>`;
}
