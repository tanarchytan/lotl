/**
 * memory/extractor.ts — Extract memories from conversation text.
 *
 * Mem0-inspired dual extraction:
 * 1. LLM extracts atomic facts → stored in memory (FTS + vector)
 * 2. Entity-relationship facts → stored in knowledge graph (temporal triples)
 *
 * Falls back to heuristic patterns if LLM unavailable.
 * Always stores verbatim text (MemPalace finding: raw > summaries).
 */

import type { Database } from "../db.js";
import { classifyMemory, extractPreferences, hasMemorySignal, type PatternCategory } from "./patterns.js";
import { redactPrivate } from "./redact.js";
import {
  EXTRACT_CHUNK_CHARS, EXTRACT_MAX_PARTS, EXTRACT_SPEAKER_SHARE, EXTRACT_SPEAKER_LABEL_MAX,
  EXTRACT_TOPIC_MAX_CHARS, EXTRACT_CONTEXT_TITLE_MAX,
} from "../store/constants.js";

/** OKF §5.2 actor. Inferred from a transcript, not asserted by the user — the
 *  distinction recall needs when an extracted memory contradicts a typed one. */
const EXTRACTOR_ACTOR = "process:lotl/extractor";

// Note: memoryStore + knowledgeStore passed as parameters to break circular import
type StoreFn = (db: Database, opts: any) =>
  Promise<{ id: string; status: "created" | "duplicate"; duplicate_id?: string }>;
type KnowledgeStoreFn = (db: Database, opts: {
  subject: string; predicate: string; object: string;
  scope?: string; source_memory_id?: string;
}) => { id: string; invalidated: string[] };

export type ExtractedMemory = {
  text: string;
  category: PatternCategory;
  importance: number;
  // Mem0-style: optional entity triple extracted alongside
  triple?: { subject: string; predicate: string; object: string };
};

export type ExtractionResult = {
  extracted: ExtractedMemory[];
  stored: number;
  duplicates: number;
  preferences: string[];
  triples: number;
};

// =============================================================================
// Sentence splitting
// =============================================================================

function splitIntoChunks(text: string): string[] {
  const raw = text.split(/(?<=[.!?])\s+|\n{2,}/);
  return raw
    .map(s => s.trim())
    .filter(s => s.length >= 20);
}

// =============================================================================
// Importance heuristic
// =============================================================================

/**
 * Importance scale (quality fix #9):
 *   0.4   — synthetic preference bridge entries (low; auxiliary signal)
 *   0.5   — heuristic fallback / unknown category
 *   0.6   — reflections, preferences (medium-low; subjective)
 *   0.7   — facts, entities (default for raw extracted facts)
 *   0.75  — entity facts (slight bump for strong typing)  [used by knowledge.ts synthesis]
 *   0.8   — decisions (medium-high; explicit choices)
 *   0.85  — entity profile/timeline syntheses             [knowledge.ts:consolidateEntityFacts]
 *   +0.1  — long texts (>200 chars get bonus, capped at 1.0)
 *
 * Decay scoring uses importance × frequency × recency. Higher importance →
 * slower decay → memory survives in working/core tier longer.
 */
/**
 * Approximate entity density: ratio of capitalized tokens (proper-noun
 * proxy) to total alphanumeric tokens. Higher values suggest the text
 * names specific people / places / things and is more recall-worthy.
 * Cheap and zero-dependency — no NER runtime.
 */
function entityDensity(text: string): number {
  const tokens = text.match(/[A-Za-z][\w'-]+/g) || [];
  if (tokens.length === 0) return 0;
  // Skip sentence-initial caps by only counting non-first tokens
  // (catches "John" but not "The" at the start of a sentence).
  let proper = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^[A-Z][a-z]+/.test(t) && !STOP_CAPS.has(t.toLowerCase())) {
      // First-word penalty: only count if not immediately after . ! ? or at start
      if (i === 0) continue;
      proper++;
    }
  }
  return Math.min(1, proper / Math.max(1, tokens.length));
}

// Common sentence-initial words that tokenize as capitalized but aren't
// proper nouns. Keeps entityDensity from treating "The/That/This/…" as entities.
const STOP_CAPS = new Set([
  "the", "that", "this", "these", "those", "there", "then", "than",
  "what", "when", "where", "which", "who", "whom", "whose", "why", "how",
  "if", "unless", "although", "while", "since", "because",
  "yes", "no", "maybe", "okay", "ok",
]);

