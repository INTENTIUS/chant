/**
 * The cloud identities a generated pull-request pipeline takes (#4296): the
 * workspace declaration's `ci.identity.cloud`, resolved for the pipeline's
 * environment and member (../ci-identity.ts). Read from the working tree of
 * the workspace that holds `cwd`, as `ci.reportUrl` is (./ci-report-url.ts).
 * A directory outside a workspace reads nothing.
 */

import { relative, resolve, sep } from "node:path";
import { findWorkspaceRoot } from "../project-root";
import { resolveCloudIdentity, resolvePrEnvCloudIdentity, resolveTargetCloudIdentity, type CloudTradeSpec, type PipelineCloudIdentity } from "../ci-identity";

/** The plan and apply identities of the pipeline for `env` and `member`, or undefined. */
export async function declaredCloudIdentity(cwd: string, env: string, member?: string): Promise<PipelineCloudIdentity | undefined> {
  const found = findWorkspaceRoot(cwd);
  if (!found) return undefined;
  const [{ readDeclaration, WorkspaceReadError }, { workingTree }] = await Promise.all([import("./declaration"), import("./tree")]);
  try {
    return resolveCloudIdentity(readDeclaration(workingTree(found.dir)).ci?.identity?.cloud, env, member);
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    throw Object.assign(new Error(`${err.describe()} [${err.code}]`), { code: err.code });
  }
}

/** The trade a pull request environment's jobs take for `member` (#4330, `resolvePrEnvCloudIdentity`), or undefined. */
export async function declaredPrEnvCloudIdentity(cwd: string, member?: string): Promise<CloudTradeSpec | undefined> {
  const found = findWorkspaceRoot(cwd);
  if (!found) return undefined;
  const [{ readDeclaration, WorkspaceReadError }, { workingTree }] = await Promise.all([import("./declaration"), import("./tree")]);
  try {
    return resolvePrEnvCloudIdentity(readDeclaration(workingTree(found.dir)).ci?.identity?.cloud, member);
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    throw Object.assign(new Error(`${err.describe()} [${err.code}]`), { code: err.code });
  }
}

/**
 * The plan and apply identities of each target (#4332,
 * `resolveTargetCloudIdentity`) for `env` and the member whose directory
 * holds `cwd`, as one lookup that reads the declaration once. Undefined
 * outside a workspace. A lexicon that runs several targets in one process,
 * such as `terraform-apply`'s group (#4447), compares them with it.
 */
export async function declaredTargetCloudIdentity(cwd: string, env: string): Promise<((target: string) => PipelineCloudIdentity | undefined) | undefined> {
  const found = findWorkspaceRoot(cwd);
  if (!found) return undefined;
  const [{ readDeclaration, WorkspaceReadError }, { workingTree }, { memberHolding }] = await Promise.all([import("./declaration"), import("./tree"), import("./record-assets")]);
  try {
    const declaration = readDeclaration(workingTree(found.dir));
    const decl = declaration.ci?.identity?.cloud;
    const rel = relative(found.dir, resolve(cwd));
    const posix = sep === "/" ? rel : rel.split(sep).join("/");
    const member = rel.startsWith("..") ? null : memberHolding(posix === "" ? "." : posix, declaration.members ?? []);
    return (target) => resolveTargetCloudIdentity(decl, env, member ?? undefined, target);
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    throw Object.assign(new Error(`${err.describe()} [${err.code}]`), { code: err.code });
  }
}
