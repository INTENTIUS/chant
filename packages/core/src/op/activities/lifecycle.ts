import { exec } from "node:child_process";
import { promisify } from "node:util";
import { computePlanDigest } from "../../lifecycle/plan-digest";

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
  /**
   * This diff's identity (#2300) — the change set `chant lifecycle diff`
   * reported, hashed. `ApplyOp` hands it to its gate step's `plan`, so an
   * approval binds to the change set the approver read rather than to the
   * next run of the Op.
   *
   * Computed over {@link normalizeDiffChangeSet}'s canonical form of
   * `output`, so incidental whitespace does not read as a changed plan, while
   * any added, removed or reworded row does.
   */
  planDigest: string;
}

/**
 * The change set half of a `chant lifecycle diff` render, canonicalised for
 * digesting (#2300).
 *
 * The diff render is line-oriented: section headers and the resource rows
 * under them. Two runs over an unchanged environment print the same lines, so
 * the lines are the change set. Normalising is deliberately minimal — CRLF to
 * LF, trailing whitespace off each line, blank lines dropped — because
 * anything more aggressive would start discarding rows, and a digest that
 * discards rows is a digest that approves changes nobody saw.
 *
 * Unlike a terraform plan there is no timestamp to strip: the diff render
 * carries none. If one is ever added it has to be dropped here, or every
 * approval would be stale the moment it was written.
 */
export function normalizeDiffChangeSet(output: string): string[] {
  return output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line !== "");
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
 * The identity of one `chant lifecycle diff` result (#2300). The environment
 * and the `--live` flag are hashed alongside the change set because they say
 * what the change set is *of*: the same rows against `staging` are not an
 * approval to apply against `prod`.
 */
function lifecycleDiffDigest(args: LifecycleDiffArgs, output: string): string {
  return computePlanDigest("lifecycle-diff", {
    env: args.env,
    live: args.live === true,
    changeSet: normalizeDiffChangeSet(output),
  });
}

/**
 * Run `chant lifecycle diff <env>` and return the output + structured drift
 * flag. Read-only; intended for use inside watch/observation Ops.
 * Uses fastIdempotent profile.
 *
 * The `drifted` field is computed by scanning the output for any of the
 * MISSING / ORPHAN / DRIFTED / DISAPPEARED section headers documented in
 * cli/state.mdx. Pair with `outcomeAttribute: { name: "Drift", from: "drifted" }`
 * on a WatchOp activity step to surface drift as the run's `Drift` outcome.
 */
export async function lifecycleDiff(args: LifecycleDiffArgs, signal?: AbortSignal): Promise<LifecycleDiffResult> {
  const liveFlag = args.live ? " --live" : "";
  try {
    const { stdout, stderr } = await execAsync(`chant lifecycle diff ${args.env}${liveFlag}`, { signal });
    const output = `${stdout}${stderr}`.trim();
    if (output) console.log(output);
    return { output, exitCode: 0, drifted: detectDrift(output), planDigest: lifecycleDiffDigest(args, output) };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    if (output) console.error(output);
    return { output, exitCode: e.code ?? 1, drifted: detectDrift(output), planDigest: lifecycleDiffDigest(args, output) };
  }
}