/**
 * Look for markers that the text is making a decision or commitment.
 * Decisions are long-lived signal and deserve a small importance bump
 * on top of the category score.
 */
const DECISION_PATTERNS = [
  /\b(?:decided|decide|chose|choose|picked|going to|will|plan(?:ned|ning)? to)\b/i,
  /\b(?:committed to|agreed to|settled on|opted for)\b/i,
];

function hasDecisionSignal(text: string): boolean {
  return DECISION_PATTERNS.some(re => re.test(text));
}

/**
 * 4-component importance estimator.
 *
 * Category (primary) + length (modest bump) stay as before. Added:
 *   - entityDensity bump: up to +0.10 when text is packed with proper nouns
 *   - decisionSignal bump: +0.05 when commitment language is present
 *
 * Bumps are capped so the function always returns values in [0, 1].
 * Approach inspired by Tinkerclaw Instant Recall's 4-component score
 * (entity_density + decision + engagement + recency) — we skip the
 * engagement signal because it duplicates the length component and
 * recency is handled by the decay engine, not at ingest time.
 */
function estimateImportance(text: string, category: PatternCategory): number {
  let importance = 0.5;

  if (category === "decision") importance = 0.8;
  else if (category === "fact") importance = 0.7;
  else if (category === "entity") importance = 0.7;
  else if (category === "preference") importance = 0.6;
  else if (category === "reflection") importance = 0.6;

  if (text.length > 200) importance += 0.1;

  const density = entityDensity(text);
  if (density >= 0.1) importance += Math.min(0.1, density * 0.5);

  if (hasDecisionSignal(text) && category !== "decision") {
    importance += 0.05;
  }

  return Math.max(0, Math.min(1, importance));
}

// =============================================================================
// Heuristic extraction (zero-LLM fallback)
// =============================================================================

function extractHeuristic(text: string): ExtractedMemory[] {
  const chunks = splitIntoChunks(text);
  const memories: ExtractedMemory[] = [];

  for (const chunk of chunks) {
    if (!hasMemorySignal(chunk)) continue;
    const category = classifyMemory(chunk);
    if (category === "other") continue;
    memories.push({
      text: chunk,
      category,
      importance: estimateImportance(chunk, category),
    });
  }

  return memories;
}

// =============================================================================
// LLM extraction — Mem0-style atomic facts + entity triples
// =============================================================================

// Mem0-inspired prompt: extract atomic facts + entity triples + reflections
// (cat 18 fix: combined reflection extraction into one LLM call to halve API cost)
const EXTRACTION_PROMPT = `You are a Personal Information Organizer. Extract distinct facts AND cross-event reflections from this conversation.

Rules:
- Extract from user/speaker messages
- Each fact must be self-contained (understandable without context)
- Include names, dates, places, preferences, relationships, plans
- For entity facts, also output a triple: subject|predicate|object
- Reflections must span MULTIPLE events — capture motivations, commonalities, patterns, cause/effect, emotional arcs

Output format (one per line):
[category] fact text
[entity] fact text ||| subject|predicate|object
[reflection] cross-event insight

Categories: preference, fact, decision, entity, reflection

Examples (generic):
[entity] User-A is a software engineer ||| user-a|occupation|software engineer
[preference] User-B prefers morning workouts
[fact] The meeting is scheduled for March 15th
[entity] User-C moved from country-X 4 years ago ||| user-c|moved_from|country-x
[decision] User-A and User-B decided to use PostgreSQL for the new project
[entity] User-D has 3 children ||| user-d|num_children|3
[fact] User-D's kids enjoy outdoor activities
[reflection] User-A and User-B both started their businesses after losing their jobs
[reflection] User-C's interest in counseling stems from support received during her own transition

Conversation:
`;

