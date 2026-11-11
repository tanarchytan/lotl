/**
 * Conflict resolution guard (LOTL_MEMORY_CONFLICT=guarded). Non-destructive:
 * the existing row is never deleted or rewritten (DELETE and UPDATE become
 * ADD), and the incoming memory is dropped as a duplicate only when every word
 * token of it is already in the existing text and no negation is lost.
 * Pure functions, no LLM.
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import {
  guardConflict, parseConflictAction, conflictMode, resolveConflict, wordTokens, coveredBy,
} from "../src/memory/conflict.js";

const VM104 = "Restore test of VM 104 (paperless) took 23 minutes for 41 GB.";
const VM105 = "Restore test of VM 105 (immich) took 58 minutes for 120 GB.";

describe("wordTokens / coveredBy", () => {
  test("dotted numbers, versions and paths stay one token", () => {
    expect([...wordTokens("Zitadel v4.21.1 at /opt/x/y.txt, 0.82 s, LOTL_ONNX=off.")]).toEqual(
      expect.arrayContaining(["zitadel", "v4.21.1", "opt/x/y.txt", "0.82", "lotl_onnx", "off"]),
    );
  });
  test("token sets, not substrings: 80 does not cover 8080", () => {
    expect(coveredBy("The API listens on port 8080.", "The API listens on port 80.")).toBe(false);
  });
  test("1.2 and 2.1 are different tokens", () => {
    expect(coveredBy("piper 2.1", "piper 1.2")).toBe(false);
  });
  test("a shorter restatement is covered", () => {
    expect(coveredBy("The deploy pipeline runs every night.", "the deploy pipeline runs every night at 02:00")).toBe(true);
  });
  test("losing a negation is never covered", () => {
    expect(coveredBy("Backups to B2 are encrypted.", "Backups to B2 are not encrypted.")).toBe(false);
    expect(coveredBy("Backups naar B2 zijn versleuteld.", "Backups naar B2 zijn niet versleuteld.")).toBe(false);
  });
});

describe("guardConflict", () => {
  test("DELETE never removes the existing memory: becomes ADD", () => {
    const g = guardConflict({ action: "DELETE", raw: "DELETE" }, "Zitadel runs v4.15.0.", "Zitadel runs v4.21.1.");
    expect(g.action).toBe("ADD");
    expect(g.guarded).toMatch(/delete/i);
  });

  test("UPDATE never rewrites the existing memory, even with a lossless merge", () => {
    const g = guardConflict(
      { action: "UPDATE", merged: "Proxmox backups go to restic on the Hetzner storage box daily at 02:30.", raw: "UPDATE" },
      "Proxmox backups go to restic on the Hetzner storage box.",
      "Proxmox backups go to restic on the Hetzner storage box daily at 02:30.");
    expect(g).toEqual({ action: "ADD", guarded: expect.stringMatching(/update blocked/) });
  });

  test("review scenario: prose UPDATE (tea -> coffee) keeps both", () => {
    const g = guardConflict({ action: "UPDATE", merged: "David prefers coffee in the morning", raw: "UPDATE" },
      "David prefers tea in the morning", "David prefers coffee in the morning");
    expect(g.action).toBe("ADD");
  });

  test("review scenario: port 80 vs 8080 UPDATE keeps both", () => {
    expect(guardConflict({ action: "UPDATE", merged: "The API listens on port 8080.", raw: "UPDATE" },
      "The API listens on port 80.", "The API listens on port 8080.").action).toBe("ADD");
  });

  test("review scenario: NONE on an added negation stores the new memory", () => {
    expect(guardConflict({ action: "NONE", raw: "NONE" }, "Backups to B2 are encrypted", "Backups to B2 are not encrypted").action).toBe("ADD");
  });

  test("NONE that would drop new numbers becomes ADD", () => {
    expect(guardConflict({ action: "NONE", raw: "NONE" }, VM104, VM105).action).toBe("ADD");
  });

  test("NONE on a paraphrase with new words stores it (near-duplicate is the price)", () => {
    expect(guardConflict({ action: "NONE", raw: "NONE" }, "lotl recall hook passes --min-relevance 0.6.", "The lotl recall hook uses --min-relevance 0.6.").action).toBe("ADD");
  });

  test("NONE when every incoming token is in the existing text stays NONE", () => {
    expect(guardConflict({ action: "NONE", raw: "NONE" }, "The deploy pipeline runs every night at 02:00.", "the deploy pipeline runs every night").action).toBe("NONE");
  });

  test("null reply (timeout, HTTP error, no provider) gets the same rule", () => {
    expect(guardConflict({ action: null, raw: null }, VM104, VM105).action).toBe("ADD");
    expect(guardConflict({ action: null, raw: null }, "The deploy pipeline runs every night.", "the deploy pipeline runs every night").action).toBe("NONE");
  });

  test("an unparsed reply gets the same rule", () => {
    expect(guardConflict({ action: null, raw: "I think these are different." }, VM104, VM105).action).toBe("ADD");
  });

  test("ADD passes through", () => {
    expect(guardConflict({ action: "ADD", raw: "ADD" }, VM104, VM105).action).toBe("ADD");
  });
});

describe("resolveConflict", () => {
  test("merge: false never sends the merge prompt", async () => {
    const prompts: string[] = [];
    const d = await resolveConflict("a b c", "a b c d", async (p) => { prompts.push(p); return "UPDATE"; }, { merge: false });
    expect(d.action).toBe("UPDATE");
    expect(d.merged).toBeUndefined();
    expect(prompts).toHaveLength(1);
  });
  test("default asks for the merge on UPDATE and drops a too-short merge", async () => {
    const d = await resolveConflict("a", "b", async (p) => (p.startsWith("Compare") ? "UPDATE" : "short"));
    expect(d.action).toBe("UPDATE");
    expect(d.merged).toBeUndefined();
    const ok = await resolveConflict("a", "b", async (p) => (p.startsWith("Compare") ? "UPDATE" : " merged statement here "));
    expect(ok.merged).toBe("merged statement here");
  });
});

describe("parseConflictAction", () => {
  test("strict one-word replies, case-insensitive", () => {
    expect(parseConflictAction(" update ")).toBe("UPDATE");
    expect(parseConflictAction("ADD")).toBe("ADD");
    expect(parseConflictAction("Action: ADD")).toBeNull();
    expect(parseConflictAction(null)).toBeNull();
  });
});

describe("conflictMode", () => {
  const saved = process.env.LOTL_MEMORY_CONFLICT;
  afterEach(() => {
    if (saved === undefined) delete process.env.LOTL_MEMORY_CONFLICT; else process.env.LOTL_MEMORY_CONFLICT = saved;
    vi.restoreAllMocks();
  });

  test("unset or empty is llm (unchanged for existing users)", () => {
    delete process.env.LOTL_MEMORY_CONFLICT;
    expect(conflictMode()).toBe("llm");
    process.env.LOTL_MEMORY_CONFLICT = "  ";
    expect(conflictMode()).toBe("llm");
  });

  test("llm, guarded and off accepted, trimmed, any case", () => {
    process.env.LOTL_MEMORY_CONFLICT = " Guarded ";
    expect(conflictMode()).toBe("guarded");
    process.env.LOTL_MEMORY_CONFLICT = "OFF";
    expect(conflictMode()).toBe("off");
    process.env.LOTL_MEMORY_CONFLICT = "llm";
    expect(conflictMode()).toBe("llm");
  });

  test("unknown value warns once on stderr and uses guarded", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.LOTL_MEMORY_CONFLICT = "guard-typo-1";
    expect(conflictMode()).toBe("guarded");
    expect(conflictMode()).toBe("guarded");
    const warnings = err.mock.calls.map(c => String(c[0])).filter(s => s.includes("LOTL_MEMORY_CONFLICT"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/guard-typo-1.*guarded/);
  });
});
