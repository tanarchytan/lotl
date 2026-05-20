// src/vault/templates.ts
// Pure rendering helpers. No I/O. Subsystem 1 (v1.2.0-alpha.1).

import { toSlug } from "../memory/knowledge.js";

export function slugForSubject(subject: string): string {
  return toSlug(subject);
}

export function sanitizeScope(scope: string): string {
  const cleaned = scope
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return cleaned.length > 0 ? cleaned : "scope";
}

export function disambiguateSlug(
  slug: string,
  scope: string,
  taken: Set<string>,
): string {
  if (!taken.has(slug)) return slug;
  const prefixed = `${sanitizeScope(scope)}-${slug}`;
  if (!taken.has(prefixed)) return prefixed;
  let n = 2;
  while (taken.has(`${prefixed}-${n}`)) n += 1;
  return `${prefixed}-${n}`;
}

export interface EntityFact {
  predicate: string;
  object: string;
  valid_from: string;
  valid_until: string | null;
}

export interface LinkedMemory {
  memory_id: string;
  excerpt: string;
}

export interface EntityPageInput {
  subject: string;
  scope: string;
  facts: EntityFact[];
  linkedMemories: LinkedMemory[];
}

function escapeForYamlString(value: string): string {
  return value.replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}

function escapeForWikilink(value: string): string {
  return value.replace(/\\/g, "").replace(/[\[\]]/g, "").replace(/\r?\n/g, " ");
}

function flattenAndTruncate(text: string, max = 200): string {
  const flat = text.replace(/\r?\n/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}...`;
}

function truncate(text: string, max = 200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function pickTimestamps(facts: EntityFact[]): { created: string; updated: string } {
  if (facts.length === 0) {
    const now = "1970-01-01T00:00:00Z";
    return { created: now, updated: now };
  }
  const all = facts.flatMap((f) =>
    f.valid_until ? [f.valid_from, f.valid_until] : [f.valid_from],
  );
  const sorted = [...all].sort();
  return { created: sorted[0]!, updated: sorted[sorted.length - 1]! };
}

export function renderEntityPage(input: EntityPageInput): string {
  const { subject, scope, facts, linkedMemories } = input;
  const current = facts.filter((f) => f.valid_until === null);
  const historical = facts.filter((f) => f.valid_until !== null);
  const { created, updated } = pickTimestamps(facts);

  const lines: string[] = [];
  lines.push("---");
  lines.push(`title: "${escapeForYamlString(subject)}"`);
  lines.push("type: entity");
  lines.push(`scope: "${escapeForYamlString(scope)}"`);
  lines.push(`created_at: "${created}"`);
  lines.push(`updated_at: "${updated}"`);
  lines.push(`fact_count: ${facts.length}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${subject.replace(/\r?\n/g, " ")}`);
  lines.push("");
  lines.push("## Current facts");
  lines.push("");
  if (current.length === 0) {
    lines.push("*no current facts*");
  } else {
    for (const f of current) {
      lines.push(
        `- **${f.predicate}** [[${escapeForWikilink(f.object)}]] *(since ${f.valid_from})*`,
      );
    }
  }
  lines.push("");

  if (historical.length > 0) {
    lines.push("## Historical facts");
    lines.push("");
    for (const f of historical) {
      lines.push(
        `- **${f.predicate}** [[${escapeForWikilink(f.object)}]] *(${f.valid_from} → ${f.valid_until})*`,
      );
    }
    lines.push("");
  }

  if (linkedMemories.length > 0) {
    lines.push("## Linked memories");
    lines.push("");
    for (const m of linkedMemories) {
      lines.push(
        `- [[memory-${shortId(m.memory_id)}]] — ${flattenAndTruncate(m.excerpt)}`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