// Notes prompt: for agent-written session notes / summaries (what the Claude
// Code save hook makes the agent pass to memory_extract), as opposed to the
// speaker-turn transcripts EXTRACTION_PROMPT was built for (LoCoMo/LME).
// Tuned on Gemma 4 E2B (devnotes/metrics/local-llm-e2b-2026-11-11.md) but
// written as plain instructions so larger models follow it the same way.
export const NOTES_EXTRACTION_PROMPT = `Turn these notes into long-term memories. Each memory is read months later on its own, by someone who has not seen the notes.

First line: PROJECT: <name of the project, system or person the notes are about, 1-4 words; a name like "lotl" or "Zitadel on VPS01", not the kind of work like "handoff" or "session">
Before each group of memories about one part of it: TOPIC: <that part, 1-4 words>
Then one memory per line as: [category] memory text
category is one of: fact, decision, preference, entity

Rules:
1. Every memory names its subject (project, system or person), e.g. "lotl recall hook: ...", "Zitadel on VPS01: ...", "David prefers ...".
2. One memory per decision, fact, preference, finding, open problem or lesson. Keep a rule together with its values, versions, paths and reason in the same memory.
3. Copy names, numbers, versions, file paths, ids and commands exactly. Never add a detail that is not in the notes.
4. Keep negations and limits: "not", "never", "not done yet", "known limit".
5. Go through the notes paragraph by paragraph to the end. Caveats, open points and lessons at the end matter as much as the first paragraph.
6. Skip the session date on its own, greetings, routine status nothing will depend on later, and remarks about the notes or about working style.
7. Write in the language of the notes: Dutch notes give Dutch memories. Never translate terms.
8. If nothing is worth remembering, output only: NONE

Example notes:
Backup work, 2026-03-02. Moved nightly NAS backups to restic on B2, keeping 7 daily and 4 weekly. Restore of the photos share is not tested yet. Anna wants the alert mail in Dutch.
Example output:
PROJECT: NAS
TOPIC: backups
[decision] NAS nightly backups moved to restic on B2, keeping 7 daily and 4 weekly snapshots (2026-03-02).
[fact] NAS backups: restore of the photos share has not been tested yet.
[preference] Anna wants the NAS backup alert mail in Dutch.

Notes:
`;

export type ExtractPromptStyle = "conversation" | "notes";

const SPEAKER_LINE = new RegExp(`^([^\\s:[\\]#*-][^:\\n]{0,${EXTRACT_SPEAKER_LABEL_MAX - 1}}):\\s`);
// "Assistant:" at line start: the "<user text>\n\nAssistant: ..." chunks that
// importConversation and the OpenClaw auto-capture build carry only one such
// prefix, so the repeat rule below would miss them.
const ROLE_LINE = /^assistant\s*:/i;

/**
 * Speaker-turn transcript ("Caroline: ...", "user: ...") vs prose notes.
 * Transcript = an "Assistant: ..." line, or at least
 * EXTRACT_SPEAKER_SHARE of the content lines carry a speaker prefix and some
 * speaker label repeats. Note lines like "Decision: ..." rarely repeat.
 */
export function detectExtractStyle(text: string): ExtractPromptStyle {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l && !/^\[[^\]]*\]$/.test(l) && !/^-{3,}$/.test(l));
  if (lines.length === 0) return "notes";
  if (lines.some(l => ROLE_LINE.test(l))) return "conversation";
  const counts = new Map<string, number>();
  let prefixed = 0;
  for (const l of lines) {
    const m = l.match(SPEAKER_LINE);
    if (!m) continue;
    prefixed++;
    const label = m[1]!.toLowerCase();
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const repeats = [...counts.values()].some(n => n >= 2);
  return prefixed / lines.length >= EXTRACT_SPEAKER_SHARE && repeats ? "conversation" : "notes";
}

const warnedStyles = new Set<string>();

/**
 * LOTL_EXTRACT_PROMPT:
 *   conversation (default when unset) the original transcript prompt, for every input
 *   notes        the notes prompt, for every input
 *   auto         detectExtractStyle() per input
 * Unknown values warn once on stderr and use conversation.
 */
export function resolveExtractStyle(text: string): ExtractPromptStyle {
  const raw = process.env.LOTL_EXTRACT_PROMPT ?? "";
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "conversation") return "conversation";
  if (v === "notes") return "notes";
  if (v === "auto") return detectExtractStyle(text);
  if (!warnedStyles.has(v)) {
    warnedStyles.add(v);
    process.stderr.write(`lotl: unknown LOTL_EXTRACT_PROMPT="${raw.trim()}", using "conversation" (valid: conversation, notes, auto)\n`);
  }
  return "conversation";
}

/** Notes longer than this are extracted in parts (a small model drops
 *  paragraphs from long inputs). LOTL_EXTRACT_CHUNK_CHARS, 0 = never split. */
function extractChunkChars(): number {
  const raw = (process.env.LOTL_EXTRACT_CHUNK_CHARS ?? "").trim();
  const n = raw === "" ? EXTRACT_CHUNK_CHARS : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : EXTRACT_CHUNK_CHARS;
}

