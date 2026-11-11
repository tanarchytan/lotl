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

// The CLI opens (and initializes) the index on startup. Without INDEX_PATH
// it used the developer's real ~/.cache/lotl/index.sqlite, so every test run
// touched it (and ran any pending schema migration on it).
const childEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  LOTL_VAULT_PATH: vaultPath,
  INDEX_PATH: join(tmp, "index.sqlite"),
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
