/**
 * The cloud identities a generated pull-request pipeline takes (#4296): the
 * workspace declaration's `ci.identity.cloud`, resolved for the pipeline's
 * environment and member (../ci-identity.ts). Read from the working tree of
 * the workspace that holds `cwd`, as `ci.reportUrl` is (./ci-report-url.ts).
 * A directory outside a workspace reads nothing.
 */

import { findWorkspaceRoot } from "../project-root";
import { resolveCloudIdentity, resolvePrEnvCloudIdentity, type CloudTradeSpec, type PipelineCloudIdentity } from "../ci-identity";

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
