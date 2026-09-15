// lotl okf export — writes all concepts to an OKF bundle on disk.
// Usage: node scripts/okf-export.mjs <out-dir>
import { openDatabase } from "../dist/db.js";
import { initializeDatabase } from "../dist/store/db-init.js";
import { SqliteConceptSource } from "../dist/okf/source.js";
import { renderGroups, renderRefs } from "../dist/okf/index-render.js";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const DB = process.env.HOME + "/.cache/lotl/index.sqlite";
const OUT = process.argv[2];
if (!OUT) { console.error("Usage: node scripts/okf-export.mjs <out-dir>"); process.exit(1); }

const db = openDatabase(DB);
initializeDatabase(db);
const src = new SqliteConceptSource(db);

mkdirSync(OUT, { recursive: true });

// YAML scalars must be quoted: titles and descriptions come from arbitrary
// memory text, and a bare `:` or leading `[` makes the block unparseable.
// OKF §11.1 requires every concept's frontmatter to parse.
const y = (s) => JSON.stringify(String(s ?? ""));

// Root index — the only index.md allowed to carry frontmatter (OKF §12).
const groups = src.listGroups();
writeFileSync(join(OUT, "index.md"), `---\nokf_version: "0.2"\n---\n\n` + renderGroups(groups), "utf-8");
console.log("index.md");

// Per-group: directory + index.md + concept files
for (const g of groups) {
  const dir = join(OUT, g.path);
  mkdirSync(dir, { recursive: true });
  const { refs, total } = src.listConcepts(g.path, { limit: 1000 });
  writeFileSync(join(dir, "index.md"), renderRefs(refs) + `\n\n(${refs.length} of ${total})`, "utf-8");
  console.log(`${g.path}/index.md (${refs.length} concepts)`);

  for (const ref of refs) {
    const c = src.getConcept(ref.id);
    if (!c) continue;
    const fm = [
      "---",
      `type: ${y(c.type)}`,
      `title: ${y(c.title)}`,
      `description: ${y(c.description)}`,
      c.tags.length ? `tags: [${c.tags.map(y).join(", ")}]` : null,
      // v0.2 renamed v0.1's bare `timestamp` to `generated: { by, at }` (§13.1).
      c.timestamp ? `generated: { by: ${y(c.generatedBy)}, at: ${y(c.timestamp)} }` : null,
      // §5.4: absent means stable, so only draft is ever emitted.
      c.status ? `status: ${y(c.status)}` : null,
      c.links.length ? `links:` : null,
      ...c.links.map(l => `  - ${y(l)}`),
      "---",
    ].filter(Boolean).join("\n");
    const slug = ref.id.replace(/\//g, "_").replace(/[^a-zA-Z0-9_-]/g, "-");
    writeFileSync(join(dir, `${slug}.md`), fm + "\n\n" + c.body + "\n", "utf-8");
  }
}

db.close();
console.log(`\nDone. Bundle at ${OUT}/`);
