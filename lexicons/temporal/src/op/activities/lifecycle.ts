import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface LifecycleSnapshotArgs {
  /** Environment name (e.g. "dev", "staging", "prod"). */
  env: string;
}

/**
 * Take a chant lifecycle snapshot for the given environment.
 * Uses fastIdempotent profile — 5m timeout, 3 retries.
 */
export async function lifecycleSnapshot(args: LifecycleSnapshotArgs, signal?: AbortSignal): Promise<void> {
  const { stdout, stderr } = await execAsync(`chant lifecycle snapshot ${args.env}`, { signal });
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
}

export interface LifecycleDiffArgs {
  /** Environment name (e.g. "dev", "staging", "prod"). */
  env: string;
  /**
   * When true, run `chant lifecycle diff <env> --live` (queries cloud APIs).
   * When false (default), run digest-only diff against the last snapshot.
   */
  live?: boolean;
}

export interface LifecycleDiffResult {
  /** Combined stdout + stderr from the chant command. */
  output: string;
  /** Process exit code (0 = success). */
  exitCode: number;
  /**
   * True when the diff output contains any drift indicators
   * (MISSING / ORPHAN / DRIFTED / DISAPPEARED section headers from
   * `chant lifecycle diff --live`).
   */
  drifted: boolean;
}

/**
 * Section headers emitted by `chant lifecycle diff --live` that indicate a
 * non-empty drift category. See packages/core/src/cli/handlers/state.ts.
 */
const DRIFT_HEADERS = [
  "MISSING",
  "ORPHAN",
  "DISAPPEARED",
  "DRIFTED",
  "ARTIFACTS ADDED",
  "ARTIFACTS REMOVED",
  "ARTIFACTS CHANGED",
];

function detectDrift(output: string): boolean {
  return DRIFT_HEADERS.some((h) => output.includes(`${h} (`) || output.includes(`\n${h}`));
}

/**
 * Run `chant lifecycle diff <env>` and return the output + structured drift
 * flag. Read-only; intended for use inside watch/observation workflows.
 * Uses fastIdempotent profile.
 *
 * The `drifted` field is computed by scanning the output for any of the
 * MISSING / ORPHAN / DRIFTED / DISAPPEARED section headers documented in
 * cli/state.mdx. Pair with `outcomeAttribute: { name: "Drift", from: "drifted" }`
 * on a WatchOp activity step to surface drift as a workflow search attribute.
 */
export async function lifecycleDiff(args: LifecycleDiffArgs, signal?: AbortSignal): Promise<LifecycleDiffResult> {
  const liveFlag = args.live ? " --live" : "";
  try {
    const { stdout, stderr } = await execAsync(`chant lifecycle diff ${args.env}${liveFlag}`, { signal });
    const output = `${stdout}${stderr}`.trim();
    if (output) console.log(output);
    return { output, exitCode: 0, drifted: detectDrift(output) };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    if (output) console.error(output);
    return { output, exitCode: e.code ?? 1, drifted: detectDrift(output) };
  }
}
