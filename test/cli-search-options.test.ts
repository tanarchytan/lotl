/**
 * Numeric search options: an explicit 0 is a value, only an absent option gets a default.
 * `lotl vsearch --min-score 0` used to become 0.3 because of `opts.minScore || 0.3`.
 */

import { describe, test, expect, vi } from "vitest";
import { parseSearchNumbers, VSEARCH_DEFAULT_MIN_SCORE, resolveVsearchMinScore } from "../src/cli/lotl.js";

describe("parseSearchNumbers", () => {
  test("absent --min-score stays undefined (no default decided at parse time)", () => {
    expect(parseSearchNumbers({}, 5).minScore).toBeUndefined();
  });

  test("explicit --min-score 0 is kept as 0", () => {
    expect(parseSearchNumbers({ "min-score": "0" }, 5).minScore).toBe(0);
  });

  test("--min-score parses decimals", () => {
    expect(parseSearchNumbers({ "min-score": "0.45" }, 5).minScore).toBe(0.45);
  });

  test("limit falls back to the default when absent", () => {
    expect(parseSearchNumbers({}, 5).limit).toBe(5);
    expect(parseSearchNumbers({ n: "12" }, 5).limit).toBe(12);
  });

  test("candidate-limit is undefined when absent or not a number", () => {
    expect(parseSearchNumbers({}, 5).candidateLimit).toBeUndefined();
    expect(parseSearchNumbers({ "candidate-limit": "x" }, 5).candidateLimit).toBeUndefined();
    expect(parseSearchNumbers({ "candidate-limit": "60" }, 5).candidateLimit).toBe(60);
  });

  test("a non-numeric --min-score is a usage error, not a silent 0", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => { throw new Error("exit"); }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => parseSearchNumbers({ "min-score": "abc" }, 5)).toThrow("exit");
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
  });
});

describe("resolveVsearchMinScore", () => {
  test("absent gets the vector default", () => {
    expect(resolveVsearchMinScore(undefined)).toBe(VSEARCH_DEFAULT_MIN_SCORE);
    expect(VSEARCH_DEFAULT_MIN_SCORE).toBe(0.3);
  });
  test("explicit 0 stays 0", () => {
    expect(resolveVsearchMinScore(0)).toBe(0);
  });
  test("explicit value wins", () => {
    expect(resolveVsearchMinScore(0.7)).toBe(0.7);
  });
});
