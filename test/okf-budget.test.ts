import { describe, test, expect } from "vitest";
import { isOverBudget, heuristicCompact, compactMemoryText, BODY_MAX } from "../src/okf/budget.js";

describe("caveman budget", () => {
  test("flags over-budget text", () => {
    expect(isOverBudget("short")).toBe(false);
    expect(isOverBudget("x".repeat(BODY_MAX + 1))).toBe(true);
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
