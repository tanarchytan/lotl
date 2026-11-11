/**
 * memory export -> import round trip keeps metadata.
 *
 * Regression (2026-11-10 stress test): importMemories dropped the exported
 * metadata column, so a backup/restore lost metadata.original (the full text
 * of every OKF-compacted memory), verifications, draft status and the actor.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { memoryStore, memoryVerify } from "../src/memory/index.js";
import { exportMemories, importMemories } from "../src/memory/import.js";

describe("memory export/import round trip", () => {
  let tmpDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = { LOTL_ONNX: process.env.LOTL_ONNX, LOTL_EMBED_BACKEND: process.env.LOTL_EMBED_BACKEND, LOTL_OKF: process.env.LOTL_OKF };
    delete process.env.LOTL_ONNX;
    delete process.env.LOTL_EMBED_BACKEND;
    process.env.LOTL_OKF = "on";
    tmpDir = mkdtempSync(join(tmpdir(), "lotl-roundtrip-"));
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("keeps metadata.original, verification, draft status and actor", async () => {
    const src = openDatabase(join(tmpDir, "src.sqlite"));
    initializeDatabase(src);
    const long = "roundtrip head line\n" + Array.from({ length: 40 }, (_, i) => `detail ${i}: replica lag on db-${i}`).join("\n");
    const a = await memoryStore(src, { text: long, actor: "human:cli" });
    const b = await memoryStore(src, { text: "roundtrip verified short fact", actor: "agent:mcp" });
    memoryVerify(src, b.id, "human:cli");
    const file = join(tmpDir, "export.json");
    expect(exportMemories(src, file)).toBe(2);
    src.close();

    const dst = openDatabase(join(tmpDir, "dst.sqlite"));
    initializeDatabase(dst);
    const res = await importMemories(dst, file);
    expect(res).toEqual({ imported: 2, duplicates: 0, errors: 0 });

    const rows = dst.prepare("SELECT text, metadata FROM memories").all() as { text: string; metadata: string }[];
    const longRow = rows.find((r) => r.text.startsWith("roundtrip head line"))!;
    const shortRow = rows.find((r) => r.text === "roundtrip verified short fact")!;
    const longMeta = JSON.parse(longRow.metadata);
    const shortMeta = JSON.parse(shortRow.metadata);
    expect(longMeta.original).toBe(long);
    expect(longMeta.status).toBe("draft");
    expect(longMeta.actor).toBe("human:cli");
    expect(shortMeta.actor).toBe("agent:mcp");
    expect(shortMeta.verified?.[0]?.by).toBe("human:cli");
    expect(a.status).toBe("created");
    dst.close();
  });
});
