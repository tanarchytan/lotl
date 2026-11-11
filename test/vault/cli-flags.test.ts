/**
 * `lotl vault export --scope X --force`: the main dispatcher declares --scope and --force as
 * options, so util.parseArgs removed them from the positional list before vault saw them.
 * They have to be handed over explicitly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exportAllScopes = vi.fn(async () => ({}));

vi.mock("../../src/vault/export.js", () => ({
  createSqliteDataSource: () => ({}),
  exportAllScopes: (...a: unknown[]) => (exportAllScopes as any)(...a),
  resolveVaultRoot: () => "/tmp/vault-root",
  vaultStatus: async () => ({ vault_root: "/tmp/vault-root", scopes: [] }),
}));
vi.mock("../../src/cli/db-state.js", () => ({ getDb: () => ({}) }));

import { runVaultCommand } from "../../src/cli/vault-commands.js";

describe("runVaultCommand flag handoff", () => {
  let logs: string[];
  beforeEach(() => {
    exportAllScopes.mockClear();
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  });
  afterEach(() => vi.restoreAllMocks());

  it("passes scope and force given as parsed flags", async () => {
    await runVaultCommand(["export"], { scope: "proj-a", force: true });
    expect(exportAllScopes).toHaveBeenCalledWith(expect.objectContaining({ onlyScope: "proj-a", force: true }));
  });

  it("still parses flags left in argv", async () => {
    await runVaultCommand(["export", "--scope", "proj-b", "--force"]);
    expect(exportAllScopes).toHaveBeenCalledWith(expect.objectContaining({ onlyScope: "proj-b", force: true }));
  });

  it("defaults: no scope, no force", async () => {
    await runVaultCommand(["export"], {});
    expect(exportAllScopes).toHaveBeenCalledWith(expect.objectContaining({ onlyScope: undefined, force: false }));
  });

  it("`vault export --help` prints usage instead of exporting", async () => {
    expect(await runVaultCommand(["export"], { help: true })).toBe(0);
    expect(exportAllScopes).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/Usage: lotl vault/);
  });

  it("an unknown subcommand says so on stdout/stderr and exits 2", async () => {
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errs.push(a.join(" ")); });
    expect(await runVaultCommand(["bogus"], {})).toBe(2);
    expect(errs.join("\n")).toMatch(/unknown subcommand: bogus/);
  });

  it("a scope that matches nothing is named in the message", async () => {
    await runVaultCommand(["export"], { scope: "nope" });
    expect(logs.join("\n")).toContain("nope");
  });
});

// End to end through the real dispatcher (temp index and vault, nothing global touched).
const exec = promisify(execFile);
describe("lotl vault export through the CLI dispatcher", () => {
  let tmp: string;
  beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), "lotl-vault-flags-")); });
  afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

  it("--scope reaches vault", async () => {
    const { stdout } = await exec(
      "node",
      [resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "src/cli/lotl.ts", "vault", "export", "--scope", "no-such-scope", "--force"],
      { env: { ...process.env, LOTL_VAULT_PATH: join(tmp, "vault"), INDEX_PATH: join(tmp, "index.sqlite"), XDG_CONFIG_HOME: join(tmp, "cfg") } },
    );
    expect(stdout).toContain("no-such-scope");
  }, 30000);
});
