/**
 * Opt-in absolute relevance gate for FTS recall (`minRelevance`).
 * Off by default: default recall output must not change.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase } from "../src/db.js";
import { initializeDatabase } from "../src/store/db-init.js";
import { memoryRecall } from "../src/memory/index.js";
import { informativeTerms, lexicalRelevance } from "../src/memory/relevance.js";
import { okfRecall } from "../src/okf/recall.js";

const FIXTURES: Array<[string, string, string]> = [
  ["borg0001", "homelab", "Borg backup prune removed the one-off archive because keep-daily keeps only the newest archive per day."],
  ["sonarr01", "homelab", "Sonarr reported the SABnzbd download client unavailable after repeated version check failures."],
  ["caddy001", "homelab", "Caddy reverse proxy runs the crowdsec bouncer with appsec_fail_open as a bare flag."],
  ["chat0001", "lotl", "We will send the report and continue the work next week, it looks good and the tests pass."],
  ["chat0002", "lotl", "Ready to commit once the build is fixed; run the tests again after the change."],
  ["weath001", "global", "Weather notes for the garden: rain is expected so the plants need no water."],
  ["lotl0001", "lotl", "The global lotl CLI is a packed tarball install, not an npm link, since the repo move."],
  ["lotl0002", "lotl", "lotl hooks live in the config dir and the recall hook runs on every prompt submit."],
];

describe("relevance gate (minRelevance)", () => {
  let db: ReturnType<typeof openDatabase>;
  let tmp: string;
  const prevTouch = process.env.LOTL_RECALL_NO_TOUCH;

  beforeAll(() => { process.env.LOTL_RECALL_NO_TOUCH = "on"; });
  afterAll(() => {
    if (prevTouch === undefined) delete process.env.LOTL_RECALL_NO_TOUCH;
    else process.env.LOTL_RECALL_NO_TOUCH = prevTouch;
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lotl-relevance-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
    const now = Date.now();
    const ins = db.prepare(`INSERT INTO memories (id,text,content_hash,category,scope,importance,tier,access_count,created_at,last_accessed)
      VALUES (?,?,?,'fact',?,0.5,'peripheral',0,?,?)`);
    for (const [id, scope, text] of FIXTURES) ins.run(id, text, id, scope, now, now);
  });
  afterEach(() => { try { db.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); });

  test("gate off: results identical to a call without the option", async () => {
    for (const query of ["borg backup archive", "send it", "what's the weather like in tokyo next week", "lotl install"]) {
      const plain = await memoryRecall(db, { query });
      const explicitOff = await memoryRecall(db, { query, minRelevance: undefined });
      // Scores carry a wall-clock recency term, so compare them loosely.
      const strip = (rs: typeof plain) => rs.map(({ score, ...rest }) => ({ ...rest, score: Number(score.toFixed(9)) }));
      expect(strip(explicitOff)).toEqual(strip(plain));
    }
  });

  test("gate off still returns keyword noise for an off-topic prompt (the problem being fixed)", async () => {
    const plain = await memoryRecall(db, { query: "what's the weather like in tokyo next week" });
    expect(plain.length).toBeGreaterThan(0);
  });

  test("gate on: off-topic prompt returns nothing", async () => {
    expect(await memoryRecall(db, { query: "what's the weather like in tokyo next week", minRelevance: 0.6 })).toEqual([]);
    expect(await memoryRecall(db, { query: "give me a recipe for banana bread", minRelevance: 0.6 })).toEqual([]);
  });

  test("gate on: short conversational prompts return nothing without error", async () => {
    for (const query of ["send it", "continue", "yes do that", "ok looks good, next", "why did that fail?", "run the tests again"]) {
      expect(await memoryRecall(db, { query, minRelevance: 0.6 })).toEqual([]);
    }
  });

  test("gate on: on-topic prompt still returns the expected memory first", async () => {
    const res = await memoryRecall(db, { query: "why did the borg backup prune the one-off archive", minRelevance: 0.6 });
    expect(res.map(r => r.id)).toEqual(["borg0001"]);
    const lotl = await memoryRecall(db, { query: "how is the global lotl cli installed", minRelevance: 0.6 });
    expect(lotl[0]?.id).toBe("lotl0001");
    expect(lotl.map(r => r.id)).not.toContain("chat0001");
  });

  test("gate on keeps the order of the ungated ranking", async () => {
    const plain = (await memoryRecall(db, { query: "lotl hooks recall prompt" })).map(r => r.id);
    const gated = (await memoryRecall(db, { query: "lotl hooks recall prompt", minRelevance: 0.1 })).map(r => r.id);
    expect(gated.length).toBeGreaterThan(0);
    expect(gated).toEqual(plain.filter(id => gated.includes(id)));
  });

  test("higher threshold never returns more rows", async () => {
    const q = "lotl global install hooks tarball";
    const lo = await memoryRecall(db, { query: q, minRelevance: 0.2 });
    const hi = await memoryRecall(db, { query: q, minRelevance: 0.9 });
    expect(hi.length).toBeLessThanOrEqual(lo.length);
  });

  test.each([0, -0.5, 1.5, Number.NaN])("rejects invalid minRelevance %s", async (bad) => {
    await expect(memoryRecall(db, { query: "borg backup", minRelevance: bad })).rejects.toThrow(/minRelevance/);
  });

  test("informativeTerms drops stopwords, generic chat words and splits hyphens", () => {
    expect(informativeTerms("send it")).toEqual([]);
    expect(informativeTerms("ok looks good, next")).toEqual([]);
    expect(informativeTerms("frida-server trips anti-tamper")).toEqual(["frida", "server", "trips", "anti", "tamper"]);
  });

  test("lexicalRelevance reports idf-weighted coverage per memory", () => {
    const rel = lexicalRelevance(db, informativeTerms("borg backup prune archive"), ["borg0001", "chat0001"]);
    expect(rel.get("borg0001")!.coverage).toBeCloseTo(1, 5);
    expect(rel.get("borg0001")!.matched).toBe(4);
    expect(rel.get("chat0001")?.matched ?? 0).toBe(0);
  });

  test("tiny index: a two-term prompt still finds its memory when one term is common there", async () => {
    // N=5 is below MEMORY_RELEVANCE_MIN_CORPUS, so the specificity floor is off. Without that
    // guard idf(1)+idf(2) at N=5 (2.26) would miss ln(5)+1 (2.61) and this would return [].
    const t5 = mkdtempSync(join(tmpdir(), "lotl-relevance-tiny-"));
    const small = openDatabase(join(t5, "t.sqlite"));
    try {
      initializeDatabase(small);
      const now = Date.now();
      const ins = small.prepare(`INSERT INTO memories (id,text,content_hash,category,scope,importance,tier,access_count,created_at,last_accessed)
        VALUES (?,?,?,'fact','global',0.5,'peripheral',0,?,?)`);
      const texts = [
        ["tiny0001", "Grafana dashboard for the solar inverter shows daily yield in kilowatt hours."],
        ["tiny0002", "Inverter firmware notes: the vendor portal lists the serial number under device settings."],
        ["tiny0003", "Bread recipe uses rye flour and a long cold proof overnight."],
        ["tiny0004", "Bike chain needs wax every three hundred kilometres."],
        ["tiny0005", "Router admin password rotated and stored in the vault."],
      ];
      for (const [id, text] of texts) ins.run(id, text, id, now, now);
      const res = await memoryRecall(small, { query: "inverter yield", minRelevance: 0.6 });
      expect(res.map(r => r.id)).toEqual(["tiny0001"]);
    } finally {
      small.close();
      rmSync(t5, { recursive: true, force: true });
    }
  });

  test("okfRecall passes the gate through", async () => {
    const store = { db, searchFTS: () => [] };
    expect(await okfRecall(store, "send it", { minRelevance: 0.6 })).toEqual([]);
    expect(await okfRecall(store, "what's the weather like in tokyo next week", { minRelevance: 0.6 })).toEqual([]);
    const refs = await okfRecall(store, "why did the borg backup prune the one-off archive", { minRelevance: 0.6 });
    expect(refs.map(r => r.id)).toEqual(["memory/homelab/borg0001"]);
    expect((await okfRecall(store, "send it")).length).toBeGreaterThan(0);
  });
});

/**
 * Specificity floor (2026-11-11): on a corpus of >= MEMORY_RELEVANCE_MIN_CORPUS memories, a short
 * prompt made of terms that are common there ("claude rebooted") must not inject memories that
 * contain both words by chance. Coverage alone cannot catch this: with two informative terms
 * every memory holding both scores 1.0.
 */
