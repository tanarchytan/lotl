import type { ConceptGroup, ConceptRef } from "./concept.js";

function line(id: string, title: string, description: string): string {
  return description ? `* [${title}](${id}) — ${description}` : `* [${title}](${id})`;
}

export function renderRefs(refs: ConceptRef[]): string {
  return refs.map(r => line(r.id, r.title, r.description)).join("\n");
}

export function renderGroups(groups: ConceptGroup[]): string {
  const byType = new Map<string, ConceptGroup[]>();
  for (const g of groups) {
    const list = byType.get(g.type) ?? [];
    list.push(g);
    byType.set(g.type, list);
  }
  const sections: string[] = [];
  for (const [type, gs] of byType) {
    sections.push(`# ${type}\n\n` + gs.map(g => line(g.path, g.title, g.description)).join("\n"));
  }
  return sections.join("\n\n");
}
