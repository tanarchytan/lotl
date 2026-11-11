/**
 * memory/knowledge.ts — Temporal knowledge graph.
 *
 * Store entity-relationship triples with time validity windows.
 * From MemPalace: "What was true at time X?" is a SQL query, not a search.
 *
 * Entities are auto-deduped via slug normalization:
 *   "David Gillot" → "david_gillot"
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../db.js";

// =============================================================================
// Types
// =============================================================================

export type KnowledgeEntry = {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: number | null;
  valid_until: number | null;
  confidence: number;
  source_memory_id: string | null;
  created_at: number;
};

export type KnowledgeStoreOptions = {
  subject: string;
  predicate: string;
  object: string;
  valid_from?: number;
  confidence?: number;
  source_memory_id?: string;
  scope?: string;
};

export type KnowledgeQueryOptions = {
  subject?: string;
  predicate?: string;
  object?: string;
  as_of?: number;  // timestamp — return facts valid at this time
  scope?: string;
  limit?: number;
};

// =============================================================================
// Entity slug normalization (from MemPalace)
// =============================================================================

export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

// =============================================================================
// Knowledge CRUD
// =============================================================================

type TimelineRow = { id: string; object: string; valid_from: number | null; valid_until: number | null; created_at: number };

/** A NULL valid_from (never written by knowledgeStore) reads as "always". */
const startOf = (r: TimelineRow): number => r.valid_from ?? Number.NEGATIVE_INFINITY;
const inForceAt = (r: TimelineRow, t: number): boolean =>
  startOf(r) <= t && (r.valid_until === null || r.valid_until > t);

/**
 * Store a fact. Every predicate is single-valued: for one subject+predicate
 * the facts form a timeline ordered by valid_from, and a new fact that starts
 * at t (valid_from, default now):
 *  - ends the fact in force at t (latest valid_from <= t, window covering t)
 *    at t, not at the wall clock, so a backdated fact does not overlap it and
 *    a future-dated one leaves it in force until t;
 *  - ends itself where the earliest later fact starts (else stays open);
 *  - is a no-op returning the existing id when the fact in force at t already
 *    has this object, and extends the next fact back to t when that one has
 *    this object, instead of adding a second copy.
 * Scope does not separate timelines (unchanged): a store in any scope ends
 * the fact in force for the same subject+predicate.
 */
