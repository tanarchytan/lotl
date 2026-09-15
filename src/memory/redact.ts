/**
 * memory/redact.ts — Strip <private>...</private> spans before capture.
 *
 * Text inside <private> tags must never reach the DB or a remote LLM.
 * Callers MUST run this before any hashing/embedding/network/storage step —
 * see memoryStore in index.ts for the canonical placement.
 *
 * Deliberately not a parser, but it fails closed rather than open. Handles
 * multiple spans, spans across newlines, case-insensitive tags, an unclosed
 * open tag (stripped to end of string), and an orphan close tag (everything
 * before it is stripped). That last rule is what makes nesting safe: in
 * `<private>a<private>b</private>c</private>` the lazy match consumes the
 * inner close, so `c</private>` survives the first pass and would leak.
 * Over-redacting on a stray `</private>` is the acceptable side of that trade.
 */

const PRIVATE_CLOSED = /<private>[\s\S]*?<\/private>/gi;
const PRIVATE_ORPHAN_CLOSE = /^[\s\S]*<\/private>/i;
const PRIVATE_UNCLOSED = /<private>[\s\S]*$/i;

/** Strip <private>...</private> spans. Returns the input unchanged if none are present. */
export function redactPrivate(text: string): string {
  let out = text.replace(PRIVATE_CLOSED, "");
  out = out.replace(PRIVATE_ORPHAN_CLOSE, "");
  out = out.replace(PRIVATE_UNCLOSED, "");
  return out;
}
