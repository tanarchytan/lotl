/**
 * hooks/lotl_recall_hook.sh: recall must not write to the index (LOTL_RECALL_NO_TOUCH=on,
 * otherwise the access_count bump rewrites FTS rows and moves the WAL mtime that the
 * PreCompact gate watches), and must work where `timeout` is not installed (stock macOS).
 */

import { describe, test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const hook = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "lotl_recall_hook.sh");
const which = (b: string) => spawnSync("bash", ["-c", `command -v ${b}`], { encoding: "utf8" }).stdout.trim();
const canRun = process.platform !== "win32" && !!which("bash") && !!which("jq");

/** A fake `lotl` that prints its env and args as the recall result. */
function fakeLotl(dir: string): string {
  const bin = join(dir, "fake-lotl");
  writeFileSync(bin, `#!/bin/sh\necho "noreply=$LOTL_RECALL_NO_TOUCH onnx=$LOTL_ONNX argv=$*"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const PAYLOAD = JSON.stringify({ prompt: "how is the dedup threshold tuned", cwd: "/nonexistent" });

function runHook(env: Record<string, string>, bash = "bash") {
  return spawnSync(bash, [hook], { input: PAYLOAD, env, encoding: "utf8" });
}

describe.skipIf(!canRun)("lotl_recall_hook.sh", () => {
  test("recalls read-only: LOTL_RECALL_NO_TOUCH=on reaches lotl", () => {
    const dir = mkdtempSync(join(tmpdir(), "lotl-recall-hook-"));
    try {
      const r = runHook({ PATH: process.env.PATH ?? "", HOME: dir, LOTL_BIN: fakeLotl(dir) });
      expect(r.status).toBe(0);
      const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
      expect(ctx).toContain("noreply=on");
      expect(ctx).toContain("onnx=off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("still recalls when neither timeout nor gtimeout is installed (stock macOS)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lotl-recall-hook-"));
    try {
      // A PATH holding only the tools the hook needs, so `timeout` really is absent.
      const bin = join(dir, "bin");
      mkdirSync(bin);
      for (const t of ["env", "head", "cat", "grep", "jq", "perl", "sh", "printf"]) {
        const p = which(t);
        if (p) symlinkSync(p, join(bin, t));
      }
      const r = runHook({ PATH: bin, HOME: dir, LOTL_BIN: fakeLotl(dir) }, which("bash"));
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("noreply=on");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
