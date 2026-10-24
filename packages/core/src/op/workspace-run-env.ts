/**
 * How a member's `chant run` learns that `chant workspace run` started it
 * (#2554, #2524 D17). The workspace run sets these in the environment of the
 * member's chant; the member's run record cites the workspace run, and a
 * member gate may then ask the named workspace gate to stand in for it.
 *
 * Kept apart from the workspace code so the executor reads two environment
 * variables and nothing more when no workspace run started it.
 */

/** The workspace run's id. */
export const WORKSPACE_RUN_ENV = "CHANT_WORKSPACE_RUN";
/** The workspace gate the run was started under, when one was named. */
export const WORKSPACE_GATE_ENV = "CHANT_WORKSPACE_GATE";

/** What a run started by a workspace run knows about it. */
export interface WorkspaceRunCitation {
  id: string;
  /** The workspace gate the run was started under (`chant workspace run --gate`), when one was named. */
  gate?: string;
}

/** The workspace run this process runs under, or undefined. */
export function resolveWorkspaceRun(env: NodeJS.ProcessEnv = process.env): WorkspaceRunCitation | undefined {
  const id = env[WORKSPACE_RUN_ENV]?.trim();
  if (!id) return undefined;
  const gate = env[WORKSPACE_GATE_ENV]?.trim();
  return { id, ...(gate ? { gate } : {}) };
}
