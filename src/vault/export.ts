// src/vault/export.ts
// KG -> vault Markdown exporter. Subsystem 1 (v1.2.0-alpha.1).

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeScope } from "./templates.js";

export function resolveVaultRoot(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const override = env.LOTL_VAULT_PATH;
  if (override && override.length > 0) {
    if (override.startsWith("~")) return join(home, override.slice(1).replace(/^[\\/]/, ""));
    return override;
  }
  return join(home, ".local", "share", "lotl", "vault");
}

export function scopeDir(root: string, scope: string): string {
  return join(root, sanitizeScope(scope));
}

export function computeScopeHash(
  kgCount: number,
  maxUpdatedAt: string | null,
): string {
  return createHash("sha256")
    .update(`${kgCount}:${maxUpdatedAt ?? ""}`)
    .digest("hex");
}
