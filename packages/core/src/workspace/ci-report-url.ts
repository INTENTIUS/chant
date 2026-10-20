/**
 * The report URL a command uses (#4160): `--report-url` when it is given,
 * else the workspace declaration's `ci.reportUrl`, else none.
 *
 * `chant build --pr-loop`, `chant ci run`, `chant ci serve` and `chant ci
 * runs` call this. The declaration is read from the working tree of the
 * workspace that holds `cwd`. A directory with no declaration between it and
 * the git root reads nothing and loads no declaration module, so a project
 * outside a workspace behaves as before. A declaration that can't be read
 * is an error naming its place and its reason code, such as
 * `declaration-invalid`, since the command would otherwise run without the
 * URL the workspace may declare.
 */

import { findWorkspaceRoot } from "../project-root";

/** The declared `ci.reportUrl` of the workspace holding `cwd`, or undefined. */
export async function declaredReportUrl(cwd: string): Promise<string | undefined> {
  const found = findWorkspaceRoot(cwd);
  if (!found) return undefined;
  const [{ readDeclaration, WorkspaceReadError }, { workingTree }] = await Promise.all([import("./declaration"), import("./tree")]);
  try {
    return readDeclaration(workingTree(found.dir)).ci?.reportUrl ?? undefined;
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    throw Object.assign(new Error(`${err.describe()} [${err.code}]`), { code: err.code });
  }
}

/** `flag` when given, else the declared `ci.reportUrl` (#4160). */
export async function reportUrlOf(flag: string | undefined, cwd: string): Promise<string | undefined> {
  return flag ?? (await declaredReportUrl(cwd));
}
