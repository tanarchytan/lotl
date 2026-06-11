# Handover: MCP stdio server — lazy SQLite attach (instant `tools/list`)

**Status:** ready to implement · **Branch:** `dev` · **No publish** (release is the maintainer's call; ships to npm `alpha` dist-tag from `dev` via tag-triggered `publish.yml`)
**Authored by:** external agent (WM – Job Hunter session), 2026-06-11
**Audience:** an agent working inside the lotl repo (`@tanarchy/lotl`)

---

## Problem (observed from a consuming harness)

Claude Code has `lotl` registered as a **global** stdio MCP server. It intermittently exposes **zero lotl tools** in a session, even though:

- `claude mcp list` → `lotl: lotl.cmd mcp - ✔ Connected`
- A fresh JSON-RPC probe of `lotl mcp` returns **26 tools** (`memory_search`, `memory_add`, `doc_search`, `knowledge_*`, …) and `serverInfo.name=lotl, version=1.2.0-alpha.1`.

So the server is healthy and the config is correct. The failure is a **cold-start race**: the client opens the stdio transport, waits for the `initialize` → `tools/list` handshake, and the MCP server doesn't answer in time because **boot blocks on opening/attaching the SQLite index first**. When the client's MCP startup window elapses, Claude Code drops the server for that session and does **not** retry (a later health-check reconnects fresh — hence the misleading ✔).

The hooks-based memory path (`UserPromptSubmit`/`Stop` recall+save shell hooks) is unaffected — only the MCP **tool** surface is lost.

## Root cause (exact location)

`src/mcp/server.ts`, `startMcpServer()` — the stdio entrypoint Claude Code uses:

```ts
// lines ~1319–1328 (CURRENT)
export async function startMcpServer(): Promise<void> {
  const configPath = getConfigPath();
  const store = await createStore({                 // ← BLOCKS: opens DB, creates tables, attaches vec0
    dbPath: getDefaultDbPath(),
    ...(existsSync(configPath) ? { configPath } : {}),
  });
  const server = await createMcpServer(store);       // ← also awaits store (see below)
  const transport = new StdioServerTransport();
  await server.connect(transport);                   // ← only NOW does initialize/tools/list become serviceable
}
```

The slow work is inside `createStore` (`src/index.ts:337`): `createStoreInternal(dbPath)` — *"opens DB, creates tables"* — plus `syncConfigToDb`. On a cold index this is what overruns the client's handshake window.

Two **registration-time** store touches inside `createMcpServer` (`src/mcp/server.ts:200`) also depend on an attached store and must be deferred:

- line **203**: `{ instructions: await buildInstructions(store) }`
- line **207**: `const defaultCollectionNames = await store.getDefaultCollectionNames();` (consumed at line 355: `collections ?? defaultCollectionNames`)

And all registered tool handlers consume the store synchronously via closure — `store.search(...)`, `store.get(...)`, `store.getStatus(...)`, and `store.internal.db` (the `store.internal.db` sites alone span lines ~635–1042). They currently assume a fully-attached store.

## The fix (design the maintainer asked for: "respond, but say *wait, loading* if SQLite is still attaching")

Goal: `initialize` + `tools/list` answer in **milliseconds** (tool definitions are static — no DB needed); the index attaches in the **background**; a tool *invoked* before the index is ready returns a **clean retryable notice** instead of hanging or timing out the whole server.

### 1. Reorder boot — connect first, attach in background

```ts
// src/mcp/server.ts  startMcpServer()  (REPLACEMENT)
export async function startMcpServer(): Promise<void> {
  const configPath = getConfigPath();
  // Kick off attach but DO NOT block the handshake on it.
  const storePromise = createStore({
    dbPath: getDefaultDbPath(),
    ...(existsSync(configPath) ? { configPath } : {}),
  });
  const server = await createMcpServer(storePromise);   // pass the PROMISE
  const transport = new StdioServerTransport();
  await server.connect(transport);                       // tools/list now instant
}
```

Apply the **same reorder** to `startMcpHttpServer()` (lines ~1344–1352) for parity — it has the identical `await createStore` → `getDefaultCollectionNames` blocking pattern. Lower priority (HTTP clients usually tolerate a slow first response), but keep the two paths consistent.

### 2. Add a ready-gate in `createMcpServer`

Change the signature to accept either a resolved store or a promise, and expose an internal `ready()` that all handlers funnel through:

```ts
async function createMcpServer(storeInput: LotlStore | Promise<LotlStore>): Promise<McpServer> {
  let _store: LotlStore | null = null;
  let _err: unknown = null;
  const _ready = Promise.resolve(storeInput).then(s => { _store = s; }, e => { _err = e; });

  const SOFT_WAIT_MS = 250; // brief grace so a call landing milliseconds before "ready" succeeds
  async function ready(): Promise<LotlStore> {
    if (_store) return _store;
    if (_err) throw _err;
    await Promise.race([_ready, new Promise(r => setTimeout(r, SOFT_WAIT_MS))]);
    if (_err) throw _err;
    if (!_store) {
      // Surface a retryable, non-fatal message — the server stays up.
      throw new Error("Lotl index is still attaching — retry in a moment.");
    }
    return _store;
  }
  // ... server = new McpServer({ name, version }, { instructions: STATIC_OR_LAZY }) ...
}
```

**Instructions (line 203):** `buildInstructions(store)` reads the DB. Either (a) pass a static, DB-free instructions string at construction and skip the dynamic briefing, or (b) keep it dynamic but move it out of the constructor — McpServer instructions are sent during `initialize`, so a DB read here re-introduces the block. **Recommended:** static instructions string for the handshake; expose the dynamic briefing via the existing `briefing` tool (which already goes through `ready()`).

**Default collection names (line 207 / 1352):** delete the registration-time prefetch; compute inside each handler that needs it, after `ready()`:
```ts
const store = await ready();
const effectiveCollections = collections ?? await store.getDefaultCollectionNames();
```
(`getDefaultCollectionNames` is cheap once attached; if you want to avoid repeat calls, memoize on first success.)

### 3. Gate every tool/resource handler

Mechanical: at the top of each handler body, replace the closed-over `store` with a resolved one.

- Find sites: `rg 'store\.(search|get|getStatus|getDocumentBody|multiGet|listContexts|getGlobalContext|internal)\b' src/mcp/server.ts` plus the resource handler at line ~229.
- Pattern per handler:
  ```ts
  async (args) => {
    const store = await ready();        // add this line
    /* ...existing body unchanged: store.search(...), store.internal.db, etc... */
  }
  ```
  Because the local `const store` shadows the (now-promise) outer param, the rest of each body needs **no** edits.
- The thrown "still attaching" error from `ready()` propagates as a normal tool error result — the MCP SDK wraps it; the client sees a retryable message, the server stays alive.

## Files to touch

| File | Change |
|---|---|
| `src/mcp/server.ts` | `startMcpServer` reorder; `startMcpHttpServer` reorder; `createMcpServer` signature + `ready()` gate; defer `buildInstructions`; remove 2× `getDefaultCollectionNames` prefetch; add `const store = await ready()` to each handler (~26 tools + 1 resource) |
| `src/index.ts` | (optional) no change required if the gate lives in server.ts. Only touch if you'd rather make `createStore` itself return fast with a lazily-attached `internal.db`. The server-side gate is the smaller, safer blast radius — prefer it. |

## Verify

```bash
npm run typecheck                 # tsc --noEmit
npm run test                      # vitest run test/  — see test/mcp.test.ts; add a case below
npm run build                     # node scripts/build.mjs → dist/
```

**New test (test/mcp.test.ts):** assert `tools/list` resolves before the store does. Inject a `createStore` that resolves after an artificial delay (or pass a deliberately-pending promise to `createMcpServer`) and assert:
1. `initialize` + `tools/list` return all 26 tools without awaiting the store.
2. A tool call while the store is pending returns the "still attaching — retry" error (not a hang, not a crash).
3. After the store resolves, the same tool call succeeds.

**Manual handshake probe (proves the race is gone) — run against the built CLI:**
```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
 | node dist/cli/lotl.js mcp
# EXPECT: id:2 returns 26 tools effectively immediately, even with a cold/large index.
```
Or use the bundled inspector: `npm run inspector`.

**End-to-end in Claude Code:** after `npm run build`, `npm link` (or reinstall the global `@tanarchy/lotl`) so the global `lotl.cmd` resolves to this build, then start a fresh Claude Code session in any project and confirm `mcp__lotl__*` tools appear without the prior drop.

## Constraints / guardrails

- Work on **`dev`** only. **Do not publish.** Release ships from `dev` via tag → `publish.yml` (npm Trusted Publishing/OIDC, prereleases route to the `alpha` dist-tag, never `latest`). Tagging/releasing is the maintainer's explicit decision.
- Commit as split conventional commits, e.g. `fix(mcp): serve tools/list before SQLite attach (lazy store gate)` + `test(mcp): cold-attach handshake race`.
- Keep `LOTL_ONNX=off` semantics intact — local model loading is already lazy (`store/embeddings.ts` loads on first use); this change must not eagerly trigger it.

## Interim client-side mitigation (already suggested to the maintainer; not part of this repo)

Until the build ships, consuming harnesses can bump the MCP startup window: set `MCP_TIMEOUT=30000` (Claude Code env) and/or switch the server command from the `lotl.cmd` shim to node-direct (`node <global>/node_modules/@tanarchy/lotl/dist/cli/lotl.js mcp`) to shave shim/spawn latency. These are stopgaps — the lazy-attach fix above is the real solution and benefits every harness (Claude Code, Codex, OpenCode).

---

### Quick reference — symbols & line anchors (as of 1.2.0-alpha.1, `dev`)

- `src/mcp/server.ts:200` `createMcpServer(store: LotlStore)`
- `src/mcp/server.ts:203` `await buildInstructions(store)` (defer)
- `src/mcp/server.ts:207` `await store.getDefaultCollectionNames()` (remove prefetch; lazily compute at :355 usage)
- `src/mcp/server.ts:1319` `startMcpServer()` (stdio — primary fix)
- `src/mcp/server.ts:1344` `startMcpHttpServer()` (apply same reorder; :1352 has the twin prefetch at :1449 usage)
- `src/index.ts:215` `interface LotlStore` · `src/index.ts:337` `createStore()` (blocking attach inside `createStoreInternal`)
- `package.json` scripts: `build` = `node scripts/build.mjs`, `test` = `vitest run --reporter=verbose test/`, `typecheck` = `tsc --noEmit`, `inspector` = MCP inspector over `tsx src/cli/lotl.ts mcp`
