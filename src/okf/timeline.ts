import type { Database } from "../db.js";
import { SqliteConceptSource, memRowToRef, type MemRow } from "./source.js";
import { knowledgeQuery } from "../memory/knowledge.js";
import { buildEntityId, conceptKind, type ConceptRef } from "./concept.js";

const DEFAULT_WINDOW = 3;
const MAX_WINDOW = 10;
const DEFAULT_MAX_BYTES = 2000;

function markRef(ref: ConceptRef, marker: string): ConceptRef {
  return { ...ref, description: `[${marker}] ${ref.description}` };
}

function neighbours(db: Database, anchor: MemRow, window: number): { before: MemRow[]; after: MemRow[] } {
  const cols = "id, text, category, scope, metadata, last_accessed, created_at";
  const before = db.prepare(
    `SELECT ${cols} FROM memories
     WHERE scope=? AND (created_at < ? OR (created_at = ? AND id < ?))
     ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(anchor.scope, anchor.created_at, anchor.created_at, anchor.id, window) as MemRow[];
  const after = db.prepare(
    `SELECT ${cols} FROM memories
     WHERE scope=? AND (created_at > ? OR (created_at = ? AND id > ?))
     ORDER BY created_at ASC, id ASC LIMIT ?`
  ).all(anchor.scope, anchor.created_at, anchor.created_at, anchor.id, window) as MemRow[];
  return { before, after };
}

/**
 * Progressive disclosure step 2 (between okf_recall and okf_get): given an
 * anchor memory concept id, show what happened chronologically around it
 * plus any knowledge-graph facts valid at that moment. Compact index lines
 * only (same contract + byte cap as okf_recall) — never full bodies.
 *
 * Returns null when the id is unknown/not a memory (caller renders "not found").
 */
export function okfTimeline(
  db: Database,
  id: string,
  opts: { window?: number; maxBytes?: number } = {}
): ConceptRef[] | null {
  let kind: string;
  try { kind = conceptKind(id); } catch { return null; }
  if (kind !== "memory") return null;

  const anchor = new SqliteConceptSource(db).getMemoryRow(id);
  if (!anchor) return null;

  const window = Math.max(1, Math.min(opts.window ?? DEFAULT_WINDOW, MAX_WINDOW));
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const { before, after } = neighbours(db, anchor, window);

  // Priority order for capping: anchor first (must never be dropped), then
  // nearest neighbours outward, then KG facts. Each entry is marked with its
  // position (T-2/T-1/anchor/T+1/T+2) so reading order doesn't matter.
  const candidates: ConceptRef[] = [markRef(memRowToRef(anchor), "anchor")];
  const spread = Math.max(before.length, after.length);
  for (let i = 0; i < spread; i++) {
    if (i < before.length) candidates.push(markRef(memRowToRef(before[i]!), `T-${i + 1}`));
    if (i < after.length) candidates.push(markRef(memRowToRef(after[i]!), `T+${i + 1}`));
  }

  const facts = knowledgeQuery(db, { as_of: anchor.created_at, scope: anchor.scope, limit: 50 });
  for (const f of facts) {
    candidates.push({ id: buildEntityId(f.subject), type: "Entity", title: f.subject, description: `[fact] ${f.predicate} ${f.object}` });
  }

  // Same byte-capping approach as okf_recall (src/okf/recall.ts): first entry
  // always kept even if oversized, stop before any entry that would overflow.
  const capped: ConceptRef[] = [];
  let bytes = 0;
  for (const r of candidates) {
    const size = Buffer.byteLength(`${r.title}${r.description}${r.id}`);
    if (bytes + size > maxBytes && capped.length) break;
    bytes += size;
    capped.push(r);
  }
  return capped;
}
