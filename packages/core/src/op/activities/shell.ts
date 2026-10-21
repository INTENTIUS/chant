import { exec } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { GateWait, asPendingGate } from "../gate-wait";
import type { PendingGateRecord } from "../../lifecycle/gate-ledger";
import { liveRunEnv } from "../run-live";
import { hasStepConsole, stepLineSplitter } from "../step-console";

const execAsync = promisify(exec);

export interface ShellCmdArgs {
  cmd: string;
  /** Additional environment variables. */
  env?: Record<string, string>;
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
  /**
   * Whether the command sees this process's environment. Default true. With
   * false it sees `env` alone, plus the in-flight record's variable, so a job
   * the chant runner runs (`chant ci run`, #4094) gets a clean environment.
   */
  inheritEnv?: boolean;
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
  /**
   * Parse stdout as JSON and publish it as `json` (#2787), so a later step,
   * or `workLease.item`, reads a list or an object rather than a string:
   * `pick.out.json`. Stdout that is not JSON fails the step, since a value
   * the author said was JSON and isn't would otherwise reach the next step as
   * something else. Empty stdout is `null`.
   */
  json?: boolean;
  /**
   * Run the command in a container (#4015) instead of on the host: an image
   * pinned by digest, `<ref>@sha256:<64 hex>`, so the step names the
   * toolchain it ran with. The step's working directory is mounted at
   * `/workspace`, which is the command's working directory; the container
   * sees `env` by name and nothing of this process's environment, whatever
   * `inheritEnv` says. Run with `docker run --rm`, or the command
   * `CHANT_CONTAINER_CLI` names (`podman`).
   */
  image?: string;
  /** How the container mounts the working directory (#4015). Default `{ workspace: "ro" }`. */
  mounts?: { workspace?: "ro" | "rw" };
  /**
   * Directories under the working directory the containerized command writes
   * (#4015). Each is created on the host if missing and mounted writable at
   * the same path, so what the command leaves there stays on the host. A
   * directory still empty when the command ends fails a step that otherwise
   * passed. Only with `image`.
   */
  outputs?: string[];
}

/** An image reference pinned by digest (#4015): anything, then `@sha256:` and 64 lowercase hex digits. */
export const PINNED_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

/** Why `image` can't run, or undefined when it is a reference pinned by digest. */
export function imageProblem(image: unknown): string | undefined {
  if (typeof image !== "string") return "image must be a literal string, an image reference pinned by digest";
  if (!PINNED_IMAGE.test(image)) return `image ${JSON.stringify(image)} is not pinned by digest: name it as <ref>@sha256:<digest>`;
  return undefined;
}

