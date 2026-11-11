/**
 * hooks/opencode-lotl-memory.mjs: the OpenCode adapter for the auto-memory loop.
 *
 * Regression cover for:
 *  - Bun's `$` (OpenCode's ctx.$) only works as a tagged template. The plugin
 *    called it as `$({ env })`, which throws, was swallowed by the fail-open
 *    catch, and left the plugin a silent no-op under OpenCode.
 *  - FTS-only env (LOTL_EMBED_BACKEND=off, LOTL_MEMORY_RERANK=off next to
 *    LOTL_ONNX=off) and the --min-relevance gate, mirroring lotl_recall_hook.sh.
 */

import { describe, test, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pluginPath = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "opencode-lotl-memory.mjs");

const ENV_KEYS = ["LOTL_BIN", "LOTL_OKF", "LOTL_RECALL_MIN_RELEVANCE", "LOTL_RECALL_TIMEOUT"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

async function loadPlugin(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  vi.resetModules();
  const mod = await import(`${pluginPath}?t=${Date.now()}${Math.random()}`);
  return mod.default as (ctx: unknown) => Promise<Hooks>;
}

type Part = { type: string; text: string };
type Hooks = {
  "chat.message": (input: unknown, output: { parts: Part[] }) => Promise<void>;
  "session.idle": () => Promise<void>;
};
type Call = { args: unknown; env?: Record<string, string> };

/** Mimics Bun's `$`: throws unless used as a tagged template. */
function fakeBunShell(stdout: string, calls: Call[], opts: { hang?: boolean } = {}) {
  return function $(strings: TemplateStringsArray, ...values: unknown[]) {
    if (!Array.isArray(strings) || !("raw" in strings)) {
      throw new Error("Please use '$' as a tagged template function: $`cmd arg1 arg2`");
    }
    const call: Call = { args: values[1] };
    calls.push(call);
    const cmd = {
      env(e: Record<string, string>) { call.env = e; return cmd; },
      quiet() { return cmd; },
      nothrow() {
        return opts.hang
          ? new Promise(() => {})
          : Promise.resolve({ exitCode: 0, stdout: Buffer.from(stdout) });
      },
    };
    return cmd;
  };
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const PROMPT = "how is the sqlite vec dedup threshold tuned";

describe("opencode-lotl-memory plugin", () => {
  test("Bun shell path: tagged template, FTS-only env, gated okf recall, header injected", async () => {
    const factory = await loadPlugin({});
    const calls: Call[] = [];
    const hooks = await factory({ $: fakeBunShell("mem:abc dedup threshold note\n", calls) });
    const output = { parts: [{ type: "text", text: PROMPT }] };
    await hooks["chat.message"]({}, output);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["okf", "recall", "--min-relevance=0.6", "--", PROMPT]);
    expect(calls[0]!.env).toMatchObject({
      LOTL_ONNX: "off",
      LOTL_EMBED_BACKEND: "off",
      LOTL_MEMORY_RERANK: "off",
      LOTL_RECALL_NO_TOUCH: "on",
    });
    expect(output.parts).toHaveLength(2);
    expect(output.parts[0]!.text).toBe("Relevant lotl concepts (open with okf_get):\nmem:abc dedup threshold note");
  });

  test("'(no matches)' from okf recall injects nothing", async () => {
    const factory = await loadPlugin({});
    const hooks = await factory({ $: fakeBunShell("(no matches)\n", []) });
    const output = { parts: [{ type: "text", text: PROMPT }] };
    await hooks["chat.message"]({}, output);
    expect(output.parts).toHaveLength(1);
  });

  test("LOTL_OKF=off uses memory recall; LOTL_RECALL_MIN_RELEVANCE=off drops the gate", async () => {
    const factory = await loadPlugin({ LOTL_OKF: "off", LOTL_RECALL_MIN_RELEVANCE: "off" });
    const calls: Call[] = [];
    const hooks = await factory({ $: fakeBunShell("row\n", calls) });
    const output = { parts: [{ type: "text", text: PROMPT }] };
    await hooks["chat.message"]({}, output);
    expect(calls[0]!.args).toEqual(["memory", "recall", "--", PROMPT]);
    expect(output.parts[0]!.text).toBe("Relevant lotl memories:\nrow");
  });

  test("a hung Bun shell call is bounded by LOTL_RECALL_TIMEOUT", async () => {
    const factory = await loadPlugin({ LOTL_RECALL_TIMEOUT: "0.2" });
    const hooks = await factory({ $: fakeBunShell("", [], { hang: true }) });
    const output = { parts: [{ type: "text", text: PROMPT }] };
    const t0 = Date.now();
    await hooks["chat.message"]({}, output);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(output.parts).toHaveLength(1);
  });

  test.skipIf(process.platform === "win32")("execFile fallback passes args unshelled and the same env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lotl-opencode-"));
    try {
      const bin = join(dir, "fake-lotl");
      writeFileSync(
        bin,
        `#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), onnx: process.env.LOTL_ONNX, embed: process.env.LOTL_EMBED_BACKEND, rerank: process.env.LOTL_MEMORY_RERANK }));\n`,
      );
      chmodSync(bin, 0o755);
      const factory = await loadPlugin({ LOTL_BIN: bin });
      const hooks = await factory({});
      const hostile = `${PROMPT} "$(touch ${dir}/pwned)" ; rm -rf / \`id\``;
      const output = { parts: [{ type: "text", text: hostile }] };
      await hooks["chat.message"]({}, output);
      expect(output.parts).toHaveLength(2);
      const json = JSON.parse(output.parts[0]!.text.split("\n")[1] ?? "");
      expect(json).toEqual({
        argv: ["okf", "recall", "--min-relevance=0.6", "--", hostile],
        onnx: "off",
        embed: "off",
        rerank: "off",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
