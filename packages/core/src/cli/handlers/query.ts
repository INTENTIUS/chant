/**
 * `chant query "<sql>" [dir] [--member <name>] [--json]` (#4297): one
 * read-only SQL statement over the snapshots, Op runs, gates, deploys and
 * releases on the local `chant/lifecycle` branch. The tables and the engine
 * live in `../../lifecycle/query.ts`; this reads the ledgers and prints.
 *
 * Inside a workspace every member's ledger is read, each row naming its
 * member; `--member` keeps the members it names. Outside one the project's
 * own ledger is read and `member` is NULL. It reads the local branch and
 * never fetches.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatError, formatWarning } from "../format";
import type { CommandContext } from "../registry";
import type { QueryLedger } from "../../lifecycle/query";
import { findWorkspaceRoot } from "../../project-root";

const USAGE = 'chant query "<sql>" [dir] [--member <name>] [--json]';

/** The ledgers `chant query` reads from `cwd`: every member's in a workspace, else the project's own. */
export async function queryLedgers(cwd: string, members?: readonly string[]): Promise<QueryLedger[]> {
  const { gitLedgerReadPort } = await import("../../lifecycle/git");
  const found = findWorkspaceRoot(cwd);
  if (!found) return [{ member: null, port: gitLedgerReadPort({ cwd }) }];
  // Workspace code loads only when there is a workspace, so a level-0 project never pays for it.
  const { readDeclaration, WorkspaceReadError } = await import("../../workspace/declaration");
  const { workingTree } = await import("../../workspace/tree");
  const { QueryError } = await import("../../lifecycle/query");
  let declaration;
  try {
    declaration = readDeclaration(workingTree(found.dir), "");
  } catch (err) {
    if (err instanceof WorkspaceReadError) throw new QueryError(`${err.code}: ${err.message}`);
    throw err;
  }
  const wanted = members && members.length > 0 ? new Set(members) : null;
  if (wanted) {
    const unknown = [...wanted].filter((n) => !declaration.members.some((m) => m.name === n));
    if (unknown.length > 0) throw new QueryError(`--member ${unknown.join(", ")} names no member of the workspace`);
  }
  return declaration.members
    .filter((m) => !wanted || wanted.has(m.name))
    .map((m) => ({ member: m.name, port: gitLedgerReadPort({ cwd: found.dir, member: m.dir === "." ? "." : m.name }) }));
}

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
  const { loadQueryData, runQuery, formatQueryResult, QueryError } = await import("../../lifecycle/query");
  try {
    const load = await loadQueryData(await queryLedgers(cwd, args.members));
    const result = await runQuery(sql, load);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatQueryResult(result));
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
