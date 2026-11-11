/**
 * Notes-style LLM extraction (session summaries from the save hook) vs the
 * unchanged conversation prompt (LoCoMo / LME transcripts). LLM is mocked.
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

const {
  detectExtractStyle, resolveExtractStyle, splitNotes, parseExtraction, extractAndStore, NOTES_EXTRACTION_PROMPT,
} = await import("../src/memory/extractor.js");
const { EXTRACT_MAX_PARTS } = await import("../src/store/constants.js");

type Stored = { text: string; category: string };
async function run(text: string): Promise<{ stored: Stored[]; extracted: Stored[] }> {
  const stored: Stored[] = [];
  const res = await extractAndStore({} as any, text, "t", async (_db, o: any) => {
    stored.push({ text: o.text, category: o.category });
    return { id: String(stored.length), status: "created" as const };
  });
  return { stored, extracted: res.extracted.map(m => ({ text: m.text, category: m.category })) };
}

const NOTES = `Homelab session 2026-11-02. Upgraded Zitadel on VPS01 to v4.21.1.
Decision: keep the cookie secret in /opt/stacks/identity-stack/secrets.
Not done: compacting the vhdx.`;

const LOCOMO = `[1:56 pm on 8 May, 2023]
Caroline: I went to a LGBTQ support group yesterday.
Melanie: That sounds great, how was it?
Caroline: It was really powerful.`;

describe("detectExtractStyle", () => {
  test("speaker-turn transcripts are conversation", () => {
    expect(detectExtractStyle(LOCOMO)).toBe("conversation");
    expect(detectExtractStyle("user: I moved to Ghent\nassistant: Nice!\nuser: and I adopted a cat")).toBe("conversation");
  });
  test("prose notes with label lines are notes", () => {
    expect(detectExtractStyle(NOTES)).toBe("notes");
    expect(detectExtractStyle("Done: pruned 38 GB.\nNot done: vhdx.")).toBe("notes");
    expect(detectExtractStyle("")).toBe("notes");
  });
  test("importConversation and OpenClaw chunks (\"<user>\\n\\nAssistant: ...\") are conversation", () => {
    expect(detectExtractStyle("I moved to Ghent last spring and adopted a cat.\n\nAssistant: Congratulations on the move!")).toBe("conversation");
    expect(detectExtractStyle("Can you fix the build?\n\nAssistant: Done, the tsconfig path was wrong.\n\nThanks")).toBe("conversation");
  });
});

describe("resolveExtractStyle (LOTL_EXTRACT_PROMPT)", () => {
  const saved = process.env.LOTL_EXTRACT_PROMPT;
  afterEach(() => {
    if (saved === undefined) delete process.env.LOTL_EXTRACT_PROMPT; else process.env.LOTL_EXTRACT_PROMPT = saved;
    vi.restoreAllMocks();
  });
  test("unset or empty: conversation for every input (behaviour before the notes prompt)", () => {
    delete process.env.LOTL_EXTRACT_PROMPT;
    expect(resolveExtractStyle(NOTES)).toBe("conversation");
    process.env.LOTL_EXTRACT_PROMPT = " ";
    expect(resolveExtractStyle(NOTES)).toBe("conversation");
  });
  test("notes and auto apply only when set; value is trimmed and case-insensitive", () => {
    process.env.LOTL_EXTRACT_PROMPT = " Notes ";
    expect(resolveExtractStyle(LOCOMO)).toBe("notes");
    process.env.LOTL_EXTRACT_PROMPT = "auto\n";
    expect(resolveExtractStyle(LOCOMO)).toBe("conversation");
    expect(resolveExtractStyle(NOTES)).toBe("notes");
    process.env.LOTL_EXTRACT_PROMPT = "conversation";
    expect(resolveExtractStyle(NOTES)).toBe("conversation");
  });
  test("unknown value warns once and uses conversation", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.LOTL_EXTRACT_PROMPT = "nots-typo";
    expect(resolveExtractStyle(NOTES)).toBe("conversation");
    expect(resolveExtractStyle(NOTES)).toBe("conversation");
    expect(err.mock.calls.map(c => String(c[0])).filter(x => x.includes("LOTL_EXTRACT_PROMPT"))).toHaveLength(1);
  });
});

describe("splitNotes", () => {
  test("short text is one part", () => {
    expect(splitNotes("abc", 2500)).toEqual(["abc"]);
    expect(splitNotes("x".repeat(5000), 0)).toHaveLength(1);
  });
  test("long text splits at blank lines / headings, nothing lost", () => {
    const para = (n: number) => `Paragraph ${n} ${"word ".repeat(80)}`.trim();
    const text = `lotl session summary 2026-11-06\n\n${para(1)}\n\n## Second\n${para(2)}\n\n${para(3)}`;
    const parts = splitNotes(text, 500);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toContain("lotl session summary");
    for (const n of [1, 2, 3]) expect(parts.some(p => p.includes(`Paragraph ${n}`))).toBe(true);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(500);
  });
  test("a single block longer than the limit is hard-split (sentences, then chars)", () => {
    const sentences = Array.from({ length: 200 }, (_, i) => `Sentence ${i} has some words in it.`).join(" ");
    const parts = splitNotes(sentences, 2500);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(2500);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(sentences);
    const blob = "x".repeat(10_000);
    const blobParts = splitNotes(blob, 2500);
    expect(blobParts).toHaveLength(4);
    expect(blobParts.join("")).toBe(blob);
  });
});

describe("parseExtraction (notes)", () => {
  test("PROJECT/TOPIC become a subject prefix only where the memory lacks it", () => {
    const r = parseExtraction([
      "PROJECT: lotl",
      "TOPIC: recall gate",
      "[decision] lotl recall hook passes --min-relevance 0.6.",
      "[fact] The gate ignores vector similarity.",
      "[fact] Recall gate: Dutch stopwords are removed.",
    ].join("\n"), "notes").map(m => m.text);
    expect(r).toEqual([
      "lotl recall hook passes --min-relevance 0.6.",
      "lotl, recall gate: The gate ignores vector similarity.",
      "lotl: Recall gate: Dutch stopwords are removed.",
    ]);
  });

  test("list lines continue the previous memory; inline second memory is split", () => {
    const r = parseExtraction([
      "PROJECT: planner",
      "[decision] planner: David said yes to three proposals:",
      "1. ShiftRule skips holiday days.",
      "2. MergeRule excludes weekend days.",
      "[fact] planner OTA served from robot-data. [open problem] barge-in does not work yet.",
    ].join("\n"), "notes");
    expect(r.map(m => m.text)).toEqual([
      "planner: David said yes to three proposals: ShiftRule skips holiday days. MergeRule excludes weekend days.",
      "planner OTA served from robot-data.",
      "planner: barge-in does not work yet.",
    ]);
    expect(r[2]!.category).toBe("fact");
  });

  test("invented categories become fact; reflections, meta lines and repeats are dropped", () => {
    const r = parseExtraction([
      "[lesson] whoop-rs: confirm restarts through Loki.",
      "[reflection] whoop-rs work shows a careful approach overall.",
      "[fact] The session took place on 2026-10-02.",
      "[lesson] whoop-rs: confirm restarts through Loki.",
      "[entity] whoop-rs|edited_by|agent",
    ].join("\n"), "notes");
    expect(r.map(m => [m.category, m.text])).toEqual([
      ["fact", "whoop-rs: confirm restarts through Loki."],
      ["entity", "whoop-rs edited by agent"],
    ]);
  });
});

describe("parseExtraction (conversation, v1 behaviour)", () => {
  test("one line per memory, unknown categories dropped, triples parsed, reflections kept", () => {
    const r = parseExtraction([
      "[entity] Caroline is a counselor ||| caroline|occupation|counselor",
      "[lesson] dropped in conversation mode",
      "[reflection] Caroline and Melanie both value community support",
      "continuation lines are ignored",
    ].join("\n"), "conversation");
    expect(r.map(m => m.category)).toEqual(["entity", "reflection"]);
    expect(r[0]!.text).toBe("Caroline is a counselor");
    expect(r[0]!.triple).toEqual({ subject: "caroline", predicate: "occupation", object: "counselor" });
  });
});

describe("extractAndStore routing", () => {
  let savedChunk: string | undefined;
  let savedStyle: string | undefined;
  beforeEach(() => {
    savedChunk = process.env.LOTL_EXTRACT_CHUNK_CHARS;
    savedStyle = process.env.LOTL_EXTRACT_PROMPT;
    process.env.LOTL_EXTRACT_PROMPT = "auto";
    fake.prompts = [];
    fake.remote = { chatComplete: async (p: string) => { fake.prompts.push(p); return fake.reply(p); } };
  });
  afterEach(() => {
    if (savedChunk === undefined) delete process.env.LOTL_EXTRACT_CHUNK_CHARS; else process.env.LOTL_EXTRACT_CHUNK_CHARS = savedChunk;
    if (savedStyle === undefined) delete process.env.LOTL_EXTRACT_PROMPT; else process.env.LOTL_EXTRACT_PROMPT = savedStyle;
  });

  test("default (unset): notes go to the conversation prompt, as before", async () => {
    delete process.env.LOTL_EXTRACT_PROMPT;
    fake.reply = () => "[fact] Zitadel on VPS01 was upgraded to v4.21.1";
    await run(NOTES);
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]!.startsWith("You are a Personal Information Organizer.")).toBe(true);
  });

  test("notes path: <private> spans never reach the prompt", async () => {
    fake.reply = () => "PROJECT: VPS01\n[fact] VPS01 runs Zitadel.";
    await run(`${NOTES}\nRoot password is <private>hunter2-secret</private> for now.`);
    expect(fake.prompts.join("\n")).not.toContain("hunter2-secret");
  });

  test("later parts carry the notes' first line as context", async () => {
    process.env.LOTL_EXTRACT_CHUNK_CHARS = "500";
    fake.reply = () => "NONE";
    const para = (n: number) => `Paragraph ${n} ${"word ".repeat(80)}`.trim();
    await run(`lotl session summary 2026-11-06\n\n${para(1)}\n\n${para(2)}\n\n${para(3)}`);
    expect(fake.prompts.length).toBeGreaterThan(1);
    for (const p of fake.prompts.slice(1)) expect(p).toContain("(continued, from notes: lotl session summary 2026-11-06)");
  });

  test("a part whose call fails goes to the heuristic; other parts keep their LLM memories", async () => {
    process.env.LOTL_EXTRACT_CHUNK_CHARS = "300";
    fake.reply = (p) => (p.includes("PostgreSQL") ? null : "PROJECT: lotl\n[fact] lotl part answered by the model.");
    const text = [
      `Intro ${"detail ".repeat(40)}`.trim(),
      "We decided to use PostgreSQL for the billing service because it supports row level security.",
      `Outro ${"detail ".repeat(40)}`.trim(),
    ].join("\n\n");
    const { extracted } = await run(text);
    expect(fake.prompts.length).toBe(3);
    expect(extracted.some(m => m.text.includes("PostgreSQL"))).toBe(true);
    expect(extracted.some(m => m.text.includes("answered by the model"))).toBe(true);
  });

  test("parts are capped at EXTRACT_MAX_PARTS; the rest goes to the heuristic", async () => {
    process.env.LOTL_EXTRACT_CHUNK_CHARS = "300";
    let n = 0;
    fake.reply = () => `PROJECT: lotl\n[fact] lotl fact number ${++n}.`;
    const parts = Array.from({ length: EXTRACT_MAX_PARTS + 4 }, (_, i) => `Part ${i} ${"detail ".repeat(40)}`.trim());
    parts.push("We decided to use PostgreSQL for the billing service because it supports row level security.");
    const { extracted } = await run(parts.join("\n\n"));
    expect(fake.prompts).toHaveLength(EXTRACT_MAX_PARTS);
    expect(extracted.some(m => m.text.includes("PostgreSQL"))).toBe(true);
  });

  test("notes go to the notes prompt and keep the subject", async () => {
    fake.reply = () => "PROJECT: Zitadel on VPS01\n[fact] Upgraded to v4.21.1.";
    const { extracted } = await run(NOTES);
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]!.startsWith(NOTES_EXTRACTION_PROMPT)).toBe(true);
    expect(extracted).toEqual([{ text: "Zitadel on VPS01: Upgraded to v4.21.1.", category: "fact" }]);
  });

  test("transcripts go to the unchanged conversation prompt", async () => {
    fake.reply = () => "[fact] Caroline went to a support group";
    await run(LOCOMO);
    expect(fake.prompts[0]!.startsWith("You are a Personal Information Organizer.")).toBe(true);
  });

  test("an explicit NONE stores nothing and skips the heuristic fallback", async () => {
    fake.reply = () => "NONE";
    const { stored } = await run("We decided to use PostgreSQL for the new project. Took a break.");
    expect(stored.filter(s => s.category !== "preference")).toEqual([]);
  });

  test("an unparseable reply still falls back to the heuristic", async () => {
    fake.reply = () => "Sure! Here are the memories you asked for.";
    const { extracted } = await run("We decided to use PostgreSQL for the new project.");
    expect(extracted.length).toBeGreaterThan(0);
  });

  test("long notes are extracted in parts", async () => {
    process.env.LOTL_EXTRACT_CHUNK_CHARS = "300";
    let n = 0;
    fake.reply = () => `PROJECT: lotl\n[fact] lotl fact number ${++n}.`;
    const text = Array.from({ length: 4 }, (_, i) => `Part ${i} ${"detail ".repeat(40)}`).join("\n\n");
    const { extracted } = await run(text);
    expect(fake.prompts.length).toBeGreaterThan(1);
    expect(extracted).toHaveLength(fake.prompts.length);
  });

  test("no LLM: heuristic path unchanged", async () => {
    fake.remote = null;
    const { extracted } = await run("We decided to use PostgreSQL for the new project.");
    expect(fake.prompts).toHaveLength(0);
    expect(extracted.length).toBeGreaterThan(0);
  });
});
