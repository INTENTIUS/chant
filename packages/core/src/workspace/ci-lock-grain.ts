/**
 * `ci.lockGrain` read at base (#4552), as `ci.locks` (./ci-locks.ts) and
 * `ci.workflow` (./ci-workflow-at.ts) are: the target branch's tip, so a
 * pull request cannot widen what its own apply may run beside.
 */
import type { CiLockGrain, Declaration } from "./declaration";
import { memberAtCwd } from "./security";
import { scopeSource } from "./write-scope";

/** The first chant that reads `ci.lockGrain`; a declaration that sets it needs this `minReader`. */
export const CI_LOCK_GRAIN_FLOOR = "0.124.55";

/** The grain a member takes from the declaration: its own `ci.lockGrain`, else the top level's, else null. */
export function lockGrainOf(declaration: Pick<Declaration, "ci" | "members">, member: string | null | undefined): CiLockGrain | null {
  const own = member ? declaration.members.find((m) => m.name === member)?.ciLockGrain : null;
  return own ?? declaration.ci?.lockGrain ?? null;
}

/**
 * The `ci.lockGrain` of the member holding `cwd`, or of `member` when given,
 * read at `at` when given, else at base, else from the working tree. Null
 * outside a workspace and when neither the member nor the top level sets one.
 */
export function ciLockGrainAt(cwd: string, at?: string, member?: string): CiLockGrain | null {
  const source = scopeSource(cwd, at);
  const d = source.declaration;
  if (!d) return null;
  return lockGrainOf(d, member ?? memberAtCwd(source, cwd));
}
