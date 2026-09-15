/**
 * memory/compact.ts — Reversible migration for over-budget memories.
 *
 * Scans `memories` rows whose `text` exceeds OKF's BODY_MAX, compacts them
 * via compactMemoryText (LLM path if `chat` provided, heuristic fallback
 * otherwise), and rewrites the row through memoryUpdate — the sanctioned
 * mutation path that keeps memory_history + re-embedding consistent.
 *
 * Reversibility: the original text is archived into `metadata.original`
 * before it is overwritten. Rows that already carry `metadata.original` are
 * skipped (idempotent — safe to re-run). Low-confidence compactions are
 * routed to a review queue instead of being applied, unless `force` is set.
 */
import type { Database } from "../db.js";
import { memoryUpdate } from "./index.js";
import { compactMemoryText, BODY_MAX, COMPACT_MIN_OVERAGE } from "../okf/budget.js";

type Row = { id: string; text: string; metadata: string | null };

export interface CompactResult {
  scanned: number;
  compacted: number;
  review: string[];
}

export async function compactAllMemories(
  db: Database,
  opts: { apply: boolean; force?: boolean; chat?: (p: string) => Promise<string> },
): Promise<CompactResult> {
  // Same floor as the write path (isOverBudget): don't spend an LLM call on
  // text only marginally over BODY_MAX.
  const rows = db.prepare(`SELECT id, text, metadata FROM memories WHERE length(text) > ?`).all(BODY_MAX * COMPACT_MIN_OVERAGE) as Row[];
  const result: CompactResult = { scanned: 0, compacted: 0, review: [] };

  for (const r of rows) {
    let meta: Record<string, unknown> = {};
    try { meta = r.metadata ? JSON.parse(r.metadata) : {}; } catch { meta = {}; }
    if (meta.original) continue; // already migrated

    result.scanned++;
    const { description, body, lowConfidence } = await compactMemoryText(r.text, opts.chat);
    if (lowConfidence && !opts.force) { result.review.push(r.id); continue; }
    if (!opts.apply) continue;

    await memoryUpdate(db, { id: r.id, text: body, metadata: { ...meta, original: r.text, description } });
    result.compacted++;
  }

  return result;
}
