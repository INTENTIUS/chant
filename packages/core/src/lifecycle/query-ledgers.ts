/**
 * The ledgers `chant query` reads from a directory (#4297), moved here from
 * the CLI handler so a product's own query command reads the same ones
 * (#4329). Every member's ledger in a workspace, else the project's own, at
 * the branch tip or at the commit `at` names.
 */
import { gitLedgerReadPort, resolveLedgerCommit } from "./git";
import { QueryError, type QueryLedger } from "./query";
import { findWorkspaceRoot } from "../project-root";

export interface QueryLedgersOptions {
  /** Keep only these workspace members. Empty or absent keeps them all. */
  members?: readonly string[];
  /** Read the branch at this revision instead of its tip: a sha, a ref such as `chant/lifecycle~3`, or a date or time (`resolveLedgerCommit`, ./git.ts). */
  at?: string;
}

/** The ledgers to read from `cwd`, and the commit they are read at (null for the tip). */
export async function queryLedgers(cwd: string, options: QueryLedgersOptions = {}): Promise<{ ledgers: QueryLedger[]; at: string | null }> {
  const found = findWorkspaceRoot(cwd);
  const root = found?.dir ?? cwd;
  let at: string | null = null;
  if (options.at !== undefined) {
    at = await resolveLedgerCommit(options.at, { cwd: root });
    if (at === null) throw new QueryError(`--at ${options.at} names no commit of chant/lifecycle; give a sha, a ref such as chant/lifecycle~3, or a date such as 2026-10-01`);
  }
  const pin = at === null ? {} : { at };
  if (!found) return { ledgers: [{ member: null, port: gitLedgerReadPort({ cwd, ...pin }) }], at };
  // Workspace code loads only when there is a workspace, so a level-0 project never pays for it.
  const { readDeclaration, WorkspaceReadError } = await import("../workspace/declaration");
  const { workingTree } = await import("../workspace/tree");
  let declaration;
  try {
    declaration = readDeclaration(workingTree(found.dir), "");
  } catch (err) {
    if (err instanceof WorkspaceReadError) throw new QueryError(`${err.code}: ${err.message}`);
    throw err;
  }
  const members = options.members;
  const wanted = members && members.length > 0 ? new Set(members) : null;
  if (wanted) {
    const unknown = [...wanted].filter((n) => !declaration.members.some((m) => m.name === n));
    if (unknown.length > 0) throw new QueryError(`--member ${unknown.join(", ")} names no member of the workspace`);
  }
  const ledgers = declaration.members
    .filter((m) => !wanted || wanted.has(m.name))
    .map((m) => ({ member: m.name, port: gitLedgerReadPort({ cwd: found.dir, member: m.dir === "." ? "." : m.name, ...pin }) }));
  return { ledgers, at };
}
