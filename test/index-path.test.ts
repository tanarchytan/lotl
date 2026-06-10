/**
 * index-path.test.ts — INDEX_PATH override creates its parent directory.
 *
 * Per-project isolation points a project-scoped MCP server at its own DB via
 * INDEX_PATH=<repo>/.lotl/index.sqlite. On first run that directory doesn't
 * exist yet and better-sqlite3 won't create it, so getDefaultDbPath() must
 * mkdir the parent. Guards the "just works on a fresh repo" behaviour.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultDbPath } from "../src/store/path.js";

describe("getDefaultDbPath — INDEX_PATH parent dir", () => {
  let saved: string | undefined;
  let tmp: string;

  beforeEach(() => {
    saved = process.env.INDEX_PATH;
    tmp = mkdtempSync(join(tmpdir(), "lotl-idxpath-"));
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.INDEX_PATH;
    else process.env.INDEX_PATH = saved;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("creates a not-yet-existing parent directory", () => {
    const nested = join(tmp, ".lotl", "index.sqlite");
    process.env.INDEX_PATH = nested;
    expect(existsSync(join(tmp, ".lotl"))).toBe(false);

    const result = getDefaultDbPath();

    expect(result).toBe(nested);
    expect(existsSync(join(tmp, ".lotl"))).toBe(true); // parent created
  });

  test("returns the path verbatim and is idempotent on an existing dir", () => {
    const flat = join(tmp, "index.sqlite"); // parent (tmp) already exists
    process.env.INDEX_PATH = flat;
    expect(getDefaultDbPath()).toBe(flat);
    expect(getDefaultDbPath()).toBe(flat); // second call fine
  });
});
