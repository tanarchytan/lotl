// src/cli/vault-commands.ts
// CLI handlers for `lotl vault export|status`. Subsystem 1 (v1.2.0-alpha.1).

import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { getDb } from "./db-state.js";
import {
  createSqliteDataSource,
  exportAllScopes,
  resolveVaultRoot,
  vaultStatus,
} from "../vault/export.js";
import { info, success, warn } from "./terminal.js";

interface ParsedArgs {
  sub: string;
  scope?: string;
  force: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [sub, ...rest] = argv;
  let scope: string | undefined;
  let force = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--scope") {
      scope = rest[i + 1];
      i += 1;
    } else if (arg === "--force") {
      force = true;
    } else if (arg && arg.startsWith("--scope=")) {
      scope = arg.slice("--scope=".length);
    }
  }
  return { sub: sub ?? "", scope, force };
}

export async function runVaultCommand(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  switch (args.sub) {
    case "export":
      return runVaultExport(args);
    case "status":
      return runVaultStatus();
    case "":
    case "help":
    case "--help":
      printUsage();
      return 0;
    default:
      warn(`[vault] unknown subcommand: ${args.sub}`);
      printUsage();
      return 2;
  }
}

function printUsage(): void {
  console.log(info("Usage: lotl vault <export|status> [--scope X] [--force]"));
}

async function runVaultExport(args: ParsedArgs): Promise<number> {
  const db = getDb() as BetterSqlite3Database;
  const dataSource = createSqliteDataSource(db);
  const vaultRoot = resolveVaultRoot();
  console.log(info(`[vault:export] vault root: ${vaultRoot}`));

  const summary = await exportAllScopes({
    dataSource,
    vaultRoot,
    onlyScope: args.scope,
    force: args.force,
  });

  const scopes = Object.keys(summary);
  if (scopes.length === 0) {
    console.log(warn("[vault:export] no scopes found in KG — nothing to export."));
    return 0;
  }

  for (const scope of scopes) {
    const r = summary[scope]!;
    if (r.skipped) {
      console.log(info(`[vault:export] ${scope}: skipped (hash unchanged)`));
    } else {
      console.log(
        success(
          `[vault:export] ${scope}: wrote ${r.entityCount} entities, ${r.memoryCount} orphan memories`,
        ),
      );
    }
  }
  return 0;
}

async function runVaultStatus(): Promise<number> {
  const db = getDb() as BetterSqlite3Database;
  const dataSource = createSqliteDataSource(db);
  const vaultRoot = resolveVaultRoot();
  const report = await vaultStatus({ dataSource, vaultRoot });
  console.log(info(`vault root: ${report.vault_root}`));
  if (report.scopes.length === 0) {
    console.log(info("(no scopes)"));
    return 0;
  }
  for (const row of report.scopes) {
    console.log(
      info(
        `  - ${row.scope}: kg_count=${row.kg_count} ` +
          `last_export=${row.last_export_at ?? "(never)"} ` +
          `vault_dir=${row.vault_dir_present ? "yes" : "no"}`,
      ),
    );
  }
  return 0;
}
