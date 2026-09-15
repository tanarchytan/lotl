/**
 * OKF v0.2 trust + lifecycle fields (§5.2-5.4). The actor recorded on write
 * becomes `generated.by`; a low-confidence compaction becomes `status: draft`.
 * See src/okf/concept.ts, src/okf/source.ts, memoryStore in src/memory/index.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { memoryStore, memoryStoreBatch } from "../src/memory/index.js";
import { SqliteConceptSource } from "../src/okf/source.js";
import { DEFAULT_ACTOR, buildMemoryId } from "../src/okf/concept.js";

describe("okf trust + lifecycle", () => {
  let db: any, tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lotl-trust-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
  });
  afterEach(() => {
    try { db.close(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  const conceptFor = (id: string) => {
    const row = db.prepare(`SELECT id, scope FROM memories WHERE id = ?`).get(id) as any;
    return new SqliteConceptSource(db).getConcept(buildMemoryId(row.scope, row.id));
  };

  test("actor defaults to the lotl process when the caller names none", async () => {
    const res = await memoryStore(db, { text: "Postgres runs on port 5433 here.", scope: "global" });
    expect(conceptFor((res as any).id)!.generatedBy).toBe(DEFAULT_ACTOR);
  });

  test("a human actor round-trips to generated.by", async () => {
    const res = await memoryStore(db, { text: "Deploys go out on Tuesdays.", scope: "global", actor: "human:cli" });
    expect(conceptFor((res as any).id)!.generatedBy).toBe("human:cli");
  });

  test("an inferred memory is distinguishable from a typed one", async () => {
    const typed = await memoryStore(db, { text: "Billing contact is Sam.", scope: "global", actor: "human:cli" });
    const inferred = await memoryStore(db, { text: "Billing contact might be Alex.", scope: "global", actor: "process:lotl/extractor" });
    expect(conceptFor((typed as any).id)!.generatedBy.startsWith("human:")).toBe(true);
    expect(conceptFor((inferred as any).id)!.generatedBy.startsWith("human:")).toBe(false);
  });

  test("memoryStoreBatch records the actor too", async () => {
    const res = await memoryStoreBatch(db, [{ text: "Batch item one.", scope: "global", actor: "human:import" }]);
    expect(conceptFor(res[0]!.id)!.generatedBy).toBe("human:import");
  });

  test("a within-budget memory is stable, so status is absent", async () => {
    const res = await memoryStore(db, { text: "Short and safe.", scope: "global" });
    expect(conceptFor((res as any).id)!.status).toBeUndefined();
  });

  test("heuristic (low-confidence) compaction marks the concept draft in body and index line", async () => {
    // No chat fn is wired on the write path, so an over-budget memory takes the
    // heuristic route, which is low confidence by definition.
    const res = await memoryStore(db, { text: "Deploy runbook. " + "filler ".repeat(400), scope: "global" });
    const c = conceptFor((res as any).id)!;
    expect(c.status).toBe("draft");
    const { refs } = new SqliteConceptSource(db).listConcepts("memory/global");
    expect(refs.find(r => r.id === c.id)!.description.startsWith("[draft] ")).toBe(true);
  });
});
