import { describe, test, expect } from "vitest";
import {
  buildDocId, buildMemoryId, buildEntityId,
  conceptKind, parseConceptId, memoryCategoryToType, capitalize,
} from "../src/okf/concept.js";

describe("okf concept ids", () => {
  test("builds ids per scheme", () => {
    expect(buildDocId("notes", "sub/readme.md")).toBe("docs/notes/sub/readme");
    expect(buildDocId("notes", "sub/readme")).toBe("docs/notes/sub/readme");
    expect(buildMemoryId("global", "a1b2c3d4e5f6")).toBe("memory/global/a1b2c3d4");
    expect(buildEntityId("Caroline Smith")).toBe("entities/caroline-smith");
  });

  test("routes kind by prefix", () => {
    expect(conceptKind("docs/notes/x")).toBe("docs");
    expect(conceptKind("memory/global/a1b2c3d4")).toBe("memory");
    expect(conceptKind("entities/caroline-smith")).toBe("entities");
    expect(() => conceptKind("bogus/x")).toThrow();
  });

  test("parses a memory id back to parts", () => {
    expect(parseConceptId("memory/global/a1b2c3d4")).toEqual({
      kind: "memory", group: "memory/global", rest: "a1b2c3d4",
    });
    expect(parseConceptId("docs/notes/sub/readme")).toEqual({
      kind: "docs", group: "docs/notes", rest: "sub/readme",
    });
  });

  test("parses an entity id", () => {
    expect(parseConceptId("entities/caroline-smith")).toEqual({
      kind: "entities", group: "entities", rest: "caroline-smith",
    });
  });

  test("maps memory category to OKF type", () => {
    expect(memoryCategoryToType("fact")).toBe("Fact");
    expect(memoryCategoryToType("decision")).toBe("Decision");
    expect(capitalize("preference")).toBe("Preference");
  });
});
