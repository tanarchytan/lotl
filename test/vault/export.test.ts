import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  resolveVaultRoot,
  computeScopeHash,
  scopeDir,
} from "../../src/vault/export.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "lotl-vault-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("resolveVaultRoot", () => {
  it("honours LOTL_VAULT_PATH when set", () => {
    expect(resolveVaultRoot({ LOTL_VAULT_PATH: tmp })).toBe(tmp);
  });

  it("expands a leading ~ via homedir", () => {
    const resolved = resolveVaultRoot({ LOTL_VAULT_PATH: "~/vault-x" }, "/home/u");
    expect(resolved).toBe(join("/home/u", "vault-x"));
  });

  it("falls back to ~/.local/share/lotl/vault when env unset", () => {
    const resolved = resolveVaultRoot({}, "/home/u");
    expect(resolved).toBe(join("/home/u", ".local", "share", "lotl", "vault"));
  });
});

describe("scopeDir", () => {
  it("sanitizes the scope into the folder name", () => {
    expect(scopeDir("/root", "agent/foo")).toBe(join("/root", "agent-foo"));
    expect(scopeDir("/root", "global")).toBe(join("/root", "global"));
  });
});

describe("computeScopeHash", () => {
  it("is stable for same inputs", () => {
    const a = computeScopeHash(5, "2026-05-20T10:00:00Z");
    const b = computeScopeHash(5, "2026-05-20T10:00:00Z");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when kg_count changes", () => {
    expect(computeScopeHash(5, "2026-05-20T10:00:00Z")).not.toBe(
      computeScopeHash(6, "2026-05-20T10:00:00Z"),
    );
  });

  it("changes when max_updated_at changes", () => {
    expect(computeScopeHash(5, "2026-05-20T10:00:00Z")).not.toBe(
      computeScopeHash(5, "2026-05-21T10:00:00Z"),
    );
  });

  it("accepts null max_updated_at (empty scope)", () => {
    expect(computeScopeHash(0, null)).toMatch(/^[0-9a-f]{64}$/);
  });
});
