/**
 * memory/hash.ts — the one definition of a memory row's `content_hash`.
 *
 * Kept free of other lotl imports so store/db-init.ts can use it in a
 * migration without pulling in the memory module (circular import).
 *
 * Invariant: the hash covers the FULL text a row can give back, i.e. the OKF
 * pre-compaction original in `metadata.original` when there is one, else
 * `text`. Hashing the compacted body made two different long memories that
 * share a head collide, and the second was dropped as a "duplicate".
 */
import { createHash } from "node:crypto";

/** Normalized text hash used for exact dedup. Case- and edge-whitespace-insensitive. */
export function contentHash(text: string): string {
  return createHash("md5").update(text.trim().toLowerCase()).digest("hex");
}

/** `metadata.original` when it is a usable string, else null. Accepts the
 *  parsed object or the raw JSON column; junk metadata reads as no original. */
export function metadataOriginal(metadata: Record<string, unknown> | string | null | undefined): string | null {
  let meta: unknown = metadata;
  if (typeof metadata === "string") {
    try { meta = JSON.parse(metadata); } catch { return null; }
  }
  if (!meta || typeof meta !== "object") return null;
  const original = (meta as Record<string, unknown>).original;
  return typeof original === "string" && original.trim() ? original : null;
}

/** The full text a row stands for: the archived original, else `text`. */
export function memoryFullText(text: string, metadata: Record<string, unknown> | string | null | undefined): string {
  return metadataOriginal(metadata) ?? text;
}

/** `content_hash` for a row with this `text` and `metadata`. Every writer of
 *  `content_hash` (store, batch, update, merge, compact, import, migration)
 *  goes through here, so the same full text always hashes the same way. */
export function memoryRowHash(text: string, metadata: Record<string, unknown> | string | null | undefined): string {
  return contentHash(memoryFullText(text, metadata));
}
