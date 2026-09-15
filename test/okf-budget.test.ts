import { describe, test, expect } from "vitest";
import { isOverBudget, heuristicCompact, compactMemoryText, BODY_MAX, COMPACT_MIN_OVERAGE } from "../src/okf/budget.js";

describe("caveman budget", () => {
  test("flags under-budget text as not over budget", () => {
    expect(isOverBudget("short")).toBe(false);
  });
  test("text just over BODY_MAX but inside the margin is not over budget", () => {
    const text = "x".repeat(BODY_MAX + 20); // 520 chars, under the 600-char default threshold
    expect(isOverBudget(text)).toBe(false);
    // caller (memoryStore) only compacts when isOverBudget is true, so this
    // text would flow through byte-identical rather than being compacted
  });
  test("text well over the margin is over budget", () => {
    const text = "x".repeat(Math.ceil(BODY_MAX * COMPACT_MIN_OVERAGE) + 1);
    expect(isOverBudget(text)).toBe(true);
  });
  test("heuristic keeps first line as description and trims body", () => {
    const text = "first line fact\n" + "extra ".repeat(400);
    const { description, body } = heuristicCompact(text);
    expect(description).toBe("first line fact");
    expect(body.length).toBeLessThanOrEqual(BODY_MAX);
  });
  test("compact falls back to heuristic when chat throws", async () => {
    const r = await compactMemoryText("aaaa\nbbbb", async () => { throw new Error("no llm"); });
    expect(r.description).toBe("aaaa");
    expect(r.lowConfidence).toBe(true);
  });
  test("compact uses chat JSON when provided", async () => {
    const r = await compactMemoryText("long text here", async () =>
      JSON.stringify({ description: "d", body: "b" }));
    expect(r).toMatchObject({ description: "d", body: "b", lowConfidence: false });
  });
});
