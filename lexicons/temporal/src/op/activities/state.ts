import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface StateSnapshotArgs {
  /** Environment name (e.g. "dev", "staging", "prod"). */
  env: string;
}

/**
 * Take a chant state snapshot for the given environment.
 * Uses fastIdempotent profile — 5m timeout, 3 retries.
 */
export async function stateSnapshot(args: StateSnapshotArgs): Promise<void> {
  const { stdout, stderr } = await execAsync(`chant state snapshot ${args.env}`);
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
}

export interface StateDiffArgs {
  /** Environment name (e.g. "dev", "staging", "prod"). */
  env: string;
  /**
   * When true, run `chant state diff <env> --live` (queries cloud APIs).
   * When false (default), run digest-only diff against the last snapshot.
   */
  live?: boolean;
}

export interface StateDiffResult {
  /** Combined stdout + stderr from the chant command. */
  output: string;
  /** Process exit code (0 = success). */
  exitCode: number;
}

/**
 * Run `chant state diff <env>` and return the output. Read-only; intended
 * for use inside watch/observation workflows. Uses fastIdempotent profile.
 *
 * Does not classify drift itself — callers can scan the output for the
 * MISSING / ORPHAN / DRIFTED / DISAPPEARED section headers documented in
 * cli/state.mdx.
 */
export async function stateDiff(args: StateDiffArgs): Promise<StateDiffResult> {
  const liveFlag = args.live ? " --live" : "";
  try {
    const { stdout, stderr } = await execAsync(`chant state diff ${args.env}${liveFlag}`);
    const output = `${stdout}${stderr}`.trim();
    if (output) console.log(output);
    return { output, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    if (output) console.error(output);
    return { output, exitCode: e.code ?? 1 };
  }
}
