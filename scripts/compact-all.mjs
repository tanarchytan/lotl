// Compacts ALL memories in the lotl DB, not just over-budget ones.
// Sets metadata.description (caveman one-liner) on every memory.
// Archives originals in metadata.original on any memory that changes.
// Usage: node scripts/compact-all.mjs [--apply]

import { openDatabase } from "../dist/db.js";
import { initializeDatabase } from "../dist/store/db-init.js";
import { heuristicCompact } from "../dist/okf/budget.js";
import { memoryUpdate } from "../dist/memory/index.js";

const DB = process.argv.includes("--db")
  ? process.argv[process.argv.indexOf("--db") + 1]
  : `${process.env.HOME}/.cache/lotl/index.sqlite`;
const APPLY = process.argv.includes("--apply");

const db = openDatabase(DB);
initializeDatabase(db);

const all = db.prepare(`SELECT id, text, category, scope, importance, metadata FROM memories ORDER BY LENGTH(text) DESC`).all();

let compacted = 0, skipped = 0;
for (const mem of all) {
  let meta = {};
  try { meta = mem.metadata ? JSON.parse(mem.metadata) : {}; } catch {}
  // Skip if already has a description (already compacted)
  if (meta.description) { skipped++; continue; }

  const { description, body } = heuristicCompact(mem.text);
  const changed = body !== mem.text || !meta.description;

  if (!APPLY) {
    if (changed) console.log(`WOULD compact ${mem.id.slice(0, 8)} (${mem.text.length}→${(body||'').length}) ${(description||'').slice(0, 60)}`);
    compacted++;
  } else {
    await memoryUpdate(db, {
      id: mem.id,
      text: body,
      metadata: { ...meta, ...(meta.original ? {} : { original: mem.text }), description },
    });
    compacted++;
    if (compacted % 20 === 0) console.error(`  ${compacted}/${all.length}...`);
  }
}

if (!APPLY) {
  console.log(`\nDry run: would compact ${compacted} memories (${skipped} already done).`);
  console.log("Re-run with --apply to write.");
} else {
  console.log(`Compacted ${compacted} memories (${skipped} already done).`);
}
db.close();