/** Cut one block longer than `max`: at sentence ends, else at `max` chars. */
function hardSplit(block: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const sentence of block.split(/(?<=[.!?])\s+/)) {
    for (let i = 0; i < sentence.length; i += max) {
      const piece = sentence.slice(i, i + max);
      if (cur && cur.length + piece.length + 1 > max) { out.push(cur); cur = ""; }
      cur = cur ? `${cur} ${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Split notes at headings / blank lines into parts of at most `max` chars.
 * A single block longer than `max` is cut at sentence ends, then hard at
 * `max` chars. Parts are raw text: extractWithLLM adds the context line.
 */
export function splitNotes(text: string, max: number): string[] {
  if (max <= 0 || text.length <= max) return [text];
  const blocks = text.split(/\n(?=#{1,6}\s)|\n{2,}/).map(b => b.trim()).filter(Boolean)
    .flatMap(b => (b.length > max ? hardSplit(b, max) : [b]));
  const parts: string[] = [];
  let cur = "";
  for (const b of blocks) {
    if (cur && cur.length + b.length + 2 > max) { parts.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${b}` : b;
  }
  if (cur) parts.push(cur);
  return parts;
}

// A memory that only states when/what the session was carries no fact.
const META_ONLY = /^(the )?(session|conversation|meeting|notes?|summary|session summary|chat)\b[^.]{0,60}\b(took place|was (held|recorded|on)|is (dated|from|scheduled)|date (is|was)|happened)\b/i;

const CATEGORIES = ["preference", "fact", "decision", "entity", "reflection"];

