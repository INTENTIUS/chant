/**
 * `ci.locks` (#4293): when a pull request takes its target locks
 * (../lifecycle/target-lock.ts). Read from the declaration at base, the
 * target branch's tip, as the security groups are (./security.ts), so a
 * pull request cannot turn its own locks off. Null outside a workspace and
 * when the declaration sets none.
 */
import type { CiLocks } from "./declaration";
import { scopeSource } from "./write-scope";

export const CI_LOCKS = ["apply", "plan"] as const satisfies readonly CiLocks[];

/** The `ci.locks` of the workspace holding `cwd`, read at `at` when given, else at base, else from the working tree. */
export function ciLocksAt(cwd: string, at?: string): CiLocks | null {
  return scopeSource(cwd, at).declaration?.ci?.locks ?? null;
}
