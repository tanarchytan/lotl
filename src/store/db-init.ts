// =============================================================================
// Database initialization
// =============================================================================

import { loadSqliteVec } from "../db.js";
import type { Database } from "../db.js";
import { memoryRowHash, metadataOriginal } from "../memory/hash.js";

function createSqliteVecUnavailableError(reason: string): Error {
  return new Error(
    "sqlite-vec extension is unavailable. " +
    `${reason}. ` +
    "Install Homebrew SQLite so the sqlite-vec extension can be loaded, " +
    "and set BREW_PREFIX if Homebrew is installed in a non-standard location."
  );
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function verifySqliteVecLoaded(db: Database): void {
  try {
    const row = db.prepare(`SELECT vec_version() AS version`).get() as { version?: string } | null;
    if (!row?.version || typeof row.version !== "string") {
      throw new Error("vec_version() returned no version");
    }
  } catch (err) {
    const message = getErrorMessage(err);
    throw createSqliteVecUnavailableError(`sqlite-vec probe failed (${message})`);
  }
}

let _sqliteVecAvailable: boolean | null = null;
// Captured at initialization so ensureVecTableInternal can surface the
// original cause instead of a generic "extension not available" string.
// Upstream tobi/qmd 0adbdeb.
let _sqliteVecUnavailableReason: string | null = null;

export function isSqliteVecAvailable(): boolean {
  return _sqliteVecAvailable === true;
}

export function initializeDatabase(db: Database): void {
  try {
    loadSqliteVec(db);
    verifySqliteVecLoaded(db);
    _sqliteVecAvailable = true;
    _sqliteVecUnavailableReason = null;
  } catch (err) {
    // sqlite-vec is optional -- vector search won't work but FTS is fine
    _sqliteVecAvailable = false;
    _sqliteVecUnavailableReason = getErrorMessage(err);
    console.warn(_sqliteVecUnavailableReason);
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA cache_size = -65536");       // 64MB page cache (default 2MB)
  db.exec("PRAGMA mmap_size = 268435456");     // 256MB memory-mapped I/O
  db.exec("PRAGMA synchronous = NORMAL");      // Safe with WAL, 2-5x faster writes
  db.exec("PRAGMA temp_store = MEMORY");       // Temp tables in RAM
  db.exec("PRAGMA wal_autocheckpoint = 2000"); // Fewer checkpoints during bulk ops

  // Drop legacy tables that are now managed in YAML
  db.exec(`DROP TABLE IF EXISTS path_contexts`);
  db.exec(`DROP TABLE IF EXISTS collections`);

  // Content-addressable storage - the source of truth for document content
  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Documents table - file system layer mapping virtual paths to content hashes
  // Collections are now managed in ~/.config/lotl/index.yml
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE,
      UNIQUE(collection, path)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection, active)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path, active)`);

  // Cache table for LLM API calls
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_cache (
      hash TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Content vectors
  const cvInfo = db.prepare(`PRAGMA table_info(content_vectors)`).all() as { name: string }[];
  const hasSeqColumn = cvInfo.some(col => col.name === 'seq');
  if (cvInfo.length > 0 && !hasSeqColumn) {
    db.exec(`DROP TABLE IF EXISTS content_vectors`);
    db.exec(`DROP TABLE IF EXISTS vectors_vec`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    )
  `);

  // Store collections -- makes the DB self-contained (no external config needed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_collections (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      pattern TEXT NOT NULL DEFAULT '**/*.md',
      ignore_patterns TEXT,
      include_by_default INTEGER DEFAULT 1,
      update_command TEXT,
      context TEXT
    )
  `);

  // Store config -- key-value metadata (e.g. config_hash for sync optimization)
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // FTS - index filepath (collection/path), title, and content
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      filepath, title, body,
      tokenize='porter unicode61'
    )
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents
    WHEN new.active = 1
    BEGIN
      INSERT INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      DELETE FROM documents_fts WHERE rowid = old.id;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents
    BEGIN
      -- Delete from FTS if no longer active
      DELETE FROM documents_fts WHERE rowid = old.id AND new.active = 0;

      -- Update FTS if still/newly active
      INSERT OR REPLACE INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  // ==========================================================================
  // Memory tables -- conversation memory for agents
  // ==========================================================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      scope TEXT NOT NULL DEFAULT 'global',
      importance REAL NOT NULL DEFAULT 0.5,
      tier TEXT NOT NULL DEFAULT 'peripheral',
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_accessed INTEGER,
      metadata TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash)`);

  // Phase 5 migration — fact-augmented embedding keys (design doc:
  // devnotes/architecture/phase5-kg-and-fact-aug-design.md). Adds two
  // nullable columns so pre-Phase-5 DBs upgrade in place. NULL means the
  // extraction pass hasn't run yet → LOTL_MEMORY_EMBED_SOURCE=fact falls
  // back to content embedding automatically.
  const memCols = db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
  const haveFactText = memCols.some((c) => c.name === "fact_text");
  const haveFactEmbed = memCols.some((c) => c.name === "fact_embedding");
  if (!haveFactText) db.exec(`ALTER TABLE memories ADD COLUMN fact_text TEXT`);
  if (!haveFactEmbed) db.exec(`ALTER TABLE memories ADD COLUMN fact_embedding BLOB`);

  // access_count conflates "surfaced in a result set" with "actually read".
  // A memory that ranks into every recall and is never opened looks identical
  // to one an agent opens every time. used_count separates them: it only
  // increments when a concept/memory is opened in full (okf_get, memory_get).
  // access_count keeps its exact old meaning and stays the sole decay input —
  // the Weibull tunables were validated at n=500 against it, so switching
  // promotion over to used_count is a benchmark question, not a refactor.
  if (!memCols.some((c) => c.name === "used_count")) {
    db.exec(`ALTER TABLE memories ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0`);
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      text, category, scope,
      tokenize='porter unicode61'
    )
  `);

  // Keep memories_fts in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, text, category, scope)
      VALUES (new.rowid, new.text, new.category, new.scope);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE rowid = old.rowid;
    END
  `);
  db.exec(`CREATE TRIGGER IF NOT EXISTS ${MEMORIES_AU_TRIGGER_SQL}`);

  // Non-fatal: a hash left on the old (body) basis only costs a missed exact
  // dedup, never data, and the watermark retries it on the next open. Failing
  // the open (busy lock past the timeout, read-only file) would cost more.
  try {
    migrateMemoryHashesToFullText(db);
  } catch (err) {
    process.stderr.write(`lotl: memory hash migration skipped (will retry next open): ${getErrorMessage(err)}\n`);
  }

  // Memory changelog -- audit trail for memory operations
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      timestamp INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_history_mid ON memory_history(memory_id)`);

  // ==========================================================================
  // Knowledge graph -- temporal entity-relationship triples
  // From MemPalace: facts with time validity windows
  // ==========================================================================

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      valid_from INTEGER,
      valid_until INTEGER,
      confidence REAL NOT NULL DEFAULT 1.0,
      source_memory_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_subject ON knowledge(subject)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_predicate ON knowledge(predicate)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_object ON knowledge(object)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_valid ON knowledge(valid_from, valid_until)`);
  // Add scope column for multi-agent isolation (migration-safe)
  try { db.exec(`ALTER TABLE knowledge ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'`); } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_scope ON knowledge(scope)`);
}

/** Body of the memories_au trigger, shared by the schema setup and the
 *  hash migration (which drops it for the duration of its UPDATE). */
const MEMORIES_AU_TRIGGER_SQL = `memories_au AFTER UPDATE ON memories BEGIN
      DELETE FROM memories_fts WHERE rowid = old.rowid;
      INSERT INTO memories_fts(rowid, text, category, scope)
      VALUES (new.rowid, new.text, new.category, new.scope);
    END`;

/** store_config key holding the highest memories rowid already checked. */
const HASH_MIGRATION_KEY = "memories_hash_full_text_rowid";

/**
 * Migration: OKF-compacted memories written by older builds carry the hash of
 * their compacted body. Recompute it from metadata.original (memoryRowHash)
 * so exact dedup compares full texts.
 *
 * - Watermarked, not one-shot: store_config keeps the highest rowid checked.
 *   An open with no new rows costs two indexed lookups. Rows added later by
 *   a still-running older process (an MCP server or plugin not yet
 *   restarted after an upgrade) are picked up on the next open.
 *   Re-running is harmless: same input, same hash.
 * - content_hash only has a plain (non-unique) index, so two rows whose
 *   originals are identical simply end up with the same hash. Nothing is
 *   deleted or merged; a later store of that text dedups to one of them.
 * - memories_au fires on every UPDATE and would delete + reinsert the FTS row
 *   of each touched memory. The text does not change, so the trigger is
 *   dropped and recreated around the UPDATE inside one transaction. Vectors
 *   are not touched.
 */
export function migrateMemoryHashesToFullText(db: Database): { checked: number; updated: number } {
  const readMark = () => {
    const row = db.prepare(`SELECT value FROM store_config WHERE key = ?`).get(HASH_MIGRATION_KEY) as { value: string } | undefined;
    return row ? Number(row.value) || 0 : 0;
  };
  const maxRowid = () => (db.prepare(`SELECT max(rowid) AS m FROM memories`).get() as { m: number | null }).m ?? 0;
  if (maxRowid() <= readMark()) return { checked: 0, updated: 0 };

  // BEGIN IMMEDIATE: take the write lock before reading, so two processes
  // opening the same index at once do the work once and never race on the
  // watermark. (The Database interface does not expose better-sqlite3's
  // transaction().immediate(), hence the explicit BEGIN/COMMIT.)
  db.exec("BEGIN IMMEDIATE");
  try {
    const mark = readMark();
    const top = maxRowid();
    if (top <= mark) { db.exec("COMMIT"); return { checked: 0, updated: 0 }; }
    // LIKE prefilter keeps the JSON parse to rows that can have an original.
    const rows = db.prepare(
      `SELECT rowid, text, content_hash, metadata FROM memories
       WHERE rowid > ? AND rowid <= ? AND metadata LIKE '%"original"%'`
    ).all(mark, top) as { rowid: number; text: string; content_hash: string; metadata: string | null }[];
    const changed: { rowid: number; hash: string }[] = [];
    for (const r of rows) {
      if (!metadataOriginal(r.metadata)) continue;
      const hash = memoryRowHash(r.text, r.metadata);
      if (hash !== r.content_hash) changed.push({ rowid: r.rowid, hash });
    }
    if (changed.length > 0) {
      db.exec(`DROP TRIGGER IF EXISTS memories_au`);
      const upd = db.prepare(`UPDATE memories SET content_hash = ? WHERE rowid = ?`);
      for (const c of changed) upd.run(c.hash, c.rowid);
      db.exec(`CREATE TRIGGER ${MEMORIES_AU_TRIGGER_SQL}`);
    }
    db.prepare(
      `INSERT INTO store_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(HASH_MIGRATION_KEY, String(top));
    db.exec("COMMIT");
    return { checked: rows.length, updated: changed.length };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

