import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface ChantTeardownArgs {
  /** Path to the chant project to tear down. */
  path: string;
}

/**
 * Run `chant teardown` in the given project path.
 * Uses longInfra profile — 20m timeout, heartbeat every 60s.
 */
export async function chantTeardown(args: ChantTeardownArgs): Promise<void> {
  const { stdout, stderr } = await execAsync("npm run teardown", {
    cwd: args.path,
  });
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
}
