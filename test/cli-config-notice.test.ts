/**
 * Collections live in the config dir, not in the index. With a per-project INDEX_PATH,
 * `lotl status` and `lotl update` must say which config file supplies the collections.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { configNoticeLine } from "../src/cli/lotl.js";

const tsx = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");

describe("configNoticeLine", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => { saved = { INDEX_PATH: process.env.INDEX_PATH, LOTL_CONFIG_DIR: process.env.LOTL_CONFIG_DIR }; });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test("names the config file when INDEX_PATH is set", () => {
    process.env.INDEX_PATH = "/tmp/x/index.sqlite";
    process.env.LOTL_CONFIG_DIR = "/tmp/cfg-dir";
    const line = configNoticeLine();
    expect(line).toContain("/tmp/cfg-dir/index.yml");
    expect(line).toContain("LOTL_CONFIG_DIR");
    expect(line).not.toContain("\n");
  });

  test("silent when INDEX_PATH is not set", () => {
    delete process.env.INDEX_PATH;
    expect(configNoticeLine()).toBeUndefined();
  });
});

describe("lotl status / update print the config file", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "lotl-cfg-notice-")); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  for (const cmd of ["status", "update"]) {
    test(`${cmd} with INDEX_PATH names the config file`, () => {
      const cfg = join(tmp, "cfg");
      const r = spawnSync("node", [tsx, "src/cli/lotl.ts", cmd], {
        encoding: "utf8",
        env: { ...process.env, INDEX_PATH: join(tmp, "index.sqlite"), LOTL_CONFIG_DIR: cfg },
      });
      expect(r.stdout).toContain(join(cfg, "index.yml"));
    }, 30000);
  }
});
