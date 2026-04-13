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