/** Clean a "TOPIC: x" value; null when empty or implausibly long. */
function cleanTopic(raw: string): string | null {
  const t = raw.replace(/[*"`<>]/g, "")
    .replace(/\b(session summary|session|summary|notes)\b/gi, "")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[\s,]+$|^[\s,]+/g, "").replace(/[.:]+$/, "").replace(/\s{2,}/g, " ").trim();
  return t.length >= 2 && t.length <= EXTRACT_TOPIC_MAX_CHARS ? t : null;
}

/**
 * True when the memory already names the topic: the whole topic, or its
 * head word (first word that is >= 3 chars or has a digit / inner capital),
 * so "Zitadel on VPS01" is satisfied by "Zitadel ...", "lotl memory recall"
 * by "lotl ...", but not by a memory that only says "recall hook".
 */
function mentionsTopic(text: string, topic: string): boolean {
  const t = text.toLowerCase();
  if (t.includes(topic.toLowerCase())) return true;
  const head = topic.split(/[\s/,()]+/)
    .map(w => w.replace(/[^\p{L}\p{N}._-]/gu, ""))
    .find(w => (w.length >= 3 || /\d|[A-Z]/.test(w.slice(1))) && !TOPIC_STOP.has(w.toLowerCase()));
  return head ? t.includes(head.toLowerCase()) : false;
}

/**
 * Prefix the subject a small model left out: "project, topic: text" when the
 * memory names neither, "project: text" when it names the topic only, and
 * nothing when it already names the project.
 */
function withSubject(text: string, project: string | null, topic: string | null): string {
  if (project && mentionsTopic(text, project)) return text;
  const needTopic = topic && !mentionsTopic(text, topic) && !(project && mentionsTopic(topic, project));
  const parts = [project, needTopic ? topic : null].filter(Boolean);
  if (!project && !needTopic) return text;
  return parts.length ? `${parts.join(", ")}: ${text}` : text;
}

const TOPIC_STOP = new Set(["session", "notes", "summary", "project", "system", "with", "from", "the", "and"]);

/**
 * "[category] text" records. Conversation style: one line each (unchanged
 * v1 parsing). Notes style: bullets / bold are stripped, and a line without
 * a category continues the previous memory (a small model writes a list
 * under one "[decision] ... three proposals:" line).
 */
type ExtractionRecord = { cat: string; text: string; project: string | null; topic: string | null };

function extractionRecords(response: string, style: ExtractPromptStyle): ExtractionRecord[] {
  const records: ExtractionRecord[] = [];
  let project: string | null = null;
  let topic: string | null = null;
  for (const rawLine of response.split("\n")) {
    if (style === "conversation") {
      const m = rawLine.match(/^\[(\w+)\]\s+(.+)/);
      if (m) records.push({ cat: m[1]!, text: m[2]!, project: null, topic: null });
      continue;
    }
    const line = rawLine.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").replace(/\*\*/g, "").trim();
    if (!line || /^NONE\.?$/i.test(line)) continue;
    const h = line.match(/^(PROJECT|TOPIC):\s*(.*)$/i);
    if (h) {
      if (h[1]!.toUpperCase() === "PROJECT") { project = cleanTopic(h[2]!); topic = null; }
      else topic = cleanTopic(h[2]!);
      continue;
    }
    // A small model sometimes puts two memories on one line:
    // "... served from X. [open problem] barge-in does not work yet".
    for (const seg of line.split(/\s+(?=\[[a-z][a-z ]{1,20}\]\s)/i)) {
      const m = seg.match(/^\[([a-z][a-z ]{1,20})\]\s+(.+)/i);
      if (m) records.push({ cat: m[1]!.replace(/\s+/g, "_"), text: m[2]!, project, topic });
      else if (records.length > 0) {
        const last = records[records.length - 1]!;
        last.text = `${last.text.replace(/:\s*$/, ":")} ${seg}`;
      }
    }
  }
  return records;
}

/** Parse "[category] text [||| s|p|o]" lines. Exported for tests. */
export function parseExtraction(response: string, style: ExtractPromptStyle): ExtractedMemory[] {
  const memories: ExtractedMemory[] = [];
  const seen = new Set<string>();
  for (const { cat: catRaw, text: textRaw, project, topic } of extractionRecords(response, style)) {
    let cat = catRaw.toLowerCase() as PatternCategory;
    // Notes style: a small model invents categories ("lesson", "finding",
    // "measured"); keep the memory as a fact rather than drop it.
    if (style === "notes" && !CATEGORIES.includes(cat)) cat = "fact";
    // Includes 'reflection' so the same prompt covers both fact extraction and reflection
    if (!CATEGORIES.includes(cat)) continue;
    // Notes prompt asks for no reflections; a small model adds them anyway
    // and they restate the notes.
    if (style === "notes" && cat === "reflection") continue;

    let memText = textRaw.trim();
    let triple: ExtractedMemory["triple"];

    // Parse optional triple: "fact text ||| subject|predicate|object"
    const tripleMatch = memText.match(/^(.+?)\s*\|\|\|\s*([^|]+)\|([^|]+)\|(.+)$/);
    if (tripleMatch) {
      memText = tripleMatch[1]!.trim();
      triple = {
        subject: tripleMatch[2]!.trim().toLowerCase(),
        predicate: tripleMatch[3]!.trim().toLowerCase(),
        object: tripleMatch[4]!.trim(),
      };
    } else if (style === "notes") {
      // Bare "subject|predicate|object" with no sentence: keep it readable.
      const bare = memText.match(/^([^|]+)\|([^|]+)\|([^|]+)$/);
      if (bare) memText = `${bare[1]!.trim()} ${bare[2]!.trim().replace(/_/g, " ")} ${bare[3]!.trim()}`;
    }

    if (memText.length < 10) continue;
    if (style === "notes") {
      if (META_ONLY.test(memText)) continue;
      memText = withSubject(memText, project, topic);
      const key = memText.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
    }
    memories.push({
      text: memText,
      category: cat,
      importance: estimateImportance(memText, cat),
      triple,
    });
  }
  return memories;
}

/**
 * LLM extraction. Returns null when there is no LLM, the call failed, or the
 * reply had no parseable line (caller falls back to the heuristic), and []
 * when a notes-style reply explicitly said NONE (nothing worth keeping).
 *
 * Notes style runs per part (splitNotes), at most EXTRACT_MAX_PARTS LLM
 * calls. A part whose call fails or gives no parseable line, and every part
 * beyond the cap, goes through the heuristic, so no part is silently lost.
 */
async function extractWithLLM(text: string): Promise<ExtractedMemory[] | null> {
  try {
    const { getRemoteLLM } = await import("../remote-config.js");
    const remote = getRemoteLLM();
    if (!remote) return null;

    const style = resolveExtractStyle(text);
    if (style === "conversation") {
      const response = await remote.chatComplete(EXTRACTION_PROMPT + text);
      const parsed = response ? parseExtraction(response, style) : [];
      return parsed.length > 0 ? parsed : null;
    }

    const parts = splitNotes(text, extractChunkChars());
    const title = (text.split("\n").find(l => l.trim()) ?? "").trim().slice(0, EXTRACT_CONTEXT_TITLE_MAX);
    const memories: ExtractedMemory[] = [];
    const seen = new Set<string>();
    const add = (ms: ExtractedMemory[]) => {
      for (const m of ms) {
        const key = m.text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        memories.push(m);
      }
    };
    const failed: string[] = [];
    let answered = false;
    for (const [i, part] of parts.entries()) {
      if (i >= EXTRACT_MAX_PARTS) { failed.push(part); continue; }
      const prompt = i === 0 ? part : `(continued, from notes: ${title})\n\n${part}`;
      let response: string | null = null;
      try { response = await remote.chatComplete(NOTES_EXTRACTION_PROMPT + prompt); } catch { response = null; }
      const parsed = response ? parseExtraction(response, style) : [];
      if (parsed.length > 0 || (response !== null && /^\s*NONE\.?\s*$/i.test(response))) {
        answered = true;
        add(parsed);
      } else {
        failed.push(part);
      }
    }
    if (!answered) return null;
    for (const part of failed) add(extractHeuristic(part));
    return memories;
  } catch {
    return null;
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Extract and store memories + knowledge from conversation text.
 * Mem0-style dual store: facts → memory (FTS+vector), entities → knowledge graph.
 *
 * Uses LLM if available, falls back to heuristic patterns.
 */
export async function extractAndStore(
  db: Database,
  text: string,
  scope?: string,
  storeFn?: StoreFn,
  knowledgeStoreFn?: KnowledgeStoreFn,
  metadata?: Record<string, unknown>,
): Promise<ExtractionResult> {
  const store = storeFn!;

  // Redact <private>...</private> spans before any extraction runs — a
  // sentence-level split (extractHeuristic) could otherwise separate an
  // opening/closing tag pair across chunks and leak the middle. Redacting
  // the whole conversation up front also keeps private text out of the
  // remote LLM call in extractWithLLM below.
  text = redactPrivate(text);
  if (!text.trim()) {
    return { extracted: [], stored: 0, duplicates: 0, preferences: [], triples: 0 };
  }

  // Try LLM first (Mem0-style atomic facts), fall back to heuristic
  const fromLLM = await extractWithLLM(text);
  const extracted = fromLLM ?? extractHeuristic(text);

  // Also extract preference patterns for synthetic FTS entries
  const preferences = extractPreferences(text);

  let stored = 0;
  let duplicates = 0;
  let triples = 0;

  // Store each extracted memory in vector+FTS store
  for (const mem of extracted) {
    const result = await store(db, {
      text: mem.text,
      category: mem.category,
      scope,
      importance: mem.importance,
      metadata,
      actor: EXTRACTOR_ACTOR,
    });
    if (result.status === "created") {
      stored++;

      // Mem0-style: also store entity triple in knowledge graph
      if (mem.triple && knowledgeStoreFn) {
        try {
          knowledgeStoreFn(db, {
            subject: mem.triple.subject,
            predicate: mem.triple.predicate,
            object: mem.triple.object,
            scope,
            source_memory_id: result.id,
          });
          triples++;
        } catch { /* skip duplicate triples */ }
      }
    } else {
      duplicates++;
    }
  }

  // Store preference synthetic entries
  for (const pref of preferences) {
    const result = await store(db, {
      text: pref,
      category: "preference",
      scope,
      importance: 0.4,
      metadata,
      actor: EXTRACTOR_ACTOR,
    });
    if (result.status === "created") stored++;
    else duplicates++;
  }

  return { extracted, stored, duplicates, preferences, triples };
}

// =============================================================================
// Reflection extraction (cat 18) — legacy path, still used by LoCoMo eval ablation
// =============================================================================
// Reflections are extracted as part of extractAndStore via the unified
// EXTRACTION_PROMPT. This standalone entry is retained because
// evaluate/locomo/eval.mts (gated by LOTL_INGEST_REFLECTIONS) still calls it
// directly for ablation runs. Not deprecated for removal — live for eval.
export async function extractReflections(
  _db: Database,
  _text: string,
  _scope: string | undefined,
  _storeFn: StoreFn
): Promise<{ extracted: number; stored: number; duplicates: number }> {
  // No-op: reflections are extracted by extractAndStore now.
  return { extracted: 0, stored: 0, duplicates: 0 };
}