export function knowledgeStore(
  db: Database,
  options: KnowledgeStoreOptions
): { id: string; invalidated: string[] } {
  const subject = toSlug(options.subject);
  const predicate = options.predicate.toLowerCase().trim();
  const object = options.object.trim();
  const scope = options.scope || "global";
  const now = Date.now();
  const validFrom = options.valid_from ?? now;
  const confidence = Math.max(0, Math.min(1, options.confidence ?? 1.0));

  return db.transaction(() => {
    const timeline = db.prepare(`
      SELECT id, object, valid_from, valid_until, created_at FROM knowledge
      WHERE subject = ? AND predicate = ?
    `).all(subject, predicate) as TimelineRow[];

    let current: TimelineRow | null = null;
    let next: TimelineRow | null = null;
    for (const r of timeline) {
      if (inForceAt(r, validFrom)) {
        if (!current || startOf(r) > startOf(current) || (startOf(r) === startOf(current) && r.created_at > current.created_at)) current = r;
      } else if (r.valid_from !== null && r.valid_from > validFrom) {
        if (!next || r.valid_from < next.valid_from!) next = r;
      }
    }

    if (current?.object === object) return { id: current.id, invalidated: [] };

    const invalidated: string[] = [];
    if (current) {
      db.prepare(`UPDATE knowledge SET valid_until = ? WHERE id = ?`).run(validFrom, current.id);
      invalidated.push(current.id);
    }

    if (next?.object === object) {
      db.prepare(`UPDATE knowledge SET valid_from = ? WHERE id = ?`).run(validFrom, next.id);
      return { id: next.id, invalidated };
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO knowledge (id, subject, predicate, object, valid_from, valid_until, confidence, source_memory_id, scope, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, subject, predicate, object, validFrom, next?.valid_from ?? null, confidence, options.source_memory_id ?? null, scope, now);

    return { id, invalidated };
  })();
}

/**
 * Query facts, optionally filtered by subject/predicate/object and time.
 * as_of: return only facts valid at that timestamp (valid_from <= as_of AND (valid_until IS NULL OR valid_until > as_of))
 */
export function knowledgeQuery(
  db: Database,
  options: KnowledgeQueryOptions
): KnowledgeEntry[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.subject) {
    conditions.push("subject = ?");
    params.push(toSlug(options.subject));
  }
  if (options.predicate) {
    conditions.push("predicate = ?");
    params.push(options.predicate.toLowerCase().trim());
  }
  if (options.object) {
    conditions.push("object LIKE ? ESCAPE '\\'");
    params.push(`%${options.object.replace(/[%_\\]/g, '\\$&')}%`);
  }
  if (options.scope) {
    // Multi-agent: scope filter also includes global
    conditions.push("(scope = ? OR scope = 'global')");
    params.push(options.scope);
  }
  if (options.as_of !== undefined) {
    conditions.push("(valid_from IS NULL OR valid_from <= ?)");
    params.push(options.as_of);
    conditions.push("(valid_until IS NULL OR valid_until > ?)");
    params.push(options.as_of);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options.limit ?? 50;

  return db.prepare(`
    SELECT * FROM knowledge ${where} ORDER BY created_at DESC LIMIT ?
  `).all(...params, limit) as KnowledgeEntry[];
}

/**
 * Invalidate a fact by setting valid_until to now. A fact whose window
 * already ended (valid_until <= now) is left alone; one that is still in
 * force but already has a later end (a future-dated successor) is ended now.
 */
export function knowledgeInvalidate(
  db: Database,
  id: string
): { invalidated: boolean } {
  const existing = db.prepare(`SELECT id, valid_until FROM knowledge WHERE id = ?`).get(id) as { id: string; valid_until: number | null } | null;
  if (!existing) return { invalidated: false };
  const now = Date.now();
  if (existing.valid_until !== null && existing.valid_until <= now) return { invalidated: false }; // already expired

  db.prepare(`UPDATE knowledge SET valid_until = ? WHERE id = ?`).run(now, id);
  return { invalidated: true };
}

/**
 * List all known entities (unique subjects).
 */
export function knowledgeEntities(db: Database): string[] {
  const rows = db.prepare(`SELECT DISTINCT subject FROM knowledge ORDER BY subject`).all() as { subject: string }[];
  return rows.map(r => r.subject);
}

/**
 * Get all current facts about a subject: those in force now, read the same
 * way as knowledgeQuery's as_of. Not "valid_until IS NULL": a fact can be in
 * force now and already end at a future-dated successor, and an open-ended
 * future-dated fact is not current yet.
 */
export function knowledgeAbout(db: Database, subject: string): KnowledgeEntry[] {
  const slug = toSlug(subject);
  const now = Date.now();
  return db.prepare(`
    SELECT * FROM knowledge WHERE subject = ?
      AND (valid_from IS NULL OR valid_from <= ?)
      AND (valid_until IS NULL OR valid_until > ?)
    ORDER BY predicate
  `).all(slug, now, now) as KnowledgeEntry[];
}

/**
 * Timeline: all facts about an entity, sorted by time (including expired).
 * From MemPalace tool_kg_timeline.
 */
export function knowledgeTimeline(db: Database, subject: string): KnowledgeEntry[] {
  const slug = toSlug(subject);
  return db.prepare(`
    SELECT * FROM knowledge WHERE subject = ? ORDER BY valid_from ASC, created_at ASC
  `).all(slug) as KnowledgeEntry[];
}

/**
 * Knowledge graph stats.
 */
export function knowledgeStats(db: Database): {
  entities: number; facts: number; activeFacts: number; expiredFacts: number;
} {
  const entities = (db.prepare(`SELECT COUNT(DISTINCT subject) as c FROM knowledge`).get() as { c: number }).c;
  const facts = (db.prepare(`SELECT COUNT(*) as c FROM knowledge`).get() as { c: number }).c;
  const activeFacts = (db.prepare(`SELECT COUNT(*) as c FROM knowledge WHERE valid_until IS NULL`).get() as { c: number }).c;
  return { entities, facts, activeFacts, expiredFacts: facts - activeFacts };
}

// =============================================================================
// Synthesis / consolidation (cat 11 — Sleep Consolidation level promotion + Zep community)
// =============================================================================

type MemoryCategory = "preference" | "fact" | "decision" | "entity" | "reflection" | "other";
type SynthesisStoreFn = (db: Database, opts: {
  text: string;
  category?: MemoryCategory;
  scope?: string;
  importance?: number;
}) => Promise<{ id: string; status: "created" | "duplicate"; duplicate_id?: string }>;

/**
 * Per-entity fact consolidation — temporal-anchored, predicate-grouped.
 *
 * Generates two types of synthesis memory per entity:
 *  1. PROFILE — all facts joined as a self-contained dossier ("[entity-summary:slug] ...")
 *  2. TIMELINE — date-anchored facts in chronological order ("[entity-timeline:slug] ...")
 *
 * Both stored as high-importance entity-category memories so they rank
 * highly for multi-hop ("what does X do") and temporal ("when did X") queries.
 *
 * From: Sleep Consolidation (level promotion), Zep (community subgraph),
 * GraphRAG (community summarization), Tinkerclaw Total Recall (timeline preservation).
 */
export async function consolidateEntityFacts(
  db: Database,
  storeFn: SynthesisStoreFn,
  options: { scope?: string; minFacts?: number } = {}
): Promise<{ entities: number; profiles: number; timelines: number; skipped: number }> {
  const minFacts = options.minFacts ?? 2;
  const entities = knowledgeEntities(db);
  let profiles = 0;
  let timelines = 0;
  let skipped = 0;

  for (const entity of entities) {
    const facts = knowledgeAbout(db, entity);
    if (facts.length < minFacts) { skipped++; continue; }

    const display = entity.replace(/_/g, " ");

    // 1. PROFILE — group facts by predicate for readability
    // ("places: rome, paris. occupation: dancer. likes: pizza, music.")
    const byPredicate = new Map<string, string[]>();
    for (const f of facts) {
      const pred = f.predicate.replace(/_/g, " ");
      if (!byPredicate.has(pred)) byPredicate.set(pred, []);
      byPredicate.get(pred)!.push(f.object);
    }
    const profileLines = [...byPredicate.entries()].map(
      ([pred, objs]) => `${pred}: ${[...new Set(objs)].join(", ")}`
    );
    const profileText = `[entity-summary:${entity}] ${display}. ${profileLines.join(". ")}.`;

    try {
      const r = await storeFn(db, {
        text: profileText,
        category: "entity",
        scope: options.scope,
        importance: 0.85,
      });
      if (r.status === "created") profiles++;
    } catch { /* skip */ }

    // 2. TIMELINE — only facts with valid_from, sorted chronologically
    const dated = facts
      .filter(f => f.valid_from != null)
      .sort((a, b) => (a.valid_from! - b.valid_from!));

    if (dated.length >= 2) {
      // Natural date format matches LoCoMo answer tokens
      // (ISO format `[2023-05-08]` cost ~3pp R@5 due to tokenizer mismatch)
      const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const fmtDate = (ms: number) => {
        const d = new Date(ms);
        return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${d.getUTCFullYear()}`;
      };
      const timelineLines = dated.map(f => {
        const date = fmtDate(f.valid_from!);
        const pred = f.predicate.replace(/_/g, " ");
        return `[${date}] ${display} ${pred} ${f.object}`;
      });
      const timelineText = `[entity-timeline:${entity}] ${timelineLines.join(". ")}.`;

      try {
        const r = await storeFn(db, {
          text: timelineText,
          category: "entity",
          scope: options.scope,
          importance: 0.85,
        });
        if (r.status === "created") timelines++;
      } catch { /* skip */ }
    }
  }

  return { entities: entities.length, profiles, timelines, skipped };
}
