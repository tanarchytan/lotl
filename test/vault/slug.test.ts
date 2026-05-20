import { describe, expect, it } from "vitest";
import { disambiguateSlug, sanitizeScope, slugForSubject } from "../../src/vault/templates.js";

describe("sanitizeScope", () => {
  it("passes simple names through", () => {
    expect(sanitizeScope("global")).toBe("global");
    expect(sanitizeScope("project-foo")).toBe("project-foo");
  });

  it("replaces slashes with hyphens", () => {
    expect(sanitizeScope("agent/foo")).toBe("agent-foo");
    expect(sanitizeScope("a/b/c")).toBe("a-b-c");
  });

  it("strips characters illegal on Windows + POSIX", () => {
    expect(sanitizeScope('weird:name*?<>"|')).toBe("weird-name");
  });

  it("collapses runs of hyphens and trims edges", () => {
    expect(sanitizeScope("///hello///")).toBe("hello");
    expect(sanitizeScope("a   b")).toBe("a-b");
  });

  it("falls back to 'scope' for empty input", () => {
    expect(sanitizeScope("")).toBe("scope");
    expect(sanitizeScope("////")).toBe("scope");
  });
});

describe("slugForSubject", () => {
  it("re-exports toSlug behaviour for entity names", () => {
    // toSlug uses underscores (see src/memory/knowledge.ts) — vault follows
    // the KG slug contract so vault filenames match KG subject lookups.
    expect(slugForSubject("David Gillot")).toBe("david_gillot");
    expect(slugForSubject("@tanarchy/lotl")).toBe("tanarchy_lotl");
  });
});

describe("disambiguateSlug", () => {
  it("returns the slug unchanged when no collision", () => {
    expect(disambiguateSlug("david", "global", new Set())).toBe("david");
  });

  it("prefixes the scope when slug already taken", () => {
    const taken = new Set(["david"]);
    expect(disambiguateSlug("david", "project-foo", taken)).toBe("project-foo-david");
  });

  it("sanitizes the scope before prefixing", () => {
    const taken = new Set(["david"]);
    expect(disambiguateSlug("david", "agent/bar", taken)).toBe("agent-bar-david");
  });

  it("re-disambiguates on a second collision by appending a numeric suffix", () => {
    const taken = new Set(["david", "global-david"]);
    expect(disambiguateSlug("david", "global", taken)).toBe("global-david-2");
  });

  it("increments the numeric suffix until finding an available slot", () => {
    const taken = new Set(["david", "global-david", "global-david-2", "global-david-3"]);
    expect(disambiguateSlug("david", "global", taken)).toBe("global-david-4");
  });
});
