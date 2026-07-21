import { describe, test, expect } from "vitest";
import { buildStaticInstructions } from "../src/mcp/server.js";

describe("okf mcp wiring", () => {
  test("static instructions point at okf_index", () => {
    expect(buildStaticInstructions()).toMatch(/okf_index/);
  });
});
