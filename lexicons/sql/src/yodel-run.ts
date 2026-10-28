/**
 * Running sql-yodeler's versioned migration engine (`yodel`) for the sql
 * lexicon's `sql-migrate` capability (#4569). The ruling on
 * sql-yodeler#285 (A) keeps the engine in sql-yodeler and has chant run it
 * through a fixed argv list, the way the pulumi lexicon runs plunge
 * (`lexicons/pulumi/src/run.ts`). {@link YODEL_COMMANDS} is that list, and
 * {@link runAllowedYodel} refuses any argv off it before it reaches the
 * runner, so no later caller can make this module run another yodel verb.
 *
 * The three commands, each the engine's own entry point:
 *
 * - `yodel plan <env> --part <file>`: the pending migrations as a chant
 *   change-set part (sql-yodeler#237, built by this lexicon's
 *   `sqlVersionedPlanPart`), one entry per object with its change classes.
 *   Reads only.
 * - `yodel apply <env> --wave-plan <file> --spec <spec>`: the wave plan the
 *   op wave's gate binds. Its digest covers the migrations' digest, the
 *   environment's gate policy at the base commit, whether a pending step is
 *   destructive, and the promotion evidence. Reads only.
 * - `yodel apply <env> --wave-apply <file> --spec <spec>`: applies that
 *   plan under the engine's lock. The engine plans again under the lock and
 *   refuses a plan that moved, and it checks chant's decision for the wave
 *   and the gate ledger's approval itself (ruling A on sql-yodeler#300).
 *
 * Each may carry, in this order and no other, `--dir <project>`, `--op
 * <name>` and `--allow-out-of-order`. A value must not start with a dash.
 *
 * ## Credentials
 *
 * The two planning commands run with the writer taken out of their
 * environment ({@link readerEnv}): no `YODEL_ROLE` or `YODEL_CREDENTIALS`,
 * which pick the writer, and no `<ENV>_<DIALECT>_WRITER_USER` or
 * `..._WRITER_PASSWORD`, the writer's default variables. Only the apply runs
 * with the job's environment as given, so the writer reaches the apply
 * alone even when one job plans and applies.
 *
 * The runner is injectable, so the tests run no binary.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** What one yodel run gave. Never thrown: a non-zero exit is a `code`. */
export interface YodelRun {
  /** The exit status; null when the process did not exit by itself or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** No yodel binary was found. */
  missingBinary?: boolean;
}

/** Runs yodel with these arguments in `cwd`, with `env`. Injectable so tests need no binary. */
export type YodelRunner = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; dir?: string }) => Promise<YodelRun>;

/**
 * The only yodel commands chant runs (ruling A on sql-yodeler#285). Each
 * may be followed by `--dir <project>`, `--op <name>` and
 * `--allow-out-of-order`, in that order ({@link YODEL_OPTIONAL_FLAGS}).
 */
export const YODEL_COMMANDS: readonly string[] = [
  "yodel plan <env> --part <file>",
  "yodel apply <env> --wave-plan <file> --spec <spec>",
  "yodel apply <env> --wave-apply <file> --spec <spec>",
];

/** The flags any of {@link YODEL_COMMANDS} may end with, in this order. */
export const YODEL_OPTIONAL_FLAGS: readonly string[] = ["--dir <project>", "--op <name>", "--allow-out-of-order"];

/** The options every command takes. */
export interface YodelCommonOptions {
  /** The yodel project directory, passed as `--dir`. */
  dir?: string;
  /** The migrations Op, when more than one applies the environment. */
  op?: string;
  allowOutOfOrder?: boolean;
}

function common(opts: YodelCommonOptions): string[] {
  return [...(opts.dir ? ["--dir", opts.dir] : []), ...(opts.op ? ["--op", opts.op] : []), ...(opts.allowOutOfOrder ? ["--allow-out-of-order"] : [])];
}

/** `yodel plan <env> --part <file>`, without the binary. */
export function yodelPlanArgs(env: string, part: string, opts: YodelCommonOptions = {}): string[] {
  return ["plan", env, "--part", part, ...common(opts)];
}

