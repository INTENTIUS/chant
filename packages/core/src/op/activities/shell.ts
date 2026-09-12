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
 * How much stdout a command may produce, matching every other exec site in
 * the tree (`../activities/apply.ts`, the terraform lexicon's activities,
 * `../../components/verbs/process-runner.ts`).
 *
 * Node's default is 1 MiB, and this was the only exec call leaving it unset
 * (#2412) — on the one activity whose output chant cannot predict, because
 * the command is the author's. A verbose test run, a playbook or a wide plan
 * passes 1 MiB without trying, and the overflow is a rejection rather than a
 * truncation, so the step fails for a reason that has nothing to do with the
 * command.
 */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

/**
 * Run an arbitrary shell command.
 *
 * Runs under the `atMostOnce` profile by default (#2411): one attempt, since
 * nothing here can know whether repeating the author's command is safe.
 */
export async function shellCmd(args: ShellCmdArgs, signal?: AbortSignal): Promise<string> {
  const { stdout, stderr } = await execAsync(args.cmd, {
    cwd: args.cwd,
    env: { ...process.env, ...args.env },
    maxBuffer: MAX_STDOUT_BYTES,
    signal,
  });
  if (stderr) console.error(stderr);
  return stdout.trim();
}
