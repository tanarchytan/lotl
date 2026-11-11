/**
 * memory/relevance.ts: opt-in absolute relevance gate for keyword recall.
 *
 * Recall scores are rank-derived (RRF) and min-max normalised, so they say
 * which memory is best but not whether any memory is relevant at all. This
 * module adds a lexical signal that is comparable across queries:
 *
 *   coverage(m) = Σ idf(t) over informative prompt terms t found in m
 *                 ───────────────────────────────────────────────────
 *                 Σ idf(t) over all informative prompt terms
 *
 * A memory passes when coverage ≥ minRelevance AND it matches at least
 * min(MEMORY_RELEVANCE_MIN_MATCHES, #terms) distinct terms. A prompt with
 * fewer than MEMORY_RELEVANCE_MIN_TERMS informative terms ("send it",
 * "continue") is never queried at all.
 *
 * Specificity floor (index of ≥ MEMORY_RELEVANCE_MIN_CORPUS memories): the
 * matched terms must also be jointly rare, Σ idf(matched) ≥ ln(N) +
 * MEMORY_RELEVANCE_MIN_SPECIFICITY. With two informative terms coverage is
 * 0 or 1, so without this any memory holding "claude" and "rebooted" by
 * chance passed. For two-term prompts a memory holding both terms side by
 * side, when no other memory does, gets the floor lowered by
 * MEMORY_RELEVANCE_PHRASE_CREDIT. Both checks use document frequencies of
 * this index only, so they need no word list and no language knowledge.
 *
 * Informative terms = prompt tokens minus English stopwords, conversational
 * acknowledgements and generic coding-session words (fix, test, commit, ...).
 * Measured on a labelled set of real prompts: devnotes/metrics/recall-relevance-gate-2026-11-10.md.
 *
 * Only used when a caller passes `minRelevance`; default recall never runs it.
 */
import type { Database } from "../db.js";
import {
  MEMORY_RELEVANCE_MIN_TERMS,
  MEMORY_RELEVANCE_MIN_MATCHES,
  MEMORY_RELEVANCE_MIN_SPECIFICITY,
  MEMORY_RELEVANCE_PHRASE_CREDIT,
  MEMORY_RELEVANCE_MIN_CORPUS,
} from "../store/constants.js";

// Union of the recall FTS stopwords and generic chat / coding-session words.
// Written from three categories (English function words, acknowledgements,
// generic workflow verbs and nouns), not from the evaluation negatives.
const GENERIC_WORDS = new Set([
  "a", "about", "above", "across", "actually", "add", "added", "adding", "after", "again",
  "against", "ago", "ah", "ahead", "all", "almost", "along", "already", "also", "although",
  "always", "am", "an", "and", "another", "answer", "any", "anyone", "anything", "anyway", "are",
  "around", "as", "ask", "asked", "at", "away", "back", "bad", "be", "because", "been", "before",
  "being", "below", "best", "better", "between", "big", "bit", "both", "bought", "brief", "bug",
  "bugs", "build", "builds", "built", "but", "buy", "by", "can", "cannot", "case", "cases",
  "change", "changed", "changes", "changing", "check", "checked", "checking", "checks", "code",
  "commit", "commits", "committed", "continue", "continued", "cool", "correctly", "could",
  "current", "day", "days", "delete", "deleted", "did", "different", "do", "does", "doing", "done",
  "down", "during", "each", "earlier", "either", "else", "enough", "error", "errors", "even",
  "evening", "ever", "every", "everything", "explain", "explanation", "fail", "failed", "failing",
  "fails", "failure", "few", "file", "files", "find", "fine", "first", "fix", "fixed", "fixes",
  "fixing", "for", "found", "from", "full", "function", "functions", "further", "gave", "get",
  "gets", "getting", "give", "given", "go", "goes", "going", "gone", "good", "got", "great", "had",
  "has", "have", "having", "he", "help", "her", "here", "hers", "him", "his", "hour", "hours",
  "how", "however", "i", "if", "in", "instead", "into", "is", "issue", "issues", "it", "its",
  "itself", "just", "keep", "kind", "know", "last", "later", "latest", "least", "less", "let",
  "lets", "lgtm", "like", "likely", "line", "lines", "list", "little", "long", "look", "looked",
  "looking", "looks", "lot", "made", "make", "makes", "many", "may", "maybe", "me", "merge",
  "merged", "might", "mine", "minute", "minutes", "month", "months", "more", "morning", "most",
  "much", "must", "my", "need", "needed", "needs", "never", "new", "next", "nice", "night", "no",
  "nope", "nor", "not", "nothing", "now", "of", "off", "oh", "ok", "okay", "old", "on", "once",
  "one", "only", "or", "other", "others", "our", "out", "over", "own", "part", "perfect", "plan",
  "please", "point", "points", "previous", "problem", "problems", "proceed", "properly", "push",
  "pushed", "put", "quick", "quickly", "quite", "ran", "rather", "read", "really", "redo",
  "remove", "removed", "removing", "rerun", "result", "results", "retry", "revert", "review",
  "reviewed", "right", "run", "running", "runs", "said", "same", "say", "says", "second", "see",
  "seem", "seems", "seen", "send", "sent", "several", "shall", "she", "ship", "short", "should",
  "show", "simple", "simply", "since", "small", "so", "some", "something", "sometimes", "soon",
  "sound", "sounds", "step", "steps", "still", "such", "summarise", "summarize", "summary", "sure",
  "take", "tell", "test", "tested", "testing", "tests", "than", "thank", "thanks", "that", "the",
  "their", "them", "then", "there", "these", "they", "thing", "things", "think", "third", "this",
  "those", "though", "three", "through", "thus", "time", "times", "to", "today", "tomorrow", "too",
  "tried", "try", "trying", "two", "under", "undo", "unless", "until", "up", "update", "updated",
  "updates", "updating", "upon", "us", "use", "used", "using", "very", "want", "wanted", "wants",
  "was", "way", "we", "week", "weeks", "well", "went", "were", "what", "whatever", "when", "where",
  "whether", "which", "while", "who", "whole", "why", "will", "with", "within", "without", "work",
  "worked", "working", "works", "would", "write", "written", "wrote", "yeah", "year", "years",
  "yep", "yes", "yesterday", "yet", "you", "your", "yours",
]);

