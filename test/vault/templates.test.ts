import { describe, expect, it } from "vitest";
import { renderEntityPage, renderInboxPage } from "../../src/vault/templates.js";

const baseInput = {
  subject: "David Gillot",
  scope: "global",
  facts: [
    {
      predicate: "works_on",
      object: "Lotl",
      valid_from: "2026-01-15T10:00:00Z",
      valid_until: null,
    },
    {
      predicate: "lives_in",
      object: "Antwerp",
      valid_from: "2024-06-01T00:00:00Z",
      valid_until: "2025-12-31T00:00:00Z",
    },
  ],
  linkedMemories: [
    { memory_id: "abc1234def", excerpt: "David shipped v1.2 alpha." },
  ],
};

describe("renderEntityPage", () => {
  it("emits frontmatter with derived created_at / updated_at / fact_count", () => {
    const md = renderEntityPage(baseInput);
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('title: "David Gillot"');
    expect(md).toContain("type: entity");
    expect(md).toContain('scope: "global"');
    expect(md).toContain('created_at: "2024-06-01T00:00:00Z"');
    expect(md).toContain('updated_at: "2026-01-15T10:00:00Z"');
    expect(md).toContain("fact_count: 2");
  });

  it("renders current facts as wiki-linked bullets with since-date", () => {
    const md = renderEntityPage(baseInput);
    expect(md).toContain("## Current facts");
    expect(md).toContain("- **works_on** [[Lotl]] *(since 2026-01-15T10:00:00Z)*");
  });

  it("renders historical facts with a window", () => {
    const md = renderEntityPage(baseInput);
    expect(md).toContain("## Historical facts");
    expect(md).toContain(
      "- **lives_in** [[Antwerp]] *(2024-06-01T00:00:00Z → 2025-12-31T00:00:00Z)*",
    );
  });

  it("renders linked memories with truncated id + excerpt", () => {
    const md = renderEntityPage(baseInput);
    expect(md).toContain("## Linked memories");
    expect(md).toContain("- [[memory-abc1234d]] — David shipped v1.2 alpha.");
  });

  it("omits the Historical facts section when all facts are current", () => {
    const md = renderEntityPage({
      ...baseInput,
      facts: [baseInput.facts[0]!],
    });
    expect(md).not.toContain("## Historical facts");
  });

  it("emits placeholder when all facts have expired", () => {
    const md = renderEntityPage({
      ...baseInput,
      facts: [baseInput.facts[1]!],
    });
    expect(md).toContain("## Current facts");
    expect(md).toContain("*no current facts*");
  });

  it("omits the Linked memories section when none provided", () => {
    const md = renderEntityPage({ ...baseInput, linkedMemories: [] });
    expect(md).not.toContain("## Linked memories");
  });

  it("truncates memory excerpts to 200 chars with ellipsis", () => {
    const long = "x".repeat(250);
    const md = renderEntityPage({
      ...baseInput,
      linkedMemories: [{ memory_id: "deadbeef99", excerpt: long }],
    });
    expect(md).toContain(`- [[memory-deadbeef]] — ${"x".repeat(200)}...`);
  });

  it("handles a 0-fact entity without crashing", () => {
    const md = renderEntityPage({
      subject: "Empty",
      scope: "global",
      facts: [],
      linkedMemories: [],
    });
    expect(md).toContain("fact_count: 0");
    expect(md).toContain("*no current facts*");
    expect(md).not.toContain("## Historical facts");
    expect(md).not.toContain("## Linked memories");
  });

  it("escapes double-quotes in subject for YAML frontmatter", () => {
    const md = renderEntityPage({
      ...baseInput,
      subject: 'Joe "The Boss" Smith',
    });
    expect(md).toContain('title: "Joe \\"The Boss\\" Smith"');
  });

  it("escapes double-quotes in scope for YAML frontmatter", () => {
    const md = renderEntityPage({
      ...baseInput,
      scope: 'weird"name',
    });
    expect(md).toContain('scope: "weird\\"name"');
  });

  it("strips brackets from wikilink object values to prevent injection", () => {
    const md = renderEntityPage({
      ...baseInput,
      facts: [
        {
          predicate: "links_to",
          object: "foo]]injected[[",
          valid_from: "2026-01-01T00:00:00Z",
          valid_until: null,
        },
      ],
    });
    expect(md).toContain("[[fooinjected]]");
    expect(md).not.toContain("foo]]injected[[");
  });

  it("flattens newlines in memory excerpts to single spaces", () => {
    const md = renderEntityPage({
      ...baseInput,
      linkedMemories: [{ memory_id: "ab12cd34ef", excerpt: "line1\nline2\nline3" }],
    });
    expect(md).toContain("- [[memory-ab12cd34]] — line1 line2 line3");
  });

  it("strips newlines in subject to prevent frontmatter break", () => {
    const md = renderEntityPage({
      ...baseInput,
      subject: "broken\nname",
    });
    expect(md).toContain('title: "broken name"');
    // Heading should be on a single line
    expect(md).toMatch(/\n# broken name\n/);
  });
});

describe("renderInboxPage", () => {
  const mems = [
    {
      memory_id: "core01aaaa",
      created_at: "2026-05-19T10:00:00Z",
      importance: 0.85,
      excerpt: "Hard fact",
    },
    {
      memory_id: "core02bbbb",
      created_at: "2026-05-20T10:00:00Z",
      importance: 0.95,
      excerpt: "Newer hard fact",
    },
    {
      memory_id: "work01cccc",
      created_at: "2026-05-15T10:00:00Z",
      importance: 0.5,
      excerpt: "Soft fact",
    },
    {
      memory_id: "per01ddddd",
      created_at: "2026-05-10T10:00:00Z",
      importance: 0.05,
      excerpt: "Noise",
    },
  ];

  it("emits frontmatter with scope, count, generated_at", () => {
    const md = renderInboxPage({
      scope: "global",
      generated_at: "2026-05-20T12:00:00Z",
      memories: mems,
    });
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('title: "Inbox — global"');
    expect(md).toContain("type: inbox");
    expect(md).toContain('scope: "global"');
    expect(md).toContain("count: 4");
    expect(md).toContain('generated_at: "2026-05-20T12:00:00Z"');
  });

  it("groups memories by tier with the right thresholds", () => {
    const md = renderInboxPage({
      scope: "global",
      generated_at: "2026-05-20T12:00:00Z",
      memories: mems,
    });
    expect(md).toContain("## core (importance >= 0.7)");
    expect(md).toContain("## working (importance >= 0.3)");
    expect(md).toContain("## peripheral (importance >= 0)");
  });

  it("sorts within tier by created_at desc", () => {
    const md = renderInboxPage({
      scope: "global",
      generated_at: "2026-05-20T12:00:00Z",
      memories: mems,
    });
    const idxNewer = md.indexOf("Newer hard fact");
    const idxOlder = md.indexOf("Hard fact");
    expect(idxNewer).toBeGreaterThan(-1);
    expect(idxOlder).toBeGreaterThan(idxNewer);
  });

  it("truncates excerpts at 200 chars and emits short id suffix", () => {
    const long = "y".repeat(250);
    const md = renderInboxPage({
      scope: "global",
      generated_at: "2026-05-20T12:00:00Z",
      memories: [
        {
          memory_id: "longidaaaa",
          created_at: "2026-05-20T10:00:00Z",
          importance: 0.95,
          excerpt: long,
        },
      ],
    });
    expect(md).toContain(`${"y".repeat(200)}... \`#longidaa\``);
  });

  it("omits a tier section when it has zero memories", () => {
    const md = renderInboxPage({
      scope: "global",
      generated_at: "2026-05-20T12:00:00Z",
      memories: [mems[0]!],
    });
    expect(md).toContain("## core");
    expect(md).not.toContain("## working");
    expect(md).not.toContain("## peripheral");
  });

  it("renders an empty-state line when there are zero memories", () => {
    const md = renderInboxPage({
      scope: "global",
      generated_at: "2026-05-20T12:00:00Z",
      memories: [],
    });
    expect(md).toContain("count: 0");
    expect(md).toContain("*no orphan memories*");
  });
});
