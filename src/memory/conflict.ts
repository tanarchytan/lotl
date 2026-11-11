/**
 * memory/conflict.ts — LLM conflict resolution for near-duplicate memories.
 *
 * memoryStore calls this when a new memory has cosine >= MEMORY_DEDUP_COSINE
 * to an existing memory of the same scope and a remote provider is
 * configured (Mem0 pattern). Pure: takes the two texts and a chat function,
 * returns the decision; memoryStore applies it.
 */

import { MEMORY_CONFLICT_MERGE_MIN_CHARS } from "../store/constants.js";

export type ConflictAction = "ADD" | "UPDATE" | "DELETE" | "NONE";

export type ChatFn = (prompt: string) => Promise<string | null>;

export interface ConflictDecision {
  /** Parsed action, or null when the reply was missing, failed or unrecognised. */
  action: ConflictAction | null;
  /** Merged text for UPDATE; absent when not asked for or the reply was unusable. */
  merged?: string;
  /** Raw decision reply, for diagnostics. */
  raw: string | null;
}

export function conflictPrompt(existing: string, incoming: string): string {
  return `Compare these two memory statements and decide the action:\n\nExisting: "${existing}"\nNew: "${incoming}"\n\nRespond with exactly one word: ADD (new fact), UPDATE (merge into existing), DELETE (contradicts existing), or NONE (duplicate).`;
}

export function mergePrompt(existing: string, incoming: string): string {
  return `Merge these into one concise statement:\n1. "${existing}"\n2. "${incoming}"\n\nRespond with only the merged statement.`;
}

const ACTIONS: readonly ConflictAction[] = ["ADD", "UPDATE", "DELETE", "NONE"];

export function parseConflictAction(reply: string | null | undefined): ConflictAction | null {
  const action = reply?.trim().toUpperCase();
  return (ACTIONS as readonly string[]).includes(action ?? "") ? (action as ConflictAction) : null;
}

// =============================================================================
// Mode
// =============================================================================

/**
 * LOTL_MEMORY_CONFLICT, read on every near-duplicate:
 *   llm      (default when unset) apply the LLM's ADD/UPDATE/DELETE/NONE as-is
 *   guarded  non-destructive: never delete or rewrite an existing memory;
 *            drop the new one only when guardConflict() says it adds nothing
 *   off      never ask the LLM; a near-duplicate is a duplicate
 *            (what memoryStore does when no remote provider is configured)
 * Unknown values warn once on stderr and use `guarded`, the safe side.
 * Applies whenever getRemoteLLM() is non-null, which includes an embed-only
 * config: there the chat reply is null (llm: duplicate, guarded: the rule).
 */
export type ConflictMode = "llm" | "guarded" | "off";

const MODES: readonly ConflictMode[] = ["llm", "guarded", "off"];
const warnedModes = new Set<string>();

export function conflictMode(): ConflictMode {
  const raw = process.env.LOTL_MEMORY_CONFLICT ?? "";
  const v = raw.trim().toLowerCase();
  if (v === "") return "llm";
  if ((MODES as readonly string[]).includes(v)) return v as ConflictMode;
  if (!warnedModes.has(v)) {
    warnedModes.add(v);
    process.stderr.write(`lotl: unknown LOTL_MEMORY_CONFLICT="${raw.trim()}", using "guarded" (valid: llm, guarded, off)\n`);
  }
  return "guarded";
}

// =============================================================================
// Guard
// =============================================================================

// Word tokens: letters/digits, joined across . , : / _ ' - when followed by
// another letter or digit, so "4.21.1", "0,82", "02:30", "en_GB-alba" and
// "opt/x/y.txt" are one token each and "1.2" never matches "2.1".
const TOKEN = /[\p{L}\p{N}]+(?:[.,:/_'-][\p{L}\p{N}]+)*/gu;

/** Lower-cased word token set. No stop-word removal: "not" counts. */
export function wordTokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(TOKEN) ?? []));
}

// Words that flip a statement. A new text that drops one of these from the
// existing text says something different even when its tokens are a subset.
const NEGATIONS = new Set([
  "not", "no", "never", "none", "nothing", "without", "cannot", "can't", "don't", "doesn't",
  "isn't", "aren't", "wasn't", "weren't", "won't", "shouldn't", "mustn't", "didn't",
  "niet", "geen", "nooit", "zonder", "niets",
]);

/**
 * True when `incoming` adds nothing to `existing`: every word token of it is
 * already in the existing text, and it does not drop a negation the existing
 * text has. Token sets, not substrings ("80" does not cover "8080").
 */
export function coveredBy(incoming: string, existing: string): boolean {
  const inc = wordTokens(incoming);
  const ex = wordTokens(existing);
  if (inc.size === 0) return true;
  for (const t of inc) if (!ex.has(t)) return false;
  for (const t of ex) if (NEGATIONS.has(t) && !inc.has(t)) return false;
  return true;
}

export interface GuardedDecision {
  action: "ADD" | "NONE";
  /** Why the guard overrode the LLM, when it did. */
  guarded?: string;
}

/**
 * guarded mode. Deterministic, model-neutral, non-destructive:
 *   ADD                    -> ADD
 *   DELETE, UPDATE         -> ADD   (the existing row is never removed or rewritten)
 *   NONE, unparsed, null   -> NONE only when coveredBy(incoming, existing), else ADD
 * Callers pass { action: null } for a failed or thrown call too.
 */
export function guardConflict(d: ConflictDecision, existing: string, incoming: string): GuardedDecision {
  switch (d.action) {
    case "ADD":
      return { action: "ADD" };
    case "DELETE":
      return { action: "ADD", guarded: "delete blocked: existing memory kept, new one stored" };
    case "UPDATE":
      return { action: "ADD", guarded: "update blocked: existing memory kept, new one stored" };
    default:
      return coveredBy(incoming, existing)
        ? { action: "NONE" }
        : { action: "ADD", guarded: `${d.action ?? "no verdict"} overridden: new memory has words the existing one lacks` };
  }
}

export async function resolveConflict(
  existing: string,
  incoming: string,
  chat: ChatFn,
  opts: { merge?: boolean } = {},
): Promise<ConflictDecision> {
  const raw = await chat(conflictPrompt(existing, incoming));
  const action = parseConflictAction(raw);
  if (action !== "UPDATE" || opts.merge === false) return { action, raw };
  const merged = (await chat(mergePrompt(existing, incoming)))?.trim();
  return merged && merged.length >= MEMORY_CONFLICT_MERGE_MIN_CHARS ? { action, merged, raw } : { action, raw };
}
