/**
 * memory/notes-subject.ts — subject handling shared by the notes-style
 * extractors: the LLM notes parser (PROJECT:/TOPIC: lines) and the no-LLM
 * notes heuristic (title line, headings). Kept apart from extractor.ts so
 * both can import it without a cycle.
 */

import { EXTRACT_TOPIC_MAX_CHARS } from "../store/constants.js";

/** A memory that only states when/what the session was carries no fact. */
export const META_ONLY = /^(the )?(session|conversation|meeting|notes?|summary|session summary|chat)\b[^.]{0,60}\b(took place|was (held|recorded|on)|is (dated|from|scheduled)|date (is|was)|happened)\b/i;

const TOPIC_STOP = new Set(["session", "notes", "summary", "project", "system", "with", "from", "the", "and"]);

/** Clean a "TOPIC: x" value; null when empty or implausibly long. */
export function cleanTopic(raw: string): string | null {
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
export function mentionsTopic(text: string, topic: string): boolean {
  const t = text.toLowerCase();
  if (t.includes(topic.toLowerCase())) return true;
  const head = topic.split(/[\s/,()]+/)
    .map(w => w.replace(/[^\p{L}\p{N}._-]/gu, ""))
    .find(w => (w.length >= 3 || /\d|[A-Z]/.test(w.slice(1))) && !TOPIC_STOP.has(w.toLowerCase()));
  return head ? t.includes(head.toLowerCase()) : false;
}

/**
 * Prefix the subject a memory left out: "project, topic: text" when the
 * memory names neither, "project: text" when it names the topic only, and
 * nothing when it already names the project.
 */
export function withSubject(text: string, project: string | null, topic: string | null): string {
  if (project && mentionsTopic(text, project)) return text;
  const needTopic = topic && !mentionsTopic(text, topic) && !(project && mentionsTopic(topic, project));
  const parts = [project, needTopic ? topic : null].filter(Boolean);
  if (!project && !needTopic) return text;
  return parts.length ? `${parts.join(", ")}: ${text}` : text;
}
