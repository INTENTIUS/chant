/**
 * `ci.workflow` read at base (#4301, ws-106), as `ci.locks` is
 * (./ci-locks.ts): the target branch's tip, so a pull request that sets
 * `apply-before-merge` in its own copy of the declaration gets nothing from it.
 */
import type { CiWorkflow } from "./declaration";
import { workflowOf } from "./ci-workflow";
import { memberAtCwd } from "./security";
import { scopeSource } from "./write-scope";

/**
 * The workflow the member holding `cwd` follows, or `member` when given:
 * its own `ci.workflow`, else the top level's, read at `at` when given, else
 * at base, else from the working tree. Null outside a workspace and when
 * neither sets one.
 */
export function ciWorkflowAt(cwd: string, at?: string, member?: string): CiWorkflow | null {
  const source = scopeSource(cwd, at);
  const d = source.declaration;
  if (!d) return null;
  const name = member ?? memberAtCwd(source, cwd);
  return workflowOf(d, d.members.find((m) => m.name === name) ?? null);
}
