export const DESCRIPTION_MAX = 120;
export const BODY_MAX = 500;

export function isOverBudget(text: string): boolean {
  return (text?.length ?? 0) > BODY_MAX;
}

export function heuristicCompact(text: string): { description: string; body: string } {
  const lines = (text || "").split("\n").map(s => s.trim()).filter(Boolean);
  const description = (lines[0] ?? "").slice(0, DESCRIPTION_MAX);
  let body = lines.slice(0, 6).join("\n");
  if (body.length > BODY_MAX) body = body.slice(0, BODY_MAX - 1) + "…";
  return { description, body };
}

const PROMPT = (text: string) =>
`Compress this memory to a terse "caveman" fact. Keep every load-bearing specific (ids, file:line, decisions, the one gotcha, [[links]]). Cut narrative and session play-by-play.
Return ONLY JSON: {"description": "<one line, <=${DESCRIPTION_MAX} chars>", "body": "<<=${BODY_MAX} chars>"}
MEMORY:
${text}`;

export async function compactMemoryText(
  text: string,
  chat?: (prompt: string) => Promise<string>,
): Promise<{ description: string; body: string; lowConfidence: boolean }> {
  if (!chat) return { ...heuristicCompact(text), lowConfidence: true };
  try {
    const raw = await chat(PROMPT(text));
    const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const description = String(json.description ?? "").slice(0, DESCRIPTION_MAX);
    const body = String(json.body ?? "").slice(0, BODY_MAX);
    const lowConfidence = !description || !body || body.length >= BODY_MAX;
    return { description, body, lowConfidence };
  } catch {
    return { ...heuristicCompact(text), lowConfidence: true };
  }
}
