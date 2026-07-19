import { describe, test, expect } from "vitest";
import { renderGroups, renderRefs } from "../src/okf/index-render.js";

describe("okf index render", () => {
  test("renders groups grouped by type", () => {
    const out = renderGroups([
      { path: "docs/notes", title: "notes", type: "Collection", count: 3, description: "3 documents" },
      { path: "memory/global", title: "global", type: "Memory scope", count: 5, description: "5 memories" },
    ]);
    expect(out).toContain("# Collection");
    expect(out).toContain("* [notes](docs/notes) — 3 documents");
    expect(out).toContain("# Memory scope");
    expect(out).toContain("* [global](memory/global) — 5 memories");
  });

  test("renders refs as a flat list", () => {
    const out = renderRefs([{ id: "memory/global/a1b2c3d4", type: "Fact", title: "alpha", description: "alpha fact one" }]);
    expect(out).toBe("* [alpha](memory/global/a1b2c3d4) — alpha fact one");
  });

  test("omits the em-dash when description is empty", () => {
    const out = renderRefs([{ id: "docs/notes/x", type: "Document", title: "X", description: "" }]);
    expect(out).toBe("* [X](docs/notes/x)");
  });
});