/** Why an `outputs` path can't be copied back, or undefined when it is a relative path inside the working directory. */
function outputProblem(path: string): string | undefined {
  const n = normalize(path);
  if (path === "" || isAbsolute(path) || n === ".." || n.startsWith("../") || n === ".") return `output ${JSON.stringify(path)} must be a relative path inside the working directory`;
  return undefined;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Where a containerized command sees the working directory. */
const WORKSPACE = "/workspace";

/**
 * The `docker run --rm` line for a step with `image` (#4015). The working
 * directory is mounted at `/workspace`, read-only by default, and each
 * declared output directory is mounted writable on top of it.
 */
export function containerCommand(args: ShellCmdArgs & { image: string }, where: { cwd: string; cli?: string; user?: string }): string {
  const mode = args.mounts?.workspace ?? "ro";
  const outputs = mode === "ro" ? (args.outputs ?? []).map((p) => normalize(p).replace(/\/+$/, "")) : [];
  return [
    where.cli ?? "docker",
    "run",
    "--rm",
    ...(where.user ? ["--user", where.user] : []),
    "-v",
    shellQuote(`${where.cwd}:${WORKSPACE}:${mode}`),
    ...outputs.flatMap((p) => ["-v", shellQuote(`${join(where.cwd, p)}:${WORKSPACE}/${p}:rw`)]),
    "-w",
    WORKSPACE,
    ...Object.keys(args.env ?? {}).flatMap((name) => ["-e", shellQuote(name)]),
    shellQuote(args.image),
    "sh",
    "-c",
    shellQuote(args.cmd),
  ].join(" ");
}

/** Throw when a declared output directory is still empty after a command that passed. */
async function checkOutputs(outputs: readonly string[], cwd: string): Promise<void> {
  for (const p of outputs) {
    const entries = await readdir(join(cwd, normalize(p))).catch(() => []);
    if (entries.length === 0) throw new Error(`the step declares output ${JSON.stringify(p)}, and the command left it empty`);
  }
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
  /** Stdout parsed as JSON, present when the step set `json` (#2787). */
  json?: unknown;
}

/** `result` with its stdout parsed as JSON, when the step asked for it. */
function withJson(result: ShellCmdResult, args: ShellCmdArgs): ShellCmdResult {
  if (!args.json) return result;
  if (result.stdout === "") return { ...result, json: null };
  try {
    return { ...result, json: JSON.parse(result.stdout) };
  } catch (err) {
    const shown = result.stdout.length > 200 ? `${result.stdout.slice(0, 200)}...` : result.stdout;
    throw new Error(`the step sets json, and its stdout is not JSON (${err instanceof Error ? err.message : String(err)}): ${shown}`);
  }
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
  // #3956: under a step console (../step-console.ts) every line the command
  // writes, stdout and stderr, is printed as it arrives; the result still
  // carries both whole. Without one, stderr is printed when the command ends.
  const streamed = hasStepConsole();
  const printStderr = (text: string) => {
    if (text && !streamed) console.error(text);
  };
  const out = stepLineSplitter();
  const err = stepLineSplitter();
  if (args.image === undefined && (args.outputs !== undefined || args.mounts !== undefined)) {
    throw new Error("outputs and mounts apply only to a step that runs in a container: give the step an image");
  }
  const container = args.image !== undefined ? await prepareContainer(args) : undefined;
  try {
    const running = execAsync(container?.cmd ?? args.cmd, {
      cwd: args.cwd,
      // In a run that keeps an in-flight record, CHANT_RUN_ACTIVITY names the
      // file the command appends activity lines to (../run-live.ts). Under
      // `image` the container CLI gets this process's environment, so it can
      // reach its daemon, and the container gets `env` alone, by name.
      env: container
        ? { ...process.env, ...args.env }
        : { ...(args.inheritEnv === false ? {} : process.env), ...liveRunEnv(), ...args.env },
      maxBuffer: MAX_STDOUT_BYTES,
      signal,
    });
    if (streamed) {
      running.child.stdout?.on("data", (chunk: string | Buffer) => out.push(chunk));
      running.child.stderr?.on("data", (chunk: string | Buffer) => err.push(chunk));
    }
    let settled: { stdout: string; stderr: string };
    try {
      settled = await running;
    } finally {
      out.end();
      err.end();
    }
    const { stdout, stderr } = settled;
    printStderr(stderr);
    if (container) await checkOutputs(args.outputs ?? [], container.cwd);
    return withJson({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 }, args);
  } catch (caught) {
    const failure = caught as ExecFailure;
    const exitCode = typeof failure.code === "number" ? failure.code : undefined;
    // A signal kill (Ctrl-C, the profile's timeout, a maxBuffer overflow) is
    // not an exit status the author declared anything about, so it rethrows
    // even if `okExit` happens to contain the code.
    const died = failure.killed === true || typeof failure.signal === "string" || signal?.aborted === true;
    if (exitCode !== undefined && !died && args.gatedExit !== undefined && exitCode === args.gatedExit) {
      const stderrText = (failure.stderr ?? "").trim();
      printStderr(stderrText);
      throw new GateWait(await commandGate(args, (failure.stdout ?? "").trim(), exitCode));
    }
    if (exitCode !== undefined && !died && okExit.includes(exitCode)) {
      const stderrText = (failure.stderr ?? "").trim();
      printStderr(stderrText);
      return withJson({ stdout: (failure.stdout ?? "").trim(), stderr: stderrText, exitCode }, args);
    }
    if (exitCode !== undefined && !died) {
      // `local-executor` records `error` as message text, so the code has to
      // be in the message or it is gone (#2413).
      failure.message = `command exited ${exitCode} (expected ${okExit.join(", ")}): ${failure.message}`;
    }
    throw failure;
  }
}

/** The container line for a step with `image` (#4015), checked first, with each output directory made on the host. */
async function prepareContainer(args: ShellCmdArgs): Promise<{ cmd: string; cwd: string }> {
  const problem = imageProblem(args.image) ?? (args.outputs ?? []).map(outputProblem).find((p) => p !== undefined);
  if (problem) throw new Error(problem);
  const cwd = resolve(args.cwd ?? process.cwd());
  // A writable mount inside a read-only one needs its mountpoint to exist already.
  for (const p of args.outputs ?? []) await mkdir(join(cwd, normalize(p)), { recursive: true });
  // The host's uid and gid, so what the command writes belongs to whoever
  // runs chant rather than to the image's root.
  const user = typeof process.getuid === "function" && typeof process.getgid === "function" ? `${process.getuid()}:${process.getgid()}` : undefined;
  const cmd = containerCommand(args as ShellCmdArgs & { image: string }, {
    cwd,
    ...(process.env.CHANT_CONTAINER_CLI ? { cli: process.env.CHANT_CONTAINER_CLI } : {}),
    ...(user ? { user } : {}),
  });
  return { cmd, cwd };
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