export function ensureVecTableInternal(db: Database, dimensions: number): void {
  if (!_sqliteVecAvailable) {
    throw createSqliteVecUnavailableError(
      _sqliteVecUnavailableReason ?? "vector operations require a SQLite build with extension loading support"
    );
  }
  const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { sql: string } | null;
  if (tableInfo) {
    const match = tableInfo.sql.match(/float\[(\d+)\]/);
    const hasHashSeq = tableInfo.sql.includes('hash_seq');
    const hasCosine = tableInfo.sql.includes('distance_metric=cosine');
    const existingDims = match?.[1] ? parseInt(match[1], 10) : null;
    if (existingDims === dimensions && hasHashSeq && hasCosine) return;
    if (existingDims !== null && existingDims !== dimensions) {
      // Auto-reindex path: drop the old vec table + purge content_vectors so
      // subsequent queries silently fall back to BM25 until the next embed
      // pass repopulates. Hardcoded auto-reindex (warn-only) as of 2026-04-21;
      // LOTL_STRICT_DIM_MISMATCH env knob was removed — fail-loud on dim
      // mismatch broke too many dev workflows to justify the guard rail.
      process.stderr.write(
        `lotl: embedding dimension changed (${existingDims}d → ${dimensions}d). ` +
        `Dropping stale vectors; run 'qmd embed -f' to repopulate.\n`
      );
      db.exec("DROP TABLE IF EXISTS vectors_vec");
      try { db.exec("DELETE FROM content_vectors"); } catch { /* table may not exist yet */ }
    } else {
      db.exec("DROP TABLE IF EXISTS vectors_vec");
    }
  }
  db.exec(`CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`);
}
