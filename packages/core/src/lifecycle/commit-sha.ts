/**
 * The commit a run, a gate or a deploy is for (#4020), as one answer for every
 * record that carries it. The checkout's `HEAD` is what the process builds
 * from, so it comes first; a CI job whose checkout has no git (a bare
 * artifact job) falls back to the commit the forge says it started for.
 * Undefined when neither is known, so a record leaves the field out rather
 * than guessing.
 */

import { ciCommitFromEnv } from "../op/gate-run-locator";
import { getHeadCommit } from "./git";

export async function resolveCommitSha(
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<string | undefined> {
  try {
    const head = await getHeadCommit(opts.cwd ? { cwd: opts.cwd } : undefined);
    if (/^[0-9a-f]{40,64}$/.test(head)) return head;
  } catch {
    // Not a checkout, or no git on the path: the environment may still say.
  }
  return ciCommitFromEnv(opts.env);
}
