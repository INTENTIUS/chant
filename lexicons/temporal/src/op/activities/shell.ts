import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface ShellCmdArgs {
  cmd: string;
  /** Additional environment variables. */
  env?: Record<string, string>;
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
}

/**
 * Run an arbitrary shell command.
 * Uses fastIdempotent profile — 5m timeout, 3 retries.
 */
export async function shellCmd(args: ShellCmdArgs): Promise<string> {
  const { stdout, stderr } = await execAsync(args.cmd, {
    cwd: args.cwd,
    env: { ...process.env, ...args.env },
  });
  if (stderr) console.error(stderr);
  return stdout.trim();
}
