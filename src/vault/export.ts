// src/vault/export.ts
// KG -> vault Markdown exporter. Subsystem 1 (v1.2.0-alpha.1).

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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

import type { Database as BetterSqlite3Database } from "better-sqlite3";

export function createSqliteDataSource(
  db: BetterSqlite3Database,
): VaultDataSource {
  return {
    async listScopes() {
      const rows = db
        .prepare("SELECT DISTINCT scope FROM knowledge ORDER BY scope")
        .all() as { scope: string }[];
      return rows.map((r) => r.scope);
    },
    async triplesForScope(scope) {
      return db
        .prepare(
          `SELECT id, subject, predicate, object, valid_from, valid_until,
                  source_memory_id, scope, created_at
             FROM knowledge WHERE scope = ?`,
        )
        .all(scope) as RawTriple[];
    },
    async memoriesForScope(scope) {
      return db
        .prepare(
          `SELECT id, scope, text, importance, created_at
             FROM memories WHERE scope = ?`,
        )
        .all(scope) as RawMemory[];
    },
    async kgCount(scope) {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM knowledge WHERE scope = ?")
        .get(scope) as { n: number };
      return row.n;
    },
    async maxUpdatedAt(scope) {
      const row = db
        .prepare(
          `SELECT MAX(ts) AS ts FROM (
             SELECT valid_from AS ts FROM knowledge WHERE scope = ?
             UNION ALL
             SELECT valid_until AS ts FROM knowledge WHERE scope = ? AND valid_until IS NOT NULL
           )`,
        )
        .get(scope, scope) as { ts: string | null };
      return row.ts ?? null;
    },
  };
}

export interface ScopeExportMetadata {
  schema_version: 1;
  exported_at: string;
  scope: string;
  kg_count: number;
  memory_count: number;
  hash: string;
}

export interface ScopePayload {
  entities: { slug: string; body: string }[];
  inbox: string;
  metadata: ScopeExportMetadata;
}

function timestampToken(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function writeScopeAtomically(
  scopeRoot: string,
  payload: ScopePayload,
): Promise<void> {
  for (const e of payload.entities) {
    if (!e.slug || e.slug.length === 0) {
      throw new Error("empty entity slug — refusing to write");
    }
  }
  await mkdir(scopeRoot, { recursive: true });
  const tmp = join(scopeRoot, ".tmp");
  if (existsSync(tmp)) await rm(tmp, { recursive: true, force: true });
  await mkdir(join(tmp, "entities"), { recursive: true });
  for (const e of payload.entities) {
    await writeFile(join(tmp, "entities", `${e.slug}.md`), e.body, "utf8");
  }
  await writeFile(join(tmp, "inbox.md"), payload.inbox, "utf8");
  await writeFile(
    join(tmp, ".lotl-export.json"),
    `${JSON.stringify(payload.metadata, null, 2)}\n`,
    "utf8",
  );

  const ts = timestampToken();
  const oldEntities = join(scopeRoot, `.old-entities-${ts}`);
  const oldInbox = join(scopeRoot, `.old-inbox-${ts}.md`);
  const oldMeta = join(scopeRoot, `.old-export-${ts}.json`);

  if (existsSync(join(scopeRoot, "entities"))) {
    await rename(join(scopeRoot, "entities"), oldEntities);
  }
  if (existsSync(join(scopeRoot, "inbox.md"))) {
    await rename(join(scopeRoot, "inbox.md"), oldInbox);
  }
  if (existsSync(join(scopeRoot, ".lotl-export.json"))) {
    await rename(join(scopeRoot, ".lotl-export.json"), oldMeta);
  }

  await rename(join(tmp, "entities"), join(scopeRoot, "entities"));
  await rename(join(tmp, "inbox.md"), join(scopeRoot, "inbox.md"));
  await rename(
    join(tmp, ".lotl-export.json"),
    join(scopeRoot, ".lotl-export.json"),
  );
  await rm(tmp, { recursive: true, force: true });

  for (const stale of [oldEntities, oldInbox, oldMeta]) {
    if (existsSync(stale)) await rm(stale, { recursive: true, force: true });
  }
}

export async function readScopeMetadata(
  scopeRoot: string,
): Promise<ScopeExportMetadata | null> {
  const path = join(scopeRoot, ".lotl-export.json");
  if (!existsSync(path)) return null;
  try {
    const raw = await (await import("node:fs/promises")).readFile(path, "utf8");
    return JSON.parse(raw) as ScopeExportMetadata;
  } catch {
    return null;
  }
}