export type LexicalRelevance = {
  /** IDF-weighted share of the prompt's informative terms found in the memory text (0..1). */
  coverage: number;
  /** Distinct informative terms found in the memory text. */
  matched: number;
  /** Σ idf of the informative terms found in the memory text (nats). */
  mass: number;
};

/**
 * Informative prompt terms, lowercased and deduplicated. Splits on anything
 * that is not a letter or digit, so "frida-server" yields "frida", "server"
 * (the FTS tokenizer indexes them that way too).
 */
export function informativeTerms(query: string): string[] {
  const out: string[] = [];
  for (const t of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (t.length < 2 || GENERIC_WORDS.has(t) || out.includes(t)) continue;
    out.push(t);
  }
  return out;
}

/** Throws a RangeError unless 0 < value ≤ 1. */
export function assertMinRelevance(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new RangeError(`minRelevance must be a number in (0, 1], got ${value}`);
  }
}

function idf(df: number, n: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/** Per-memory relevance plus the size of the memory table the IDFs came from. */
type RelevanceScan = { n: number; rel: Map<string, LexicalRelevance>; idByRowid: Map<number, string> };

function scanRelevance(db: Database, terms: string[], ids: string[]): RelevanceScan {
  const rel = new Map<string, LexicalRelevance>();
  const idByRowid = new Map<number, string>();
  if (terms.length === 0 || ids.length === 0) return { n: 0, rel, idByRowid };

  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = db.prepare(
      `SELECT rowid, id FROM memories WHERE id IN (${slice.map(() => "?").join(",")})`
    ).all(...slice) as Array<{ rowid: number; id: string }>;
    for (const r of rows) idByRowid.set(r.rowid, r.id);
  }

  const n = (db.prepare(`SELECT count(*) AS c FROM memories`).get() as { c: number }).c;
  const termRows = db.prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?`);
  const weightById = new Map<string, number>();
  const matchedById = new Map<string, number>();
  let totalWeight = 0;
  for (const term of terms) {
    let rowids: number[] = [];
    try {
      // Terms are letters/digits only, so quoting cannot break the FTS syntax.
      rowids = (termRows.all(`text : "${term}"`) as Array<{ rowid: number }>).map(r => r.rowid);
    } catch { /* unmatchable term: counts as df = 0 */ }
    const w = idf(rowids.length, n);
    totalWeight += w;
    for (const rowid of rowids) {
      const id = idByRowid.get(rowid);
      if (id === undefined) continue;
      weightById.set(id, (weightById.get(id) ?? 0) + w);
      matchedById.set(id, (matchedById.get(id) ?? 0) + 1);
    }
  }
  for (const id of idByRowid.values()) {
    const weight = weightById.get(id) ?? 0;
    rel.set(id, {
      coverage: totalWeight > 0 ? weight / totalWeight : 0,
      matched: matchedById.get(id) ?? 0,
      mass: weight,
    });
  }
  return { n, rel, idByRowid };
}

/**
 * Coverage, distinct-term match count and matched IDF mass of `terms` for
 * each memory id, measured against the memory text column only
 * (scope/category columns would make a project name match every memory in
 * that project). Ids without a memories row (e.g. injected KG facts) are
 * absent from the map.
 */
export function lexicalRelevance(db: Database, terms: string[], ids: string[]): Map<string, LexicalRelevance> {
  return scanRelevance(db, terms, ids).rel;
}

/**
 * Memory id holding the two terms side by side (either order), when exactly
 * one memory in the index does; null otherwise.
 */
function uniquePhraseId(db: Database, terms: string[], idByRowid: Map<number, string>): string | null {
  if (terms.length !== 2) return null;
  try {
    const rows = db.prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH ? LIMIT 2`)
      .all(`text : NEAR("${terms[0]}" "${terms[1]}", 0)`) as Array<{ rowid: number }>;
    return rows.length === 1 ? idByRowid.get(rows[0]!.rowid) ?? null : null;
  } catch {
    return null;
  }
}

/**
 * Keep only rows that clear the gate, in their original order.
 * `terms` must come from informativeTerms(); callers check the
 * MEMORY_RELEVANCE_MIN_TERMS floor first so short prompts skip all work.
 */
export function filterByRelevance<T extends { id: string }>(
  db: Database,
  terms: string[],
  rows: T[],
  minRelevance: number,
): T[] {
  if (terms.length < MEMORY_RELEVANCE_MIN_TERMS) return [];
  const { n, rel, idByRowid } = scanRelevance(db, terms, rows.map(r => r.id));
  const minMatches = Math.min(MEMORY_RELEVANCE_MIN_MATCHES, terms.length);
  const floorOn = n >= MEMORY_RELEVANCE_MIN_CORPUS;
  const floor = floorOn ? Math.log(n) + MEMORY_RELEVANCE_MIN_SPECIFICITY : -Infinity;
  const phraseId = floorOn ? uniquePhraseId(db, terms, idByRowid) : null;
  return rows.filter(r => {
    const x = rel.get(r.id);
    if (x === undefined || x.matched < minMatches || x.coverage < minRelevance) return false;
    return x.mass >= (r.id === phraseId ? floor - MEMORY_RELEVANCE_PHRASE_CREDIT : floor);
  });
}
