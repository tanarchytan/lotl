import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

let tmp: string;
let vaultPath: string;
let tsxPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "lotl-vault-smoke-"));
  vaultPath = join(tmp, "vault");
  await mkdir(vaultPath, { recursive: true });
  tsxPath = resolve(
    process.cwd(),
    "node_modules/tsx/dist/cli.mjs"
  );
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const childEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  LOTL_VAULT_PATH: vaultPath,
  ...extra,
});

describe("lotl vault smoke", () => {
  it("vault help exits 0 and prints usage", async () => {
    const { stdout } = await exec(
      "node",
      [tsxPath, "src/cli/lotl.ts", "vault", "help"],
      { env: childEnv() },
    );
    expect(stdout).toMatch(/Usage: lotl vault/);
  }, 30000);

  it("vault status exits 0 and prints vault root", async () => {
    const { stdout } = await exec(
      "node",
      [tsxPath, "src/cli/lotl.ts", "vault", "status"],
      { env: childEnv() },
    );
    expect(stdout).toContain("vault root:");
    expect(stdout).toContain(vaultPath);
  }, 30000);

  it("vault with no subcommand prints usage and exits 0", async () => {
    const { stdout } = await exec(
      "node",
      [tsxPath, "src/cli/lotl.ts", "vault"],
      { env: childEnv() },
    );
    expect(stdout).toMatch(/Usage: lotl vault/);
  }, 30000);
});
