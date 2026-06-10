/**
 * env.ts - Load Lotl config from ~/.config/lotl/.env
 *
 * Two-tier precedence:
 *   LOTL_* vars  → .env file always wins (overrides stale parent process vars)
 *   all others  → inherited environment wins (standard dotenv behaviour)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let _loaded = false;

/**
 * Returns the Lotl config directory:
 *   $LOTL_CONFIG_DIR  →  $XDG_CONFIG_HOME/lotl  →  ~/.config/lotl
 */
export function getQmdConfigDir(): string {
  return (
    process.env.LOTL_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "lotl") : null) ||
    join(homedir(), ".config", "lotl")
  );
}

const TRUTHY = new Set(["on", "1", "true", "yes", "enabled"]);

/** Interpret an on/off-style env value. Unset or anything non-truthy → false. */
function isOn(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

/**
 * Umbrella toggle: `LOTL_ONNX=on` enables the full local-ONNX stack with the
 * preconfigured default models, so users don't have to name individual
 * backends or model ids. Off (or unset) by default — the zero-config default
 * stays "no models, BM25 only".
 *
 * When on, it fills in (without overriding) the granular backend vars:
 *   - LOTL_EMBED_BACKEND=transformers   → local embed (mxbai-embed-xsmall-v1, q8)
 *   - LOTL_MEMORY_RERANK=on             → memory recall rerank pass enabled
 *   - LOTL_RERANK_BACKEND=transformers  → local cross-encoder (jina-reranker-v1-tiny-en)
 *
 * Any explicitly-set granular LOTL_* var always wins (e.g. LOTL_ONNX=on plus
 * LOTL_EMBED_PROVIDER=openai keeps embeddings remote), because we only assign
 * when the target var is currently unset.
 */
export function applyOnnxToggle(): void {
  if (!isOn(process.env.LOTL_ONNX)) return;
  process.env.LOTL_EMBED_BACKEND ??= "transformers";
  process.env.LOTL_MEMORY_RERANK ??= "on";
  process.env.LOTL_RERANK_BACKEND ??= "transformers";
}

/**
 * Load ~/.config/lotl/.env (or $/.env) into process.env, then resolve the
 * LOTL_ONNX umbrella toggle.
 * Idempotent — safe to call multiple times; only reads the file once.
 */
export function loadQmdEnv(): void {
  if (_loaded) return;
  _loaded = true;

  const envPath = join(getQmdConfigDir(), ".env");
  if (existsSync(envPath)) {
    let content: string | null = null;
    try {
      content = readFileSync(envPath, "utf-8");
    } catch {
      content = null;
    }
    if (content !== null) {
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
        if (!key) continue;
        if (key.startsWith("LOTL_")) {
          // Lotl's own config: .env is the source of truth, always override
          process.env[key] = val;
        } else if (!process.env[key]) {
          // Non-Lotl vars: only set if not already present (standard dotenv)
          process.env[key] = val;
        }
      }
    }
  }

  // Resolve the umbrella toggle after .env load so explicit granular vars win.
  // Runs whether or not a .env file exists (LOTL_ONNX may be set in the
  // ambient environment).
  applyOnnxToggle();
}