describe("relevance gate specificity floor (large corpus)", () => {
  let db: ReturnType<typeof openDatabase>;
  let tmp: string;
  const prevTouch = process.env.LOTL_RECALL_NO_TOUCH;
  const FILLER = "the team logged widget gadget sprocket lever valve crank piston gasket flange bracket hinge";

  beforeAll(() => { process.env.LOTL_RECALL_NO_TOUCH = "on"; });
  afterAll(() => {
    if (prevTouch === undefined) delete process.env.LOTL_RECALL_NO_TOUCH;
    else process.env.LOTL_RECALL_NO_TOUCH = prevTouch;
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lotl-relevance-large-"));
    db = openDatabase(join(tmp, "t.sqlite"));
    initializeDatabase(db);
    const now = Date.now();
    const ins = db.prepare(`INSERT INTO memories (id,text,content_hash,category,scope,importance,tier,access_count,created_at,last_accessed)
      VALUES (?,?,?,'fact','global',0.5,'peripheral',0,?,?)`);
    const rows: Array<[string, string]> = [];
    // 150 memories; "claude" in 20 of them (13%), "reboot*" in 6, "restart*" in 4.
    for (let i = 0; i < 150; i++) {
      const id = `m${String(i).padStart(4, "0")}`;
      let text = `Note ${i} about topic${i} and part${i % 13}: ${FILLER}.`;
      if (i % 7 === 0 && i < 140) text = `Claude worked on topic${i}. ${FILLER}. ${text}`;
      if (i === 7 || i === 14 || i === 21) text += ` Later ${FILLER} the box reboots overnight.`;
      if (i === 1 || i === 2 || i === 3) text += " The kiosk rebooted twice.";
      if (i === 28 || i === 35) text += ` ${FILLER}, then the daemon restarted cleanly.`;
      if (i === 4) text += " The proxy restarted after the config push.";
      rows.push([id, text]);
    }
    rows.push(["mcpnote1", "MCP server restart: killing the node process does not reconnect the client. Reliable way: restart Claude Code completely."]);
    rows.push(["sonarr01", "Sonarr reported the SABnzbd download client unavailable after repeated version check failures."]);
    for (const [id, text] of rows) ins.run(id, text, id, now, now);
  });
  afterEach(() => { try { db.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); });

  test("common-term short prompt injects nothing", async () => {
    // The ungated recall does return the chance co-occurrences (the leak being fixed).
    const plain = (await memoryRecall(db, { query: "claude code rebooted" })).map(r => r.id);
    expect(plain).toEqual(expect.arrayContaining(["m0007", "m0014", "m0021"]));
    expect(await memoryRecall(db, { query: "claude code rebooted", minRelevance: 0.6 })).toEqual([]);
  });

  test("a unique adjacent phrase still answers a short prompt", async () => {
    // "restart" + "claude" co-occur in three memories, but sit side by side only in mcpnote1.
    const res = await memoryRecall(db, { query: "claude restarted", minRelevance: 0.6 });
    expect(res.map(r => r.id)).toEqual(["mcpnote1"]);
  });

  test("short prompt of rare specific terms still finds its memory", async () => {
    const res = await memoryRecall(db, { query: "sonarr sabnzbd", minRelevance: 0.6 });
    expect(res.map(r => r.id)).toEqual(["sonarr01"]);
  });

  test("gate off: output identical to a call without the option", async () => {
    for (const query of ["claude code rebooted", "claude restarted", "sonarr sabnzbd"]) {
      const plain = await memoryRecall(db, { query });
      const explicitOff = await memoryRecall(db, { query, minRelevance: undefined });
      const strip = (rs: typeof plain) => rs.map(({ score, ...rest }) => ({ ...rest, score: Number(score.toFixed(9)) }));
      expect(strip(explicitOff)).toEqual(strip(plain));
      expect(plain.length).toBeGreaterThan(0);
    }
  });

  test("lexicalRelevance reports the idf mass of the matched terms", () => {
    const rel = lexicalRelevance(db, ["sonarr", "sabnzbd"], ["sonarr01"]);
    const n = 152;
    const idf1 = Math.log(1 + (n - 1 + 0.5) / 1.5);
    expect(rel.get("sonarr01")!.mass).toBeCloseTo(2 * idf1, 6);
  });
});
