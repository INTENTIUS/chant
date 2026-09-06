import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface ChantTeardownArgs {
  /** Path to the chant project to tear down. */
  path: string;
}

/**
 * Run `chant teardown` in the given project path.
 * Uses longInfra profile — 20m timeout.
 */
export async function chantTeardown(args: ChantTeardownArgs, signal?: AbortSignal): Promise<void> {
  const { stdout, stderr } = await execAsync("npm run teardown", {
    cwd: args.path,
    signal,
  });
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
}
