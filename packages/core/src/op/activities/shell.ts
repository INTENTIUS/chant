import { exec } from "node:child_process";
import { promisify } from "node:util";
import { GateWait, asPendingGate } from "../gate-wait";
import type { PendingGateRecord } from "../../lifecycle/gate-ledger";

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
  /**
   * The exit code that means the command stopped at a gate of its own
   * (#2779), such as `chant workspace upgrade`'s 3. On it the step does not
   * fail and does not pass: the run ends `gated` at the command's gate, as it
   * would at a pending `gate` step, and a work lease is released `gated`.
   *
   * The gate is read from the command's stdout when that is JSON carrying a
   * `pending` fact, as `chant workspace upgrade --json` prints; otherwise
   * `gate` names it, and the newest pending fact for it on the gate ledger is
   * the one the run stops at. It is read before `okExit`, so a code in both
   * stops the run.
   */
  gatedExit?: number;
  /**
   * The gate the command records, for `gatedExit`, when its stdout doesn't
   * carry it: the op it is recorded under and its name, the two arguments
   * `chant approve` takes (`{ op: "workspace-upgrade", gate: "." }`).
   */
  gate?: { op: string; gate: string };
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
    if (exitCode !== undefined && !died && args.gatedExit !== undefined && exitCode === args.gatedExit) {
      const stderrText = (failure.stderr ?? "").trim();
      if (stderrText) console.error(stderrText);
      throw new GateWait(await commandGate(args, (failure.stdout ?? "").trim(), exitCode));
    }
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

/** The pending fact a command's stdout carries: the whole of it as JSON, or its last line. */
function pendingFromStdout(stdout: string): PendingGateRecord | undefined {
  const lines = stdout.split("\n");
  for (const text of [stdout, lines[lines.length - 1] ?? ""]) {
    try {
      const parsed = JSON.parse(text) as { pending?: unknown } | null;
      const pending = asPendingGate(parsed?.pending);
      if (pending) return pending;
    } catch {
      // Not JSON: try the next reading, then the step's own `gate`.
    }
  }
  return undefined;
}

/**
 * The gate a command stopped at (#2779): the pending fact its stdout
 * carries, or the newest one the gate ledger holds for the step's `gate`.
 * Throws when neither names one, since a run can't be `gated` at a gate
 * nobody can approve.
 */
async function commandGate(args: ShellCmdArgs, stdout: string, exitCode: number): Promise<PendingGateRecord> {
  const fromStdout = pendingFromStdout(stdout);
  if (fromStdout) return fromStdout;
  const named = args.gate;
  if (!named) {
    throw new Error(
      `command exited ${exitCode}, its gatedExit, and named no gate: its stdout carries no \`pending\` gate fact as JSON, and the step has no \`gate\``,
    );
  }
  const { readGateLedger, latestPendingGate } = await import("../../lifecycle/gate-ledger");
  const { pending } = await readGateLedger(named.op, args.cwd ? { cwd: args.cwd } : undefined);
  const latest = latestPendingGate(pending, named.gate);
  if (!latest) {
    throw new Error(
      `command exited ${exitCode}, its gatedExit, but the gate ledger holds no pending fact for ${named.op} / ${named.gate}, so there is no gate to stop at`,
    );
  }
  return latest;
}
