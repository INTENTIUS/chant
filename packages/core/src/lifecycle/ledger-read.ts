/**
 * `chant ledger <table>` (#4363): the rows of one ledger on `chant/lifecycle`
 * as a JSON read contract (`workspace/ledger.schema.json`), filtered with
 * `--where`, `--since` and `--at` instead of SQL.
 *
 * The tables, their columns and the rows are the ones `chant query` loads
 * (`./query.ts` {@link QUERY_TABLES}, {@link loadQueryData}), so the two
 * agree on every row. A column `chant query` keeps as JSON text is an object
 * or array here. No SQL engine loads.
 *
 * `--since <time>` keeps the rows whose time column ({@link LEDGER_TIME_COLUMN})
 * is at or after it. `--at <rev>` reads the ledger as the commit `rev` of
 * `chant/lifecycle` held it ({@link revisionLedgerReadPort}).
 *
 * Everything here but {@link revisionLedgerReadPort} is pure over a
 * {@link LedgerReadPort}, so a product that reads the branch its own way
 * (terragucci, behold) supplies its own port.
 */
import { execFileSync } from "node:child_process";
import { FilterError, matchesWhere, parseSince, parseWhere, type FilterFields, type FilterFieldType } from "../read-filter";
import type { ReasonCode } from "../workspace/reason-codes";
import type { LedgerReadPort } from "./ledger-port";
import { loadQueryData, QUERY_TABLES, type QueryLedger, type QueryRow, type QueryTable } from "./query";

/** The version of the `ledger` document this chant writes. */
export const LEDGER_READ_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for `chant ledger --json`. */
export const LEDGER_READ_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/ledger/v1/ledger.schema.json";

/** The tables, in the order `chant query` lists them. */
export const LEDGER_TABLES = Object.keys(QUERY_TABLES) as QueryTable[];

/** The column `--since` compares, per table; null for a table with no time of its own. */
export const LEDGER_TIME_COLUMN: Record<QueryTable, string | null> = {
  resources: "observed_at",
  snapshots: "observed_at",
  runs: "started",
  gates: "timestamp",
  deploys: "timestamp",
  releases: null,
  cuts: "timestamp",
  applies: "timestamp",
  pr_envs: "timestamp",
  release_status: "timestamp",
};

/** The columns that hold JSON, which this read prints parsed. */
const JSON_COLUMNS = new Set(["attributes", "labels", "outcomes", "promoted_from", "restores", "redeploys", "artifacts", "wave", "request", "detail", "components", "approvers"]);
/** The columns that hold an ISO instant. */
const TIME_COLUMNS = new Set(["last_updated", "observed_at", "started", "ended", "timestamp", "expires_at", "approved_at", "finished_at"]);
/** INTEGER columns that hold 0 or 1, which this read prints as booleans. */
const BOOLEAN_COLUMNS = new Set(["signed", "empty"]);

/** The fields `--where` takes on a table: its columns, typed. */
export function ledgerFields(table: QueryTable): FilterFields {
  const out: Record<string, FilterFieldType> = {};
  for (const [name, sqlType] of QUERY_TABLES[table]) {
    out[name] = BOOLEAN_COLUMNS.has(name) ? "boolean" : sqlType === "INTEGER" ? "number" : JSON_COLUMNS.has(name) ? "json" : TIME_COLUMNS.has(name) ? "time" : "text";
  }
  return out;
}

export type LedgerValue = string | number | boolean | null | Record<string, unknown> | unknown[];
export type LedgerRow = Record<string, LedgerValue>;

/** The row as the contract prints it: JSON columns parsed, 0/1 columns as booleans. */
function contractRow(table: QueryTable, row: QueryRow): LedgerRow {
  const out: LedgerRow = {};
  for (const [name] of QUERY_TABLES[table]) {
    const v = row[name] ?? null;
    if (v !== null && JSON_COLUMNS.has(name) && typeof v === "string") {
      try {
        out[name] = JSON.parse(v) as LedgerValue;
      } catch {
        out[name] = v;
      }
    } else if (BOOLEAN_COLUMNS.has(name) && typeof v === "number") out[name] = v === 1;
    else out[name] = v;
  }
  return out;
}

export interface LedgerReadOptions {
  where?: readonly string[];
  /** An ISO date or time, or a span back from now such as `7d`. */
  since?: string;
  /** The revision of `chant/lifecycle` the ports read, as given; only echoed here. */
  at?: string | null;
  now?: Date;
}

