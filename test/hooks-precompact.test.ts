/**
 * hooks/lotl_precompact_hook.sh: the manual /compact gate releases once the
 * lotl index records a write. It used to watch a fixed ~/.cache/lotl path, so
 * with INDEX_PATH or XDG_CACHE_HOME pointing elsewhere the gate never released.
 */

import { describe, test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const hook = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "lotl_precompact_hook.sh");
const hasBash = process.platform !== "win32" && spawnSync("bash", ["-c", "true"]).status === 0;

function run(home: string, env: Record<string, string>, stdin: string): string {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "INDEX_PATH" && k !== "XDG_CACHE_HOME") base[k] = v;
  }
  const r = spawnSync("bash", [hook], { input: stdin, env: { ...base, HOME: home, ...env }, encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

/** Simulate a committed memory write: touch the DB file with an mtime ahead of the block. */
function touchDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, "");
  const t = Date.now() / 1000 + 10;
  utimesSync(path, t, t);
}

describe.skipIf(!hasBash)("lotl_precompact_hook.sh", () => {
  const layouts: Array<[string, (root: string) => { env: Record<string, string>; db: string }]> = [
    ["INDEX_PATH", (root) => ({ env: { INDEX_PATH: join(root, "proj", ".lotl", "index.sqlite") }, db: join(root, "proj", ".lotl", "index.sqlite") })],
    ["XDG_CACHE_HOME", (root) => ({ env: { XDG_CACHE_HOME: join(root, "xdg") }, db: join(root, "xdg", "lotl", "index.sqlite") })],
    ["default ~/.cache", (root) => ({ env: {}, db: join(root, "home", ".cache", "lotl", "index.sqlite") })],
  ];

  test.each(layouts)("manual gate blocks, then releases after a write (%s layout)", (_label, layout) => {
    const root = mkdtempSync(join(tmpdir(), "lotl-precompact-"));
    try {
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const { env, db } = layout(root);
      const first = run(home, env, '{"trigger":"manual"}');
      expect(JSON.parse(first).decision).toBe("block");
      const second = run(home, env, '{"trigger":"manual"}');
      expect(JSON.parse(second).decision).toBe("block");
      touchDb(db);
      expect(run(home, env, '{"trigger":"manual"}')).toBe("");
      // auto-compaction never blocks
      expect(run(home, env, '{"trigger":"auto"}')).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
