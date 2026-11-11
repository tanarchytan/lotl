/**
 * No-LLM extraction (extractHeuristic). Notes-style input (session
 * summaries from the save hook) gets the notes heuristic: subject-prefixed
 * memories built only from the notes' own sentences. Speaker-turn
 * transcripts keep the original sentence heuristic. All text here is
 * invented (project "quarry", made-up paths and versions).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

const fake = vi.hoisted(() => ({
  remote: null as null | { chatComplete: (p: string) => Promise<string | null> },
  prompts: [] as string[],
  reply: (_p: string): string | null => "",
}));

vi.mock("../src/remote-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/remote-config.js")>();
  return { ...actual, getRemoteLLM: () => fake.remote };
});

const { extractAndStore, extractHeuristic } = await import("../src/memory/extractor.js");
const { EXTRACT_HEUR_MAX_MEMORIES, EXTRACT_HEUR_MEMORY_CHARS } = await import("../src/store/constants.js");

async function extract(text: string): Promise<string[]> {
  const res = await extractAndStore({} as any, text, "t", async () => ({ id: "x", status: "created" as const }));
  return res.extracted.map(m => m.text);
}

/** Every word of the memory occurs in the source: nothing invented. */
function wordsIn(mem: string, src: string): boolean {
  const have = new Set(src.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  return (mem.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).every(w => have.has(w));
}

const SUMMARY = `Session summary, quarry, 2031-04-02.

Moved the tile cache from /var/quarry/tiles to /srv/quarry-cache because the old disk filled up at 92%. Decision: the cache limit is QUARRY_CACHE_MB = 4096 and eviction is LRU, not FIFO.

The importer now reads GeoPackage files through libgpkg 3.8.1. It still fails on files above 2 GB; that is a known limit and not fixed yet.

Agreed three follow-ups:
1. Add a checksum column to the tiles table.
2. Drop the legacy /api/v1/render endpoint after 2031-06-01.
3. Keep the nightly rebuild at 03:00.

Mira prefers that cache paths never live under /tmp, because the host wipes /tmp on reboot.

Thanks for the help today, that was a productive session.`;

describe("notes heuristic: whole summary", () => {
  beforeEach(() => { fake.remote = null; });

  test("keeps the facts, names the subject, invents nothing", async () => {
    const mems = await extract(SUMMARY);
    expect(mems.length).toBeGreaterThanOrEqual(3);
    expect(mems.length).toBeLessThanOrEqual(EXTRACT_HEUR_MAX_MEMORIES);
    for (const m of mems) {
      expect(m.toLowerCase()).toContain("quarry");
      expect(wordsIn(m, SUMMARY)).toBe(true);
    }
    const has = (...res: RegExp[]) => mems.some(m => res.every(re => re.test(m)));
    expect(has(/QUARRY_CACHE_MB = 4096/, /LRU/)).toBe(true);
    expect(has(/libgpkg 3\.8\.1/)).toBe(true);
    expect(has(/2 GB/, /known limit/)).toBe(true);
    expect(has(/Mira prefers/, /\/tmp/)).toBe(true);
  });

  test("list items stay with their lead-in line", async () => {
    const mems = await extract(SUMMARY);
    const list = mems.find(m => m.includes("checksum column"));
    expect(list).toBeDefined();
    expect(list).toContain("Agreed three follow-ups");
    expect(list).toContain("/api/v1/render");
  });

  test("the title line, thanks and other remarks about the session are not stored", async () => {
    const mems = await extract(SUMMARY);
    expect(mems.some(m => /productive session|thanks/i.test(m))).toBe(false);
    expect(mems.some(m => /^quarry: Session summary/i.test(m))).toBe(false);
  });

  test("no memory is longer than the cap plus its subject prefix", async () => {
    const long = `quarry notes, 2031-04-03.\n\n${Array.from({ length: 12 }, (_, i) => `Shard ${i} moved to node-${i}.quarry.lan with 3${i} GB free.`).join(" ")}`;
    for (const m of await extract(long)) {
      expect(m.length).toBeLessThanOrEqual(EXTRACT_HEUR_MEMORY_CHARS + "quarry: ".length);
    }
  });

  test("count is capped on a long summary", async () => {
    const paras = Array.from({ length: 40 }, (_, i) => `Worker ${i} runs build ${i}.0.${i} on port 80${i}.`).join("\n\n");
    const mems = await extract(`quarry session, 2031-04-04.\n\n${paras}`);
    expect(mems.length).toBeGreaterThan(0);
    expect(mems.length).toBeLessThanOrEqual(EXTRACT_HEUR_MAX_MEMORIES);
  });

  test("a table row is kept with its header row; code fences are dropped", async () => {
    const text = [
      "quarry notes, 2031-04-09.",
      "",
      "| Zoom | Tiles | Build time |",
      "|---|---|---|",
      "| 12 | 4096 | 41 s |",
      "",
      "```",
      "quarry rebuild --zoom 12",
      "```",
    ].join("\n");
    const mems = await extract(text);
    expect(mems.some(m => m.includes("| Zoom | Tiles | Build time | | 12 | 4096 | 41 s |"))).toBe(true);
    expect(mems.some(m => m.includes("```"))).toBe(false);
    expect(mems.some(m => m.includes("quarry rebuild --zoom 12"))).toBe(true);
  });

  test("a trivial note stores nothing", async () => {
    const mems = await extract("Re-ran the quarry linter after the merge and looked around a bit. Lunch now.");
    expect(mems).toEqual([]);
  });
});

describe("notes heuristic: subjects", () => {
  beforeEach(() => { fake.remote = null; });

  test("heading sections add their topic when the memory lacks it", async () => {
    const text = `# quarry, 2031-04-05\n\n## Tile cache\nEviction is LRU with a 4096 MB limit.\n\n## Importer\nThe importer reads GeoPackage through libgpkg 3.8.1.`;
    const mems = await extract(text);
    expect(mems).toContain("quarry, Tile cache: Eviction is LRU with a 4096 MB limit.");
    expect(mems).toContain("quarry: The importer reads GeoPackage through libgpkg 3.8.1.");
  });

  test("a PROJECT: first line names the subject", async () => {
    const mems = await extract("PROJECT: quarry\nThe render queue now holds at most 250 jobs.");
    expect(mems).toEqual(["quarry: The render queue now holds at most 250 jobs."]);
  });

  test("a memory that already names the project gets no prefix", async () => {
    const mems = await extract("quarry notes, 2031-04-06. The quarry importer skips files above 2 GB.");
    expect(mems).toEqual(["The quarry importer skips files above 2 GB."]);
  });

  test("a first sentence that states a fact is not taken for a title", async () => {
    const dated = await extract("On 2031-04-02 we moved the quarry tile cache to /srv/quarry-cache.");
    expect(dated).toEqual(["On 2031-04-02 we moved the quarry tile cache to /srv/quarry-cache."]);
    const worded = await extract("The session cache of quarry now expires after 10 minutes.");
    expect(worded).toEqual(["The session cache of quarry now expires after 10 minutes."]);
  });

  test("without a title the most named entity is the subject", async () => {
    const text = "Quick note. Mira wants weekly reports in CSV, not XLSX. Reports go to /srv/reports/weekly. Mira reviews them on Monday at 09:00.";
    const mems = await extract(text);
    expect(mems.length).toBeGreaterThan(0);
    for (const m of mems) expect(m).toMatch(/Mira/);
  });

  test("Dutch notes: besluit and open punt are kept, in Dutch", async () => {
    const text = `quarry sessie 2031-04-07. De tegelcache staat nu op /srv/quarry-cache (limiet 4096 MB).\n\nBesluit: oude tegels worden nooit automatisch verwijderd.\n\nOpen punt: de import van bestanden boven 2 GB werkt nog niet.`;
    const mems = await extract(text);
    expect(mems.some(m => /Besluit: oude tegels worden nooit/.test(m))).toBe(true);
    expect(mems.some(m => /Open punt: de import/.test(m))).toBe(true);
    for (const m of mems) expect(m.toLowerCase()).toContain("quarry");
  });
});

describe("heuristic routing", () => {
  test("speaker-turn transcripts keep the original sentence heuristic", () => {
    const transcript = [
      "Alex: We decided to use PostgreSQL for the quarry project.",
      "Sam: Sounds good, we're going with it then.",
      "Alex: Great, I'll set up the schema on Monday.",
    ].join("\n");
    expect(extractHeuristic(transcript).map(m => m.text)).toEqual([
      "Alex: We decided to use PostgreSQL for the quarry project.",
      "Sam: Sounds good, we're going with it then.",
    ]);
  });

  test("a single part with an explicit subject (LLM part fallback) gets that subject", () => {
    const mems = extractHeuristic("The render queue now holds at most 250 jobs.", "notes", "quarry");
    expect(mems.map(m => m.text)).toEqual(["quarry: The render queue now holds at most 250 jobs."]);
  });
});

describe("LLM notes mode: a failed part falls back with the notes' subject", () => {
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = { chunk: process.env.LOTL_EXTRACT_CHUNK_CHARS, style: process.env.LOTL_EXTRACT_PROMPT };
    process.env.LOTL_EXTRACT_PROMPT = "auto";
    process.env.LOTL_EXTRACT_CHUNK_CHARS = "300";
    fake.prompts = [];
    fake.remote = { chatComplete: async (p: string) => { fake.prompts.push(p); return fake.reply(p); } };
  });
  afterEach(() => {
    fake.remote = null;
    if (saved.chunk === undefined) delete process.env.LOTL_EXTRACT_CHUNK_CHARS; else process.env.LOTL_EXTRACT_CHUNK_CHARS = saved.chunk;
    if (saved.style === undefined) delete process.env.LOTL_EXTRACT_PROMPT; else process.env.LOTL_EXTRACT_PROMPT = saved.style;
  });

  test("the fallback memory carries the title's subject", async () => {
    fake.reply = (p) => (p.includes("render queue") ? null : "PROJECT: quarry\n[fact] quarry part answered by the model.");
    const text = [
      `quarry session, 2031-04-08. ${"detail ".repeat(30)}`.trim(),
      "The render queue now holds at most 250 jobs, set in config/queue.toml.",
    ].join("\n\n");
    const mems = await extract(text);
    expect(fake.prompts.length).toBe(2);
    expect(mems).toContain("quarry: The render queue now holds at most 250 jobs, set in config/queue.toml.");
  });
});