export type LedgerReadDocument =
  | {
      $schema: string;
      contract: number;
      table: QueryTable;
      /** The table's columns, in order. */
      columns: string[];
      at: string | null;
      filter: { where: string[]; since: string | null };
      /** Rows in the table before the filter. */
      total: number;
      rows: LedgerRow[];
      /** Lines and files of this table that could not be read as their kind, left out. */
      malformed: number;
    }
  | { $schema: string; contract: number; error: { code: LedgerReadErrorCode; message: string } };

/** Why the read printed no rows. Closed. */
export const LEDGER_READ_ERROR_CODES = ["filter-invalid", "table-unknown", "revision-unknown", "ledger-unreadable"] as const satisfies readonly ReasonCode[];
export type LedgerReadErrorCode = (typeof LEDGER_READ_ERROR_CODES)[number];

const head = { $schema: LEDGER_READ_SCHEMA_ID, contract: LEDGER_READ_CONTRACT_VERSION };

/** A failure document. */
export function ledgerReadFailure(code: LedgerReadErrorCode, message: string): LedgerReadDocument {
  return { ...head, error: { code, message } };
}

/** Read one table from the ledgers and filter it. A bad table or filter is a failure document, before anything is read. */
export async function readLedgerTable(table: string, ledgers: readonly QueryLedger[] | (() => Promise<readonly QueryLedger[]>), opts: LedgerReadOptions = {}): Promise<LedgerReadDocument> {
  if (!(LEDGER_TABLES as string[]).includes(table)) return ledgerReadFailure("table-unknown", `no table ${JSON.stringify(table)}; the tables are ${LEDGER_TABLES.join(", ")}`);
  const t = table as QueryTable;
  let clauses;
  let since: string | null = null;
  try {
    clauses = parseWhere(opts.where ?? [], ledgerFields(t), opts.now);
    if (opts.since !== undefined) {
      if (LEDGER_TIME_COLUMN[t] === null) throw new FilterError(`--since: ${t} has no time column; filter it with --where`);
      since = parseSince(opts.since, opts.now);
    }
  } catch (err) {
    if (err instanceof FilterError) return ledgerReadFailure("filter-invalid", err.message);
    throw err;
  }
  const load = await loadQueryData(typeof ledgers === "function" ? await ledgers() : ledgers);
  const all = load.data[t].map((r) => contractRow(t, r));
  const timeCol = LEDGER_TIME_COLUMN[t];
  const sinceMs = since === null ? null : Date.parse(since);
  const rows = all.filter((r) => {
    if (sinceMs !== null && timeCol !== null) {
      const v = r[timeCol];
      if (typeof v !== "string" || !(Date.parse(v) >= sinceMs)) return false;
    }
    return matchesWhere(r, clauses);
  });
  return {
    ...head,
    table: t,
    columns: QUERY_TABLES[t].map(([c]) => c),
    at: opts.at ?? null,
    filter: { where: [...(opts.where ?? [])], since },
    total: all.length,
    rows,
    malformed: load.malformed[t],
  };
}

/** Thrown by {@link resolveLedgerRevision} for a revision git can't resolve. */
export class LedgerRevisionError extends Error {}

/** The commit `rev` names in the repository at `cwd`. Throws a {@link LedgerRevisionError}. */
export function resolveLedgerRevision(cwd: string, rev: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new LedgerRevisionError(`--at ${rev} names no commit here; give a commit of chant/lifecycle, such as chant/lifecycle~3`);
  }
}

/**
 * A port over the ledger as the commit `commit` holds it, under `prefix`
 * (`""`, or `_members/<member>/` per level). It never fetches.
 */
export function revisionLedgerReadPort(cwd: string, commit: string, prefix: string): LedgerReadPort {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
    } catch {
      return null;
    }
  };
  const lsTree = (path: string, nameOnly: boolean): string[] => {
    const spec = path === "" ? commit : `${commit}:${path}`;
    const out = git(["ls-tree", "--full-tree", ...(nameOnly ? ["--name-only"] : []), spec]);
    return out === null ? [] : out.split("\n").filter(Boolean);
  };
  return {
    read: async (dir, file) => git(["show", `${commit}:${prefix}${dir}/${file}`]),
    list: async (dir) => lsTree(`${prefix}${dir}`, true),
    trees: async () =>
      lsTree(prefix.replace(/\/$/, ""), false)
        .map((line) => /^\d+\s+(\w+)\s+[0-9a-f]+\t(.+)$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null && m[1] === "tree")
        .map((m) => m[2]),
  };
}
