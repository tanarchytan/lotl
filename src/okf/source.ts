import type { Database } from "../db.js";
import { listCollections } from "../store/context.js";
import { knowledgeEntities, knowledgeAbout } from "../memory/knowledge.js";
import {
  buildDocId, buildMemoryId, buildEntityId, memoryCategoryToType, parseConceptId, conceptKind,
  type Concept, type ConceptRef, type ConceptGroup,
} from "./concept.js";

const DESC_MAX = 120;

export interface ConceptSource {
  listGroups(): ConceptGroup[];
  listConcepts(group: string, opts?: { limit?: number; offset?: number }): { refs: ConceptRef[]; total: number };
  getConcept(id: string): Concept | null;
}

export type MemRow = { id: string; text: string; category: string; scope: string; metadata: string | null; last_accessed: number | null; created_at: number };

function firstLine(text: string): string {
  const line = (text || "").split("\n").map(s => s.trim()).find(Boolean) ?? "";
  return line.length > DESC_MAX ? line.slice(0, DESC_MAX - 1) + "…" : line;
}
function metaField(metadata: string | null, key: "description" | "original"): string | null {
  if (!metadata) return null;
  try { const m = JSON.parse(metadata); return typeof m?.[key] === "string" ? m[key] : null; } catch { return null; }
}
/** Full text for a memory: the archived pre-compaction original when the OKF
 *  byte budget shortened `text`, otherwise `text` itself. Progressive
 *  disclosure serves the index line from `text`, the whole thing from here. */
function memBody(r: MemRow): string {
  return metaField(r.metadata, "original") ?? r.text;
}
function isoOrNull(ms: number | null): string | null { return ms ? new Date(ms).toISOString() : null; }
/** Row -> compact index ref. Exported so other okf/ modules (e.g. timeline.ts) reuse it instead of duplicating. */
export function memRowToRef(r: MemRow): ConceptRef {
  return { id: buildMemoryId(r.scope, r.id), type: memoryCategoryToType(r.category),
           title: firstLine(r.text).slice(0, 60), description: metaField(r.metadata, "description") ?? firstLine(r.text) };
}
/** Extract [[id]] wiki-links and bundle-relative markdown links as outbound concept ids. */
function extractLinks(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) ids.add(m[1]!.trim());
  for (const m of body.matchAll(/\]\((\/[^)]+)\)/g)) ids.add(m[1]!.replace(/^\//, "").replace(/\.md$/i, ""));
  return [...ids];
}

export class SqliteConceptSource implements ConceptSource {
  constructor(private db: Database) {}

  listGroups(): ConceptGroup[] {
    const groups: ConceptGroup[] = [];
    for (const c of listCollections(this.db)) {
      groups.push({ path: `docs/${c.name}`, title: c.name, type: "Collection", count: c.active_count, description: `${c.active_count} documents` });
    }
    const scopes = this.db.prepare(`SELECT scope, COUNT(*) AS c FROM memories GROUP BY scope ORDER BY scope`).all() as { scope: string; c: number }[];
    for (const s of scopes) {
      groups.push({ path: `memory/${s.scope}`, title: s.scope, type: "Memory scope", count: s.c, description: `${s.c} memories` });
    }
    const entities = knowledgeEntities(this.db);
    if (entities.length) groups.push({ path: "entities", title: "Entities", type: "Entities", count: entities.length, description: `${entities.length} entities` });
    return groups;
  }

  listConcepts(group: string, opts: { limit?: number; offset?: number } = {}): { refs: ConceptRef[]; total: number } {
    const limit = Math.min(opts.limit ?? 50, 500);
    const offset = opts.offset ?? 0;

    if (group.startsWith("memory/")) {
      const scope = group.slice("memory/".length);
      const total = (this.db.prepare(`SELECT COUNT(*) c FROM memories WHERE scope=?`).get(scope) as { c: number }).c;
      const rows = this.db.prepare(
        `SELECT id, text, category, scope, metadata, last_accessed, created_at FROM memories WHERE scope=? ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).all(scope, limit, offset) as MemRow[];
      return { refs: rows.map(memRowToRef), total };
    }

    if (group === "entities") {
      const all = knowledgeEntities(this.db);
      const page = all.slice(offset, offset + limit);
      const refs = page.map(subject => {
        const latest = knowledgeAbout(this.db, subject)[0];
        return { id: buildEntityId(subject), type: "Entity", title: subject, description: latest ? `${latest.predicate} ${latest.object}` : "" };
      });
      return { refs, total: all.length };
    }

    if (group.startsWith("docs/")) {
      const collection = group.slice("docs/".length);
      const total = (this.db.prepare(`SELECT COUNT(*) c FROM documents WHERE collection=? AND active=1`).get(collection) as { c: number }).c;
      const rows = this.db.prepare(
        `SELECT path, title FROM documents WHERE collection=? AND active=1 ORDER BY path LIMIT ? OFFSET ?`
      ).all(collection, limit, offset) as { path: string; title: string }[];
      const refs = rows.map(r => ({ id: buildDocId(collection, r.path), type: "Document", title: r.title || r.path, description: "" }));
      return { refs, total };
    }

    return { refs: [], total: 0 };
  }

  getConcept(id: string): Concept | null {
    const kind = conceptKind(id);

    if (kind === "memory") {
      const r = this.getMemoryRow(id);
      if (!r) return null;
      const body = memBody(r);
      return { ...memRowToRef(r), tags: [], timestamp: isoOrNull(r.last_accessed ?? r.created_at), links: extractLinks(body), body };
    }

    if (kind === "entities") {
      const subject = knowledgeEntities(this.db).find(s => buildEntityId(s) === id);
      if (!subject) return null;
      const facts = knowledgeAbout(this.db, subject);
      const body = facts.map(f => `- ${f.predicate} ${f.object}`).join("\n");
      return { id, type: "Entity", title: subject, description: facts[0] ? `${facts[0].predicate} ${facts[0].object}` : "",
               tags: [], timestamp: null, links: [], body };
    }

    // docs
    const { group, rest } = parseConceptId(id);
    const collection = group.slice("docs/".length);
    const row = this.db.prepare(
      `SELECT d.title AS title, d.modified_at AS modified_at, c.doc AS body
       FROM documents d JOIN content c ON c.hash = d.hash
       WHERE d.collection=? AND d.active=1 AND (d.path=? OR d.path=?)`
    ).get(collection, rest, `${rest}.md`) as { title: string; modified_at: string; body: string } | undefined;
    if (!row) return null;
    return { id, type: "Document", title: row.title || rest, description: "",
             tags: [], timestamp: row.modified_at ?? null, links: extractLinks(row.body), body: row.body };
  }

  /** Raw memory row by concept id (0 = not found; >1 shouldn't happen with 8-char ids -> treated as not found). */
  getMemoryRow(id: string): MemRow | null {
    const { group, rest } = parseConceptId(id);
    const scope = group.slice("memory/".length);
    const rows = this.db.prepare(
      `SELECT id, text, category, scope, metadata, last_accessed, created_at FROM memories WHERE scope=? AND substr(id,1,8)=?`
    ).all(scope, rest) as MemRow[];
    return rows.length === 1 ? rows[0]! : null;
  }
}
