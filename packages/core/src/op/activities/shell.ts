import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface ShellCmdArgs {
  cmd: string;
  /** Additional environment variables. */
  env?: Record<string, string>;
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
  /**
   * Exit codes that count as success. Default `[0]`.
   *
   * Without this, `exitCode` in the result could only ever be `0` (#2413):
   * every other code rejects, so nothing downstream can read it. Naming the
   * codes a command uses to report a result — `diff`'s 1, `grep`'s 1,
   * a migration tool's "nothing to do" — turns them into a value a later
   * step can branch on instead of a failed Op.
   */
  okExit?: number[];
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
 * What a shell step publishes to the steps after it (#2413).
 *
 * `stdout` and `stderr` are trimmed, because the value an author wants from
 * `echo $(terraform output -raw host)` is the host, not the host plus a
 * newline, and a trailing newline in an `env` value or a gate argument is a
 * bug that is very hard to see.
 *
 * `stderr` is here as well as on the console. It was captured and dropped
 * before, so a command that reports on stderr — every tool that prints
 * progress there — had no route to a later step at all.
 */
export interface ShellCmdResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Node hangs the exit status off the error as `code`, and a signal kill as `signal`. */
interface ExecFailure extends Error {
  code?: number | string;
  signal?: string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

/**
 * Run an arbitrary shell command.
 *
 * Runs under the `atMostOnce` profile by default (#2411): one attempt, since
 * nothing here can know whether repeating the author's command is safe.
 */
export async function shellCmd(args: ShellCmdArgs, signal?: AbortSignal): Promise<ShellCmdResult> {
  const okExit = args.okExit ?? [0];
  try {
    const { stdout, stderr } = await execAsync(args.cmd, {
      cwd: args.cwd,
      env: { ...process.env, ...args.env },
      maxBuffer: MAX_STDOUT_BYTES,
      signal,
    });
    if (stderr) console.error(stderr);
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err) {
    const failure = err as ExecFailure;
    const exitCode = typeof failure.code === "number" ? failure.code : undefined;
    // A signal kill (Ctrl-C, the profile's timeout, a maxBuffer overflow) is
    // not an exit status the author declared anything about, so it rethrows
    // even if `okExit` happens to contain the code.
    const died = failure.killed === true || typeof failure.signal === "string" || signal?.aborted === true;
    if (exitCode !== undefined && !died && okExit.includes(exitCode)) {
      const stderrText = (failure.stderr ?? "").trim();
      if (stderrText) console.error(stderrText);
      return { stdout: (failure.stdout ?? "").trim(), stderr: stderrText, exitCode };
    }
    if (exitCode !== undefined && !died) {
      // `local-executor` records `error` as message text, so the code has to
      // be in the message or it is gone (#2413).
      failure.message = `command exited ${exitCode} (expected ${okExit.join(", ")}): ${failure.message}`;
    }
    throw failure;
  }
}
