// opencode-lotl-memory.mjs — OpenCode plugin for the lotl auto-memory loop.
//
// OpenCode uses a TypeScript/JS plugin model (not command hooks), so the bash
// hooks under hooks/ don't apply here — this is the OpenCode adapter for the
// same push + retrieve loop:
//   - chat.message  → RETRIEVE: recall relevant memories, inject as context
//   - session.idle  → PUSH: extract + store memories from the turn's prompts
//
// FAIL-OPEN: every lotl call is wrapped; any error/timeout is swallowed so the
// plugin never blocks or breaks a session. Shells out to the `lotl` CLI (set
// LOTL_BIN, e.g. lotl.cmd on Windows) — no import coupling to the package.
//
// Install (pick one):
//   - copy/symlink this file into ~/.config/opencode/plugins/   (global)
//     or  <repo>/.opencode/plugins/                              (per project)
//   - or reference it in opencode.json:
//       { "plugin": ["file:///abs/path/to/opencode-lotl-memory.mjs"] }
//
// Env: LOTL_BIN (default "lotl"), LOTL_RECALL_TIMEOUT (s, default 12),
//      LOTL_RECALL_MAX_LINES (default 25), LOTL_SAVE_MIN_CHARS (default 40).

import { execFile } from "node:child_process";

const LOTL = process.env.LOTL_BIN || "lotl";
const RECALL_TIMEOUT = Number(process.env.LOTL_RECALL_TIMEOUT || 12) * 1000;
const MAX_LINES = Number(process.env.LOTL_RECALL_MAX_LINES || 25);
const SAVE_MIN_CHARS = Number(process.env.LOTL_SAVE_MIN_CHARS || 40);

// Run `lotl` and return stdout (or "" on any failure — never throws).
//
// Prefer OpenCode's injected Bun shell (`ctx.$`): it escapes interpolated args
// safely and runs the Windows `.cmd` shim correctly. Fall back to execFile
// WITHOUT a shell — safe (args passed as an array, never concatenated), and
// functional wherever `lotl` is directly executable (macOS/Linux, or a binary
// on PATH). We never use `shell: true`, which would concatenate the prompt
// text unescaped into a command line (injection risk, Node DEP0190).
function makeRunLotl(sh) {
  return async function runLotl(args, env) {
    const mergedEnv = { ...process.env, ...env };
    try {
      if (typeof sh === "function") {
        const out = await sh({ env: mergedEnv })`${LOTL} ${args}`.quiet().nothrow();
        const stdout = out && (out.stdout ?? out);
        return stdout ? stdout.toString() : "";
      }
      return await new Promise((resolve) => {
        execFile(
          LOTL,
          args,
          { timeout: RECALL_TIMEOUT, env: mergedEnv, windowsHide: true },
          (err, stdout) => resolve(err ? "" : String(stdout || "")),
        );
      });
    } catch {
      return "";
    }
  };
}

// Pull plain text out of an OpenCode message's parts array.
function partsToText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

export const LotlMemory = async (ctx) => {
  const seenPrompts = [];
  const runLotl = makeRunLotl(ctx && ctx.$);

  return {
    // RETRIEVE — runs as the user's message is submitted, before the model.
    "chat.message": async (_input, output) => {
      try {
        const text = partsToText(output && output.parts);
        if (text.length < 8) return;
        seenPrompts.push(text);

        // Fast FTS recall (LOTL_ONNX=off → no per-prompt model load).
        const out = await runLotl(
          ["memory", "recall", text],
          { LOTL_ONNX: "off", LOTL_MEMORY_RERANK: "off" },
        );
        const trimmed = out.split(/\r?\n/).slice(0, MAX_LINES).join("\n").trim();
        if (!trimmed || /no memories|no results|^usage:/i.test(trimmed)) return;

        if (Array.isArray(output.parts)) {
          output.parts.unshift({
            type: "text",
            text: `Relevant memories from lotl (recalled automatically):\n${trimmed}`,
          });
        }
      } catch {
        /* fail-open */
      }
    },

    // PUSH — runs when the session goes idle (turn complete).
    "session.idle": async () => {
      try {
        const convo = seenPrompts.join("\n").trim();
        if (convo.length < SAVE_MIN_CHARS) return;
        await runLotl(["memory", "extract", convo], {});
        seenPrompts.length = 0;
      } catch {
        /* fail-open */
      }
    },
  };
};

export default LotlMemory;
