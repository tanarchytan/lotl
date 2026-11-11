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
// Recall mirrors hooks/lotl_recall_hook.sh:
//   - FTS only. LOTL_ONNX=on in ~/.config/lotl/.env overrides a LOTL_ONNX=off
//     passed here (the .env file wins for LOTL_* vars), so the embed and
//     rerank switches are set explicitly too; otherwise every prompt would
//     load the ONNX models.
//   - Relevance gate: --min-relevance=R (default 0.6), so prompts sharing no
//     specific terms with any memory inject nothing. LOTL_RECALL_MIN_RELEVANCE
//     changes it, "off" disables it. The `=` form is ignored by an older lotl
//     without the flag, which then recalls ungated.
//   - LOTL_OKF (default on) picks `okf recall` (index lines); LOTL_OKF=off
//     picks `memory recall` (raw rows). "(no matches)" counts as empty.
//
// Install (pick one):
//   - copy/symlink this file into ~/.config/opencode/plugins/   (global)
//     or  <repo>/.opencode/plugins/                              (per project)
//   - or reference it in opencode.json:
//       { "plugin": ["file:///abs/path/to/opencode-lotl-memory.mjs"] }
//
// Env: LOTL_BIN (default "lotl"), LOTL_RECALL_TIMEOUT (s, default 12),
//      LOTL_RECALL_MAX_LINES (default 25), LOTL_SAVE_MIN_CHARS (default 40),
//      LOTL_RECALL_MIN_RELEVANCE (default 0.6, "off" to disable),
//      LOTL_OKF (default on).

import { execFile } from "node:child_process";

const LOTL = process.env.LOTL_BIN || "lotl";
const RECALL_TIMEOUT = Number(process.env.LOTL_RECALL_TIMEOUT || 12) * 1000;
const MAX_LINES = Number(process.env.LOTL_RECALL_MAX_LINES || 25);
const SAVE_MIN_CHARS = Number(process.env.LOTL_SAVE_MIN_CHARS || 40);
const MIN_RELEVANCE = process.env.LOTL_RECALL_MIN_RELEVANCE ?? "0.6";
const OKF = (process.env.LOTL_OKF || "on") !== "off";

// Keyword recall with no model load (see header).
const FTS_ONLY_ENV = {
  LOTL_ONNX: "off",
  LOTL_EMBED_BACKEND: "off",
  LOTL_MEMORY_RERANK: "off",
};

const EMPTY_RESULT = /no memories|no results|no matches|^usage:/i;

// Build the recall argv for a prompt. Not exported: OpenCode calls every
// export of a plugin module as a plugin factory.
function recallArgs(text) {
  const gate =
    MIN_RELEVANCE && MIN_RELEVANCE !== "off" ? [`--min-relevance=${MIN_RELEVANCE}`] : [];
  // Options before "--", prompt after: a prompt starting with "-" is a query.
  return [OKF ? "okf" : "memory", "recall", ...gate, "--", text];
}

// Run `lotl` and return stdout (or "" on any failure — never throws).
//
// Prefer OpenCode's injected Bun shell (`ctx.$`): it escapes interpolated args
// safely and runs the Windows `.cmd` shim correctly. Bun's `$` only works as a
// tagged template; env goes through `.env()` on the returned command. Fall
// back to execFile WITHOUT a shell — safe (args passed as an array, never
// concatenated), and functional wherever `lotl` is directly executable
// (macOS/Linux, or a binary on PATH). We never use `shell: true`, which would
// concatenate the prompt text unescaped into a command line (injection risk,
// Node DEP0190).
function makeRunLotl(sh) {
  return async function runLotl(args, env, timeoutMs = RECALL_TIMEOUT) {
    const mergedEnv = { ...process.env, ...env };
    try {
      if (typeof sh === "function") {
        let timer;
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve(""), timeoutMs);
        });
        const run = Promise.resolve(sh`${LOTL} ${args}`.env(mergedEnv).quiet().nothrow()).then(
          (out) => {
            if (!out || (typeof out.exitCode === "number" && out.exitCode !== 0)) return "";
            const stdout = out.stdout ?? out;
            return stdout ? stdout.toString() : "";
          },
          () => "",
        );
        try {
          return await Promise.race([run, timeout]);
        } finally {
          clearTimeout(timer);
        }
      }
      return await new Promise((resolve) => {
        execFile(
          LOTL,
          args,
          { timeout: timeoutMs, env: mergedEnv, windowsHide: true },
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

        const out = await runLotl(recallArgs(text), FTS_ONLY_ENV);
        const trimmed = out.split(/\r?\n/).slice(0, MAX_LINES).join("\n").trim();
        if (!trimmed || EMPTY_RESULT.test(trimmed)) return;

        const header = OKF
          ? "Relevant lotl concepts (open with okf_get):"
          : "Relevant lotl memories:";
        if (Array.isArray(output.parts)) {
          output.parts.unshift({ type: "text", text: `${header}\n${trimmed}` });
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
        // Extraction may call an LLM; give it more headroom than recall.
        await runLotl(["memory", "extract", convo], {}, RECALL_TIMEOUT * 5);
        seenPrompts.length = 0;
      } catch {
        /* fail-open */
      }
    },
  };
};

export default LotlMemory;
