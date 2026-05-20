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
