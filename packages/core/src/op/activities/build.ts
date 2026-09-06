import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface ChantBuildArgs {
  path: string;
  /** npm script to run. Default: `build`. Set e.g. `build:aws` to build one target. */
  script?: string;
  /** Optional extra env vars to pass to the build command. */
  env?: Record<string, string>;
}

/**
 * Run an npm build script (`build` by default) in the given project directory.
 * Uses fastIdempotent profile — 5m timeout, 3 retries.
 */
export async function chantBuild(args: ChantBuildArgs, signal?: AbortSignal): Promise<void> {
  const { stdout, stderr } = await execAsync(`npm run ${args.script ?? "build"}`, {
    cwd: args.path,
    env: { ...process.env, ...args.env },
    signal,
  });
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
}