/** `yodel apply <env> --wave-plan <file> --spec <spec>`, without the binary. */
export function yodelWavePlanArgs(env: string, file: string, spec: string, opts: YodelCommonOptions = {}): string[] {
  return ["apply", env, "--wave-plan", file, "--spec", spec, ...common(opts)];
}

/** `yodel apply <env> --wave-apply <file> --spec <spec>`, without the binary. */
export function yodelWaveApplyArgs(env: string, file: string, spec: string, opts: YodelCommonOptions = {}): string[] {
  return ["apply", env, "--wave-apply", file, "--spec", spec, ...common(opts)];
}

/** A value after a flag: present, and not itself a flag. */
const value = (v: string | undefined): boolean => typeof v === "string" && v.length > 0 && !v.startsWith("-");

/** The optional tail: `--dir <d>`, `--op <n>`, `--allow-out-of-order`, each at most once, in that order. */
function allowedTail(rest: readonly string[]): boolean {
  let i = 0;
  if (rest[i] === "--dir") {
    if (!value(rest[i + 1])) return false;
    i += 2;
  }
  if (rest[i] === "--op") {
    if (!value(rest[i + 1])) return false;
    i += 2;
  }
  if (rest[i] === "--allow-out-of-order") i += 1;
  return i === rest.length;
}

/** Whether `args` is one of {@link YODEL_COMMANDS} with an allowed tail. */
export function allowedYodelArgv(args: readonly string[]): boolean {
  if (!value(args[1])) return false;
  if (args[0] === "plan") return args[2] === "--part" && value(args[3]) && allowedTail(args.slice(4));
  if (args[0] === "apply") {
    return (args[2] === "--wave-plan" || args[2] === "--wave-apply") && value(args[3]) && args[4] === "--spec" && value(args[5]) && allowedTail(args.slice(6));
  }
  return false;
}

/** Whether `args` is the apply, the one command that writes. */
export function isYodelApplyArgv(args: readonly string[]): boolean {
  return args[0] === "apply" && args[2] === "--wave-apply";
}

/** Run `args` through `run`, refusing any argv off {@link YODEL_COMMANDS}. */
export async function runAllowedYodel(run: YodelRunner, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; dir?: string }): Promise<YodelRun> {
  if (!allowedYodelArgv(args)) {
    throw new Error(`chant runs only ${YODEL_COMMANDS.join(", ")} (each optionally with ${YODEL_OPTIONAL_FLAGS.join(", ")}) for a SQL member, not yodel ${args.join(" ")}`);
  }
  return run(args, opts);
}

/** The variables that pick the writer (sql-yodeler `credentials.ts`). */
export const YODEL_ROLE_VARIABLES: readonly string[] = ["YODEL_ROLE", "YODEL_CREDENTIALS"];

/** A writer's default user and password variables, `<ENV>_<DIALECT>_WRITER_USER` and `..._WRITER_PASSWORD`. */
const WRITER_VARIABLE = /^[A-Z0-9_]+_(CLICKHOUSE|POSTGRES)_WRITER_(USER|PASSWORD)$/;

/** `env` with the writer taken out: what the planning commands run with. */
export function readerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (YODEL_ROLE_VARIABLES.includes(k) || WRITER_VARIABLE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The yodel binary: the project's `node_modules/.bin/yodel`, else the
 * working directory's, else `yodel` on PATH. Always a file named `yodel`.
 */
export function yodelBinary(cwd: string, dir?: string): string {
  for (const base of [...(dir ? [join(cwd, dir)] : []), cwd]) {
    const bin = join(base, "node_modules", ".bin", "yodel");
    if (existsSync(bin)) return bin;
  }
  return "yodel";
}

export const defaultYodelRunner: YodelRunner = (args, opts) =>
  new Promise((resolve) => {
    execFile(yodelBinary(opts.cwd, opts.dir), args, { cwd: opts.cwd, env: opts.env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { code?: unknown };
      if (e.code === "ENOENT") return resolve({ code: null, stdout, stderr: stderr || e.message, missingBinary: true });
      resolve({ code: typeof e.code === "number" ? e.code : null, stdout, stderr: stderr || e.message });
    });
  });
