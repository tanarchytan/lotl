import type { Database } from "../db.js";
import { memoryRecall } from "../memory/index.js";
import { buildMemoryId, capitalize, type ConceptRef } from "./concept.js";

type StoreLike = {
  db: Database;
  searchFTS: (q: string, limit?: number) => Array<{ displayPath?: string; title?: string; collectionName?: string }>;
};

const DESC_MAX = 120;
function firstLine(text: string): string {
  const l = (text || "").split("\n").map(s => s.trim()).find(Boolean) ?? "";
  return l.length > DESC_MAX ? l.slice(0, DESC_MAX - 1) + "…" : l;
}

export async function okfRecall(store: StoreLike, query: string, opts: { limit?: number; maxBytes?: number } = {}): Promise<ConceptRef[]> {
  const limit = opts.limit ?? 8;
  const maxBytes = opts.maxBytes ?? 2000;
  const refs: ConceptRef[] = [];

  const mem = await memoryRecall(store.db, { query, limit, rerank: false });
  for (const m of mem) {
    refs.push({ id: buildMemoryId(m.scope, m.id), type: capitalize(m.category), title: firstLine(m.text).slice(0, 60), description: firstLine(m.text) });
  }
  try {
    for (const d of store.searchFTS(query, limit)) {
      const path = (d.displayPath ?? "").replace(/\.md$/i, "");
      refs.push({ id: `docs/${d.collectionName ?? ""}/${path}`, type: "Document", title: d.title ?? path, description: "" });
    }
  } catch { /* fail-open: docs FTS optional */ }

  const capped: ConceptRef[] = [];
  let bytes = 0;
  for (const r of refs.slice(0, limit)) {
    const size = Buffer.byteLength(`${r.title}${r.description}${r.id}`);
    if (bytes + size > maxBytes && capped.length) break;
    bytes += size;
    capped.push(r);
  }
  return capped;
}
