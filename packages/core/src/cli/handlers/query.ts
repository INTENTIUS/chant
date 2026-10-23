/**
 * `chant query "<sql>" [dir] [--member <name>] [--at <rev>] [--json]`
 * (#4297, #4329): one read-only SQL statement over what the local
 * `chant/lifecycle` branch holds. The tables and the engine live in
 * `../../lifecycle/query.ts` and the ledgers it reads in
 * `../../lifecycle/query-ledgers.ts`; this prints.
 *
 * Inside a workspace every member's ledger is read, each row naming its
 * member; `--member` keeps the members it names. Outside one the project's
 * own ledger is read and `member` is NULL. `--at` reads the branch at an
 * earlier commit. It reads the local branch and never fetches.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatError, formatWarning } from "../format";
import type { CommandContext } from "../registry";

const USAGE = 'chant query "<sql>" [dir] [--member <name>] [--at <rev>] [--json]';

export async function runQueryCommand(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const sql = args.positionals?.[0];
  if (sql === undefined || sql.trim() === "") {
    console.error(formatError({ message: "chant query needs a statement", hint: `${USAGE}, such as chant query "SELECT env, count(*) FROM resources GROUP BY env"` }));
    return 1;
  }
  const cwd = resolve(args.positionals?.[1] ?? ".");
  if (!existsSync(cwd)) {
    console.error(formatError({ message: `${cwd} does not exist`, hint: USAGE }));
    return 1;
  }
  if (args.at !== undefined && (typeof args.at !== "string" || args.at === "" || args.at.startsWith("-"))) {
    console.error(formatError({ message: "--at needs a revision of chant/lifecycle", hint: USAGE }));
    return 1;
  }
  const { loadQueryData, runQuery, formatQueryResult, QueryError } = await import("../../lifecycle/query");
  const { queryLedgers } = await import("../../lifecycle/query-ledgers");
  try {
    const { ledgers, at } = await queryLedgers(cwd, { members: args.members, ...(args.at !== undefined ? { at: String(args.at) } : {}) });
    const load = await loadQueryData(ledgers);
    const result = await runQuery(sql, load);
    if (args.json) {
      console.log(JSON.stringify(at === null ? result : { ...result, at }, null, 2));
    } else {
      console.log(formatQueryResult(result));
      if (at !== null) console.error(`read chant/lifecycle at ${at}`);
      const bad = Object.entries(result.malformed).filter(([, n]) => n > 0);
      if (bad.length > 0) console.error(formatWarning({ message: `left out what could not be read: ${bad.map(([t, n]) => `${n} in ${t}`).join(", ")}` }));
    }
    return 0;
  } catch (err) {
    if (err instanceof QueryError) {
      console.error(formatError({ message: err.message, hint: USAGE }));
      return 1;
    }
    throw err;
  }
}
