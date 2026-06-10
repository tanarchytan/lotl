/**
 * remote-config.test.ts — regression guard for the per-operation remote
 * provider env-var prefix.
 *
 * Why this test exists: the qmd→lotl rename (v1.0.0) renamed every env var
 * to the LOTL_* prefix — docs, .env.example, the OpenClaw plugin's
 * config→env mapping, and RemoteLLM's own error messages all say
 * LOTL_EMBED_PROVIDER / LOTL_RERANK_PROVIDER / LOTL_QUERY_EXPANSION_*.
 * But resolveOp() in remote-config.ts kept reading the OLD QMD_{OP}_*
 * names, so createRemoteConfigFromEnv() returned null for every correctly
 * configured user and remote embed/rerank/expansion silently fell back to
 * local. It went undetected because the only tests that exercise a real
 * remote provider are API-key-gated and skipped in CI.
 *
 * These tests assert the prefix is LOTL_*, not QMD_*. They touch no network
 * — resolveOp short-circuits on the provider/api-key env vars alone.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createRemoteConfigFromEnv } from "../src/remote-config.js";

const OP_VARS = [
  "LOTL_EMBED_PROVIDER", "LOTL_EMBED_API_KEY", "LOTL_EMBED_URL", "LOTL_EMBED_MODEL",
  "LOTL_RERANK_PROVIDER", "LOTL_RERANK_API_KEY", "LOTL_RERANK_URL", "LOTL_RERANK_MODE",
  "LOTL_QUERY_EXPANSION_PROVIDER", "LOTL_QUERY_EXPANSION_API_KEY",
  "QMD_EMBED_PROVIDER", "QMD_EMBED_API_KEY",
] as const;

describe("createRemoteConfigFromEnv — env-var prefix", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of OP_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of OP_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("reads LOTL_EMBED_PROVIDER + LOTL_EMBED_API_KEY into embed config", () => {
    process.env.LOTL_EMBED_PROVIDER = "openai";
    process.env.LOTL_EMBED_API_KEY = "sk-test";
    process.env.LOTL_EMBED_MODEL = "text-embedding-3-small";

    const config = createRemoteConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.embed).toBeDefined();
    expect(config!.embed!.provider).toBe("api"); // openai → api
    expect(config!.embed!.apiKey).toBe("sk-test");
    expect(config!.embed!.url).toBe("https://api.openai.com/v1");
    expect(config!.embed!.model).toBe("text-embedding-3-small");
  });

  test("reads LOTL_RERANK_* and LOTL_QUERY_EXPANSION_* per-operation", () => {
    process.env.LOTL_RERANK_PROVIDER = "zeroentropy";
    process.env.LOTL_RERANK_API_KEY = "ze-test";
    process.env.LOTL_QUERY_EXPANSION_PROVIDER = "openai";
    process.env.LOTL_QUERY_EXPANSION_API_KEY = "sk-qe";

    const config = createRemoteConfigFromEnv();
    expect(config).not.toBeNull();
    expect(config!.rerank).toBeDefined();
    expect(config!.rerank!.provider).toBe("url"); // zeroentropy → url
    expect(config!.queryExpansion).toBeDefined();
    expect(config!.queryExpansion!.provider).toBe("api");
  });

  test("ignores the legacy QMD_* prefix (regression: must NOT be read)", () => {
    process.env.QMD_EMBED_PROVIDER = "openai";
    process.env.QMD_EMBED_API_KEY = "sk-legacy";

    // No LOTL_* vars set → nothing configured → null.
    const config = createRemoteConfigFromEnv();
    expect(config).toBeNull();
  });

  test("returns null when provider is 'local' or unset", () => {
    expect(createRemoteConfigFromEnv()).toBeNull();

    process.env.LOTL_EMBED_PROVIDER = "local";
    process.env.LOTL_EMBED_API_KEY = "sk-test";
    expect(createRemoteConfigFromEnv()).toBeNull();
  });

  test("returns null when provider is set but API key is missing", () => {
    process.env.LOTL_EMBED_PROVIDER = "openai";
    // no LOTL_EMBED_API_KEY
    expect(createRemoteConfigFromEnv()).toBeNull();
  });
});
