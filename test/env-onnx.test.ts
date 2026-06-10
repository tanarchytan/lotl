/**
 * env-onnx.test.ts — the LOTL_ONNX umbrella toggle.
 *
 * LOTL_ONNX=on enables the full local-ONNX stack with default models without
 * the user naming individual backends. Default (unset/off) keeps the zero-model
 * BM25-only behaviour. Explicit granular LOTL_* vars must always win.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { applyOnnxToggle } from "../src/env.js";

const VARS = [
  "LOTL_ONNX",
  "LOTL_EMBED_BACKEND",
  "LOTL_MEMORY_RERANK",
  "LOTL_RERANK_BACKEND",
] as const;

describe("LOTL_ONNX umbrella toggle", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("unset → no backends configured (zero-model default preserved)", () => {
    applyOnnxToggle();
    expect(process.env.LOTL_EMBED_BACKEND).toBeUndefined();
    expect(process.env.LOTL_MEMORY_RERANK).toBeUndefined();
    expect(process.env.LOTL_RERANK_BACKEND).toBeUndefined();
  });

  test("off → no backends configured", () => {
    process.env.LOTL_ONNX = "off";
    applyOnnxToggle();
    expect(process.env.LOTL_EMBED_BACKEND).toBeUndefined();
    expect(process.env.LOTL_MEMORY_RERANK).toBeUndefined();
  });

  test("on → enables local embed + rerank with defaults", () => {
    process.env.LOTL_ONNX = "on";
    applyOnnxToggle();
    expect(process.env.LOTL_EMBED_BACKEND).toBe("transformers");
    expect(process.env.LOTL_MEMORY_RERANK).toBe("on");
    expect(process.env.LOTL_RERANK_BACKEND).toBe("transformers");
  });

  test.each(["1", "true", "yes", "ON", "Enabled"])(
    "accepts truthy value %s",
    (value) => {
      process.env.LOTL_ONNX = value;
      applyOnnxToggle();
      expect(process.env.LOTL_EMBED_BACKEND).toBe("transformers");
    },
  );

  test("explicit granular vars are NOT overridden", () => {
    process.env.LOTL_ONNX = "on";
    process.env.LOTL_EMBED_BACKEND = "remote";   // user keeps embeddings remote
    process.env.LOTL_MEMORY_RERANK = "off";       // user disables rerank
    applyOnnxToggle();
    expect(process.env.LOTL_EMBED_BACKEND).toBe("remote");
    expect(process.env.LOTL_MEMORY_RERANK).toBe("off");
    // The one var the user didn't set still gets the local default.
    expect(process.env.LOTL_RERANK_BACKEND).toBe("transformers");
  });
});
