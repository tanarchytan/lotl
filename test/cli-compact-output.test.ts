import { describe, test, expect } from "vitest";
import { formatCompactReview, COMPACT_REVIEW_SAMPLE } from "../src/cli/lotl.js";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `mem-${i}`);

describe("formatCompactReview", () => {
  test("prints nothing when there is nothing to review", () => {
    expect(formatCompactReview([], false)).toEqual([]);
  });

  test("a short list is shown whole on one line with its count", () => {
    const out = formatCompactReview(ids(3), false);
    expect(out).toEqual(["Review (low-confidence, not applied): 3. mem-0, mem-1, mem-2"]);
  });

  test("a long list is a count plus a bounded sample and a hint", () => {
    const out = formatCompactReview(ids(7965), false);
    const text = out.join("\n");
    expect(text).toContain("7965");
    expect(text).toContain(`mem-${COMPACT_REVIEW_SAMPLE - 1}`);
    expect(text).not.toContain(`mem-${COMPACT_REVIEW_SAMPLE},`);
    expect(text).toContain("--list-ids");
    expect(text.length).toBeLessThan(1000);
  });

  test("--list-ids prints every id, one per line, and nothing else", () => {
    expect(formatCompactReview(ids(25), true)).toEqual(ids(25));
  });
});
