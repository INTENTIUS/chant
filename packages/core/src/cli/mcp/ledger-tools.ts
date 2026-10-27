/**
 * chant#4543 — the ledger reads of `chant serve mcp`: `ledger` and `query`.
 *
 * Served in both modes, and the reason the read-only mode is worth starting:
 * an agent gets the runs, gates, deploys, releases, cuts, resources and
 * snapshots on `chant/lifecycle` and the index store without a tool that can
 * change any of them.
 *
 * Each runs the CLI with the chant this server runs as, in the server's
 * directory, and returns the JSON document it printed, unchanged, the way the
 * workspace reads do (./workspace-tools.ts {@link runRead}):
 *
 * - `ledger` runs `chant ledger <table> ... --json`, the ledger read contract
 *   (`../handlers/ledger.ts`, #4363).
 * - `query` runs `chant query -- <sql> --json`, one read-only SQL statement
 *   over the same ledgers (`../handlers/query.ts`, #4297). The engine refuses
 *   anything but a read.
 *
 * Both read the local branch and never fetch.
 */

import type { ToolDefinition, ToolHandler } from "./types";
import { ownChantCommand, runRead, type ChantCommand } from "./workspace-tools";

/** The tables `chant ledger` reads, in its usage order. */
export const LEDGER_TABLES = ["resources", "snapshots", "runs", "gates", "deploys", "releases", "cuts"] as const;

class ToolInputError extends Error {}

function str(params: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = params[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolInputError(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string" || v === "") throw new ToolInputError(`${key} must be a non-empty string`);
  // A value is passed as one argument; one that starts with - would read as a flag.
  if (v.startsWith("-")) throw new ToolInputError(`${key} may not start with -: ${JSON.stringify(v)}`);
  return v;
}

function list(params: Record<string, unknown>, key: string): string[] {
  const v = params[key];
  if (v === undefined || v === null) return [];
  const items = typeof v === "string" ? [v] : v;
  if (!Array.isArray(items)) throw new ToolInputError(`${key} must be a string, or a list of them`);
  return items.map((item, i) => str({ [`${key}[${i}]`]: item }, `${key}[${i}]`, true)!);
}

const memberProp = {
  type: "array",
  items: { type: "string" },
  description: "Only these workspace members' ledgers (--member). Outside a workspace the project's own ledger is read.",
};

export const ledgerReadTools: ToolDefinition[] = [
  {
    name: "ledger",
    description:
      "One ledger's rows from the local chant/lifecycle branch: chant ledger <table> --json (#4363). Tables: " +
      LEDGER_TABLES.join(", ") +
      ". Inside a workspace every member's ledger is read and each row names its member. Returns the document unchanged; an error document is a document.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", enum: [...LEDGER_TABLES], description: "The ledger to read." },
        member: memberProp,
        where: {
          type: "array",
          items: { type: "string" },
          description: "Typed filters, each <field><op><value> such as state=failed (--where, repeatable).",
        },
        since: { type: "string", description: "Only rows at or after this time (--since)." },
        at: { type: "string", description: "Read the ledger as this commit of chant/lifecycle held it (--at)." },
      },
      required: ["table"],
    },
  },
  {
    name: "query",
    description:
      "One read-only SQL statement over the snapshots in the index store and the Op runs, gates, deploys and releases on the local chant/lifecycle branch: chant query <sql> --json (#4297). A statement that writes is refused. Returns the document unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "The SQL statement." },
        member: memberProp,
      },
      required: ["sql"],
    },
  },
];

/** The `chant` arguments each ledger tool runs, from its input. */
export function ledgerArgv(tool: string, params: Record<string, unknown>): string[] {
  const members = list(params, "member").flatMap((m) => ["--member", m]);
  switch (tool) {
    case "ledger": {
      const table = str(params, "table", true)!;
      if (!(LEDGER_TABLES as readonly string[]).includes(table)) throw new ToolInputError(`table must be one of ${LEDGER_TABLES.join(", ")}`);
      const where = list(params, "where").flatMap((w) => ["--where", w]);
      const flags = (["since", "at"] as const).flatMap((f) => {
        const v = str(params, f);
        return v !== undefined ? [`--${f}`, v] : [];
      });
      return ["ledger", table, ...members, ...where, ...flags, "--json"];
    }
    case "query": {
      // The statement is one argument after `--`, so text that opens with - stays SQL.
      const sql = params.sql;
      if (typeof sql !== "string" || sql.trim() === "") throw new ToolInputError("sql must be a non-empty string");
      return ["query", ...members, "--json", "--", sql];
    }
    default:
      throw new ToolInputError(`${tool} is not a ledger read tool`);
  }
}

/** The ledger read tools, bound to the server's directory. */
export function createLedgerTools(options: { cwd: string; chantCommand?: ChantCommand }): { definition: ToolDefinition; handler: ToolHandler }[] {
  const chant = options.chantCommand ?? ownChantCommand();
  return ledgerReadTools.map((definition) => ({
    definition,
    handler: async (params) => runRead(chant, ledgerArgv(definition.name, params), options.cwd),
  }));
}
