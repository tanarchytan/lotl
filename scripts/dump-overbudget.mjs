import { openDatabase } from "../dist/db.js";
import { initializeDatabase } from "../dist/store/db-init.js";

const DB = process.argv[2] || process.env.LOTL_DB || `${process.env.HOME}/.cache/lotl/index.sqlite`;
const db = openDatabase(DB);
initializeDatabase(db);

const rows = db.prepare(`
  SELECT id, text, category, scope, importance, tier, metadata
  FROM memories WHERE LENGTH(text) > 500
  ORDER BY LENGTH(text) DESC
`).all();

console.log(JSON.stringify(rows, null, 2));
db.close();
