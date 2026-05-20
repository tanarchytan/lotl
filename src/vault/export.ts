// src/vault/export.ts
// KG -> vault Markdown exporter. Subsystem 1 (v1.2.0-alpha.1).

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeScope } from "./templates.js";
import type { EntityFact, InboxMemory, LinkedMemory } from "./templates.js";

export function resolveVaultRoot(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const override = env.LOTL_VAULT_PATH;
  if (override && override.length > 0) {
    if (override.startsWith("~")) return join(home, override.slice(1).replace(/^[\\/]/, ""));
    return override;
  }
  return join(home, ".local", "share", "lotl", "vault");
}

export function scopeDir(root: string, scope: string): string {
  return join(root, sanitizeScope(scope));
}

export function computeScopeHash(
  kgCount: number,
  maxUpdatedAt: string | null,
): string {
  return createHash("sha256")
    .update(`${kgCount}:${maxUpdatedAt ?? ""}`)
    .digest("hex");
}

export interface RawTriple {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: string;
  valid_until: string | null;
  source_memory_id: string | null;
  scope: string;
  created_at: string;
}

export interface RawMemory {
  id: string;
  scope: string;
  text: string;
  importance: number;
  created_at: string;
}

export interface VaultDataSource {
  listScopes(): Promise<string[]>;
  triplesForScope(scope: string): Promise<RawTriple[]>;
  memoriesForScope(scope: string): Promise<RawMemory[]>;
  kgCount(scope: string): Promise<number>;
  maxUpdatedAt(scope: string): Promise<string | null>;
}

export interface EntityGroup {
  subject: string;
  scope: string;
  facts: EntityFact[];
  linkedMemories: LinkedMemory[];
}

function dedupeFacts(triples: RawTriple[]): EntityFact[] {
  const seen = new Set<string>();
  const out: EntityFact[] = [];
  for (const t of triples) {
    const key = `${t.predicate}|${t.object}|${t.valid_from}|${t.valid_until ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      predicate: t.predicate,
      object: t.object,
      valid_from: t.valid_from,
      valid_until: t.valid_until,
    });
  }
  return out;
}

export async function collectEntityFacts(
  ds: VaultDataSource,
  scope: string,
): Promise<EntityGroup[]> {
  const triples = await ds.triplesForScope(scope);
  const bySubject = new Map<string, RawTriple[]>();
  for (const t of triples) {
    if (!bySubject.has(t.subject)) bySubject.set(t.subject, []);
    bySubject.get(t.subject)!.push(t);
  }
  const memories = await ds.memoriesForScope(scope);
  const memoryById = new Map(memories.map((m) => [m.id, m]));

  const groups: EntityGroup[] = [];
  for (const [subject, subjectTriples] of bySubject) {
    const linkedIds = new Set<string>();
    for (const t of subjectTriples) {
      if (t.source_memory_id) linkedIds.add(t.source_memory_id);
    }
    const linkedMemories: LinkedMemory[] = [];
    for (const id of linkedIds) {
      const m = memoryById.get(id);
      if (!m) continue;
      linkedMemories.push({ memory_id: m.id, excerpt: m.text });
    }
    groups.push({
      subject,
      scope,
      facts: dedupeFacts(subjectTriples),
      linkedMemories,
    });
  }
  groups.sort((a, b) => (a.subject < b.subject ? -1 : 1));
  return groups;
}

export async function collectOrphanMemories(
  ds: VaultDataSource,
  scope: string,
): Promise<InboxMemory[]> {
  const triples = await ds.triplesForScope(scope);
  const referenced = new Set<string>();
  for (const t of triples) {
    if (t.source_memory_id) referenced.add(t.source_memory_id);
  }
  const memories = await ds.memoriesForScope(scope);
  return memories
    .filter((m) => !referenced.has(m.id))
    .map((m) => ({
      memory_id: m.id,
      created_at: m.created_at,
      importance: m.importance,
      excerpt: m.text,
    }));
}

interface FixturePayload {
  triples: RawTriple[];
  memories: RawMemory[];
}

export function loadFixtureDataSource(payload: FixturePayload): VaultDataSource {
  return {
    async listScopes() {
      return Array.from(new Set(payload.triples.map((t) => t.scope))).sort();
    },
    async triplesForScope(scope) {
      return payload.triples.filter((t) => t.scope === scope);
    },
    async memoriesForScope(scope) {
      return payload.memories.filter((m) => m.scope === scope);
    },
    async kgCount(scope) {
      return payload.triples.filter((t) => t.scope === scope).length;
    },
    async maxUpdatedAt(scope) {
      const stamps: string[] = [];
      for (const t of payload.triples) {
        if (t.scope !== scope) continue;
        stamps.push(t.valid_from);
        if (t.valid_until) stamps.push(t.valid_until);
      }
      if (stamps.length === 0) return null;
      stamps.sort();
      return stamps[stamps.length - 1]!;
    },
  };
}

export async function listScopes(ds: VaultDataSource): Promise<string[]> {
  return ds.listScopes();
}
