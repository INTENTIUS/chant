import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface ChantBuildArgs {
  path: string;
  /** Optional extra env vars to pass to the build command. */
  env?: Record<string, string>;
}

/**
 * Run `npm run build` in the given project directory.
 * Uses fastIdempotent profile — 5m timeout, 3 retries.
 */
export async function chantBuild(args: ChantBuildArgs): Promise<void> {
  const { stdout, stderr } = await execAsync("npm run build", {
    cwd: args.path,
    env: { ...process.env, ...args.env },
  });
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
}
