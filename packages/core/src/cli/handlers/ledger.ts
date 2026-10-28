/**
 * `chant ledger <table> [dir] [--member <name>] [--where <field><op><value>]...
 * [--since <time>] [--at <rev>] [--json]` (#4363): one ledger's rows from the
 * local `chant/lifecycle` branch, filtered with typed filters. The read and
 * its contract live in `../../lifecycle/ledger-read.ts`; the ledgers are read
 * as `chant query` reads them (`./query.ts` {@link queryLedgers}).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatError, formatWarning } from "../format";
import type { CommandContext } from "../registry";
import { queryLedgers } from "./query";

const USAGE = "chant ledger <resources|snapshots|runs|gates|deploys|releases|cuts|applies|pr_envs|control_entries|release_status> [dir] [--member <name>] [--where <field><op><value>]... [--since <time>] [--at <rev>] [--json]";

const cell = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export async function runLedgerCommand(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const table = args.positionals?.[0];
  if (table === undefined || table.trim() === "") {
    console.error(formatError({ message: "chant ledger needs a table", hint: USAGE }));
    return 1;
  }
  const cwd = resolve(args.positionals?.[1] ?? ".");
  if (!existsSync(cwd)) {
    console.error(formatError({ message: `${cwd} does not exist`, hint: USAGE }));
    return 1;
  }
  const { readLedgerTable, ledgerReadFailure, LedgerRevisionError } = await import("../../lifecycle/ledger-read");
  const { QueryError } = await import("../../lifecycle/query");
  let doc;
  try {
    doc = await readLedgerTable(table, () => queryLedgers(cwd, args.members, args.at), { where: args.where, since: args.since, at: args.at ?? null });
  } catch (err) {
    if (err instanceof LedgerRevisionError) doc = ledgerReadFailure("revision-unknown", err.message);
    else if (err instanceof QueryError) doc = ledgerReadFailure("ledger-unreadable", err.message);
    else throw err;
  }
  if (args.json) {
    console.log(JSON.stringify(doc, null, 2));
    return "error" in doc ? 1 : 0;
  }
  if ("error" in doc) {
    console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
    return 1;
  }
  const widths = doc.columns.map((c) => Math.max(c.length, ...doc.rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]): string => vals.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  console.log([line(doc.columns), line(widths.map((w) => "-".repeat(w))), ...doc.rows.map((r) => line(doc.columns.map((c) => cell(r[c]))))].join("\n"));
  console.log(`(${doc.rows.length} of ${doc.total} ${doc.total === 1 ? "row" : "rows"})`);
  if (doc.malformed > 0) console.error(formatWarning({ message: `left out ${doc.malformed} in ${doc.table} that could not be read` }));
  return 0;
}
