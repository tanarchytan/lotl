export type ConceptKind = "docs" | "memory" | "entities";

export interface ConceptRef { id: string; type: string; title: string; description: string; }
export interface ConceptGroup { path: string; title: string; type: string; count: number; description: string; }
export interface Concept extends ConceptRef { tags: string[]; timestamp: string | null; links: string[]; body: string; }

const MEMORY_ID_LEN = 8;

export function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function memoryCategoryToType(category: string): string {
  return capitalize(category || "other");
}

/** Slug for entity ids: lowercase, non-alnum runs -> single hyphen, trim hyphens. (OKF/URL style; intentionally NOT knowledge.ts's underscore slug.) */
export function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function buildDocId(collection: string, path: string): string {
  const p = path.replace(/\.md$/i, "");
  return `docs/${collection}/${p}`;
}

export function buildMemoryId(scope: string, memoryId: string): string {
  return `memory/${scope}/${memoryId.slice(0, MEMORY_ID_LEN)}`;
}

export function buildEntityId(subject: string): string {
  return `entities/${toSlug(subject)}`;
}

export function conceptKind(id: string): ConceptKind {
  const head = id.split("/", 1)[0];
  if (head === "docs" || head === "memory" || head === "entities") return head;
  throw new Error(`unknown concept id prefix: ${id}`);
}

export function parseConceptId(id: string): { kind: ConceptKind; group: string; rest: string } {
  const kind = conceptKind(id);
  const parts = id.split("/");
  if (kind === "entities") return { kind, group: "entities", rest: parts.slice(1).join("/") };
  const group = `${parts[0]}/${parts[1]}`;
  const rest = parts.slice(2).join("/");
  return { kind, group, rest };
}
