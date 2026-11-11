/**
 * memory/notes-heuristic.ts — no-LLM extraction for notes-style input
 * (session summaries the save hook makes the agent pass to memory_extract).
 *
 * Only selects and regroups the notes' own text, so it cannot invent a
 * fact. Steps:
 *   1. title: a first line like "<subject> session, 2031-04-02." or
 *      "# <subject>" or "PROJECT: <subject>" names the subject and is not
 *      stored; without one, a name that recurs in the notes is the subject;
 *   2. blocks: headings (their text becomes the topic) and blank lines;
 *   3. pieces: sentences and list items; a list stays with its lead-in line;
 *   4. meta talk about the session (thanks, "productive session") is dropped;
 *   5. consecutive pieces of one block are packed into memories of about
 *      EXTRACT_HEUR_PACK_CHARS (never over EXTRACT_HEUR_MEMORY_CHARS); a
 *      sentence opening with "That/It/He ..." stays with the one before;
 *      memories with no informative token, rule word or name are dropped,
 *      and at most EXTRACT_HEUR_MAX_MEMORIES per EXTRACT_CHUNK_CHARS of
 *      notes are kept (the most informative, in note order);
 *   6. each memory gets the subject (and topic) prefix it lacks (withSubject).
 * Measured in devnotes/metrics/local-llm-e2b-2026-11-11.md ("Heuristic extraction").
 */

import { cleanTopic, withSubject, META_ONLY } from "./notes-subject.js";
import {
  EXTRACT_HEUR_MAX_MEMORIES, EXTRACT_HEUR_PACK_CHARS, EXTRACT_HEUR_MEMORY_CHARS, EXTRACT_HEUR_MIN_CHARS,
  EXTRACT_HEUR_TITLE_WORDS, EXTRACT_CHUNK_CHARS,
} from "../store/constants.js";

const DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g;
const CLOSING_DATE = new RegExp(`(?:${DATE.source})\\s*(?:\\([^)]*\\))?\\s*$|\\([^)]*(?:${DATE.source})[^)]*\\)\\s*$`);
const CONTENT_START = /^(the|a|an|we|i|it|this|that|there|de|het|een|wij|ik|dit|dat|er)\b/i;
const NOTES_WORD = /\b(session|sessie|summary|samenvatting|notes?|notities?|aantekeningen|handoff|overdracht|recap|log|wrap-?up)\b/i;
// Words trimmed from either end of a title segment; a segment made only of
// these ("Short notes from today", "Weekly status update") names no subject.
const TITLE_GENERIC = new Set([
  "session", "sessie", "summary", "samenvatting", "notes", "note", "notities", "notitie", "aantekeningen",
  "handoff", "overdracht", "compaction", "recap", "log", "update", "status", "wrap-up", "wrapup",
  "quick", "short", "korte", "from", "today", "vandaag", "daily", "weekly", "of", "the", "a", "an",
  "van", "de", "het", "een", "on", "for", "voor", "and", "en", "my", "our",
]);
const HEADING = /^#{1,6}\s+(.*)$/;
const PROJECT_LINE = /^PROJECT:\s*(.+)$/i;
const ITEM = /^(?:[-*•+]|\d{1,2}[.)])\s+/;
const FENCE = /^(```|~~~)/;
const TABLE_RULE = /^\|[\s:|-]+$/;
const SENTENCE_END = /(?<=[.!?])\s+(?=[\p{Lu}\p{N}"'`(\[])/u;

// Informative tokens: numbers, paths, file names, identifiers (snake, camel,
// ALLCAPS, hyphenated), flags, code.
const INFO_TOKEN = /\d|\b[a-z]+-[a-z0-9]+\b|[\w.-][/\\][\w.-]|\b\w+\.[a-z]{1,5}\b|\b[a-z]+_[a-z_]+\b|\b[a-z]+[A-Z]\w*|\b[A-Z][a-z]+[A-Z]\w*|\b[A-Z]{2,}[A-Z0-9_]*\b|`|(?:^|\s)--?[a-z]/g;
// Decision, preference, rule, negation and open-point wording, EN + NL.
const RULE_WORD = /\b(decid\w*|decision|agreed|chose|prefer\w*|wants?|never|always|must|should|rule|default|lesson|limit\w*|caveat|instead|because|reason|not|no longer|yet|open|todo|next step|bug|fix\w*|fail\w*|works?|verified|measured|besluit|besloten|afspraak|afgesproken|wil|voorkeur|nooit|altijd|moet|mag|regel|nog niet|niet|geen|bevinding|gevonden|gemeten|werkwijze|omdat|in plaats van)\b/gi;
// A sentence that opens by pointing back at the one before it.
const ANAPHOR = /^(that|this|these|those|it|so|also|then|which|he|she|they|his|her|their|dat|dit|daarna|daardoor|ook|hij|zij|ze|zijn|haar)\b/i;
// Remarks about the session itself, not about the subject.
const FILLER = /^(thanks|thank you|bedankt|dank je|cheers)\b|\b(productive|nothing new|nothing else|niets nieuws|good session|goede sessie)\b/i;

// Capitalised words that are not names (sentence starters, labels).
const NOT_A_NAME = new Set([
  "the", "this", "that", "these", "those", "there", "then", "we", "i", "it", "he", "she", "they", "you",
  "our", "my", "his", "her", "their", "a", "an", "and", "but", "or", "if", "so", "also", "after", "before",
  "when", "while", "next", "not", "no", "done", "open", "decision", "decided", "lesson", "caveat", "note",
  "de", "het", "een", "dat", "die", "dit", "deze", "er", "wij", "we", "ik", "hij", "zij", "ze", "en", "maar",
  "ook", "daarna", "besluit", "afspraak", "bevinding", "gevonden", "open", "werkwijze",
]);

type NotesTitle = { project: string | null; body: string };

/** Subject named by a title segment, after trimming generic words; null if none. */
function subjectFromTitle(title: string): string | null {
  const plain = title.replace(/\([^)]*\)/g, " ").replace(DATE, " ").replace(/^#+\s*/, "");
  for (const seg of plain.split(/[,;]|\s[-–—]\s/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    const generic = (w: string) => TITLE_GENERIC.has(w.toLowerCase().replace(/[^\p{L}-]/gu, ""));
    while (words.length && generic(words[0]!)) words.shift();
    while (words.length && generic(words[words.length - 1]!)) words.pop();
    if (words.length === 0) continue;
    const t = cleanTopic(words.join(" "));
    if (t) return t;
  }
  return null;
}

/**
 * "quarry session summary, 2031-04-02", "Billing notes", "render farm
 * 2031-09-14 (second pass)": a few words, no article or pronoun up front, and a notes
 * word or a closing date. "On 2031-04-02 we moved the cache" is content.
 */
function isTitle(head: string): boolean {
  const words = head.replace(/\([^)]*\)/g, " ").replace(DATE, " ").split(/[\s,]+/).filter(Boolean);
  if (words.length > EXTRACT_HEUR_TITLE_WORDS || CONTENT_START.test(head)) return false;
  return NOTES_WORD.test(head) || CLOSING_DATE.test(head);
}

/** Split off a title line: "PROJECT: x", a first-line heading, or a dated / "session"-style first sentence. */
function splitTitle(text: string): NotesTitle {
  const trimmed = text.replace(/^\s+/, "");
  const nl = trimmed.indexOf("\n");
  const first = nl < 0 ? trimmed : trimmed.slice(0, nl);
  const rest = nl < 0 ? "" : trimmed.slice(nl + 1);
  const p = first.match(PROJECT_LINE);
  if (p) return { project: cleanTopic(p[1]!), body: rest };
  const h = first.match(HEADING);
  if (h) return { project: subjectFromTitle(h[1]!), body: rest };
  const end = first.search(/\.\s|:\s|\.$/);
  const head = end < 0 ? first : first.slice(0, end);
  if (!isTitle(head)) return { project: null, body: trimmed };
  const remainder = end < 0 ? "" : first.slice(end + 1).trim();
  return { project: subjectFromTitle(head), body: remainder ? `${remainder}\n${rest}` : rest };
}

const NAME = /(?<![\p{L}\p{N}_-])[\p{Lu}][\p{L}\p{N}-]+(?![\p{L}\p{N}_]|:)/gu;
// A capitalised word right after a lower-case word or a comma is mid-sentence.
const MID_NAME = /(?<=[\p{Ll}\p{N},;)]\s)[\p{Lu}][\p{L}\p{N}-]+(?![\p{L}\p{N}_])/gu;

function nameCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(NAME)) {
    if (!NOT_A_NAME.has(m[0].toLowerCase())) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  return counts;
}

/** A name that recurs (>= 2 times) in the notes; null when none does. */
function recurringName(text: string): string | null {
  let best: string | null = null;
  let bestN = 1;
  for (const [w, n] of nameCounts(text)) if (n > bestN) { best = w; bestN = n; }
  return best;
}

/** Names the notes use: capitalised words that recur or stand mid-sentence. */
function knownNames(text: string): Set<string> {
  const names = new Set([...nameCounts(text)].filter(([, n]) => n >= 2).map(([w]) => w));
  for (const m of text.matchAll(MID_NAME)) if (!NOT_A_NAME.has(m[0].toLowerCase())) names.add(m[0]);
  return names;
}

/** Subject of a whole note (title, else a recurring name). Used for parts of long notes. */
export function notesSubject(text: string): string | null {
  const { project, body } = splitTitle(text);
  return project ?? recurringName(body);
}

/** Cut a piece longer than `max` at "; ", then ", ", then at a space. */
function splitLong(piece: string, max: number): string[] {
  if (piece.length <= max) return [piece];
  for (const sep of [/(?<=;)\s+/, /(?<=,)\s+/, /\s+/]) {
    const parts = piece.split(sep);
    if (parts.length < 2) continue;
    const out: string[] = [];
    let cur = "";
    for (const p of parts) {
      if (cur && cur.length + 1 + p.length > max) { out.push(cur); cur = ""; }
      cur = cur ? `${cur} ${p}` : p;
    }
    if (cur) out.push(cur);
    if (out.every(o => o.length <= max)) return out;
  }
  const out: string[] = [];
  for (let i = 0; i < piece.length; i += max) out.push(piece.slice(i, i + max));
  return out;
}

const infoTokens = (s: string) => (s.match(INFO_TOKEN) ?? []).length;
const ruleWords = (s: string) => new Set((s.match(RULE_WORD) ?? []).map(w => w.toLowerCase())).size;

function isMeta(piece: string): boolean {
  if (META_ONLY.test(piece)) return true;
  if (FILLER.test(piece) && infoTokens(piece) === 0) return true;
  return piece.length < EXTRACT_HEUR_MIN_CHARS && infoTokens(piece) === 0;
}

/**
 * Sentences, list items and table rows of one block. A list is joined to its
 * lead-in line ("Agreed three changes:"), a table row to its header row.
 */
function blockPieces(lines: string[], target: number, hard: number): string[] {
  const pieces: string[] = [];
  let prose: string[] = [];
  let list: string[] = [];
  let header: string | null = null;
  const flushProse = () => {
    const sentences = prose.join(" ").split(SENTENCE_END).map(s => s.trim()).filter(Boolean);
    prose = [];
    return sentences;
  };
  const flushList = () => {
    if (list.length === 0) return;
    const lead = pieces.length && /:$/.test(pieces[pieces.length - 1]!) ? pieces.pop()! : null;
    const items = list;
    list = [];
    if (!lead) { pieces.push(...items); return; }
    let cur = lead;
    for (const item of items) {
      if (cur !== lead && cur.length + 1 + item.length > target) { pieces.push(cur); cur = lead; }
      cur = `${cur} ${item}`;
    }
    pieces.push(cur);
  };
  for (const raw of lines) {
    const line = raw.replace(/\*\*/g, "").trim();
    if (!line || FENCE.test(line)) continue;
    if (line.startsWith("|")) {
      if (prose.length) pieces.push(...flushProse());
      flushList();
      if (TABLE_RULE.test(line)) continue;
      if (header === null) header = line;
      else pieces.push(`${header} ${line}`);
      continue;
    }
    header = null;
    if (ITEM.test(line)) {
      if (prose.length) pieces.push(...flushProse());
      list.push(line.replace(ITEM, ""));
    } else {
      flushList();
      prose.push(line);
    }
  }
  if (prose.length) pieces.push(...flushProse());
  flushList();
  return pieces.flatMap(p => splitLong(p, hard)).filter(p => !isMeta(p));
}

/**
 * Pack consecutive pieces into memories of about `target` chars. A piece
 * that opens with a back-reference ("That one ...", "So ...") stays with
 * the piece before it up to `hard` chars: alone it names nothing.
 */
function pack(pieces: string[], target: number, hard: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of pieces) {
    const len = cur.length + 1 + p.length;
    if (cur && len > target && !(ANAPHOR.test(p) && len <= hard)) { out.push(cur); cur = ""; }
    cur = cur ? `${cur} ${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

type Draft = { text: string; topic: string | null; score: number; order: number };

/** Blocks of the body: headings set the topic, blank lines separate blocks. */
function blocks(body: string): { topic: string | null; lines: string[] }[] {
  const out: { topic: string | null; lines: string[] }[] = [];
  let topic: string | null = null;
  let cur: string[] = [];
  const flush = () => { if (cur.length) out.push({ topic, lines: cur }); cur = []; };
  for (const line of body.split("\n")) {
    const h = line.trim().match(HEADING);
    if (h) { flush(); topic = cleanTopic(h[1]!.replace(/^\d+[.)]\s*/, "")); continue; }
    if (!line.trim()) { flush(); continue; }
    cur.push(line);
  }
  flush();
  return out;
}

/** EXTRACT_HEUR_MAX_MEMORIES per EXTRACT_CHUNK_CHARS of notes, the same
 *  parts the LLM notes path extracts one at a time. */
function maxMemories(text: string): number {
  return EXTRACT_HEUR_MAX_MEMORIES * Math.max(1, Math.ceil(text.length / EXTRACT_CHUNK_CHARS));
}

/**
 * Notes-style memories as plain text, subject-prefixed. `subject` overrides
 * the subject found in the text (a later part of a long note has no title).
 */
export function notesHeuristic(text: string, subject?: string | null): string[] {
  const target = EXTRACT_HEUR_PACK_CHARS;
  const hard = EXTRACT_HEUR_MEMORY_CHARS;
  const { project: titled, body } = splitTitle(text);
  const project = subject ?? titled ?? recurringName(body);
  const names = knownNames(body);
  const drafts: Draft[] = [];
  for (const b of blocks(body)) {
    for (const memory of pack(blockPieces(b.lines, target, hard), target, hard)) {
      const score = infoTokens(memory) + ruleWords(memory) + [...names].filter(n => memory.includes(n)).length;
      if (score === 0) continue;
      drafts.push({ text: memory, topic: b.topic, score, order: drafts.length });
    }
  }
  const kept = [...drafts].sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, maxMemories(text)).sort((a, b) => a.order - b.order);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of kept) {
    const memory = withSubject(d.text, project, d.topic);
    const key = memory.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(memory);
  }
  return out;
}
