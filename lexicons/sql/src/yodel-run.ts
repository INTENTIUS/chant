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
 * ## Commit jobs
 *
 * Two more commands run in chant's commit job (#4724, over #4722 and #4723),
 * which pushes what they change to the pull request's branch. They are on a
 * list of their own, {@link YODEL_COMMIT_COMMANDS}, which
 * {@link runAllowedYodel} does not take:
 *
 * - `yodel new [<name>] --if-changed --replace-own`: writes the migration
 *   the declared schema is ahead by, or nothing when it is not ahead
 *   (sql-yodeler#311). Its check trigger is lint's `unmigrated` finding.
 * - `yodel rebase [--env <env>]...`: rebases a forked migrations directory,
 *   run on the merge of the base branch into the head (`mergeBase`). Its
 *   check trigger is lint's `fork` finding. With `--env` it reads those
 *   environments' histories, with the reader's variables and never the
 *   writer's.
 *
 * {@link yodelCommitSpec} builds the commit job's spec, which may change
 * only the migrations directory. {@link yodelRefusalReply} turns the three
 * refusals into replies that name the object: two branches changing the same
 * object, a migration edited by hand, and a history that records the
 * migration. {@link yodelFindingExit} maps a `yodel lint --json` report onto
 * the exit code the check trigger reads.
 *
 * The runner is injectable, so the tests run no binary.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CI_COMMIT_REPLY_FLOOR, resolveCommitSpec, type CommitRefusalReply, type OpCommitSpec } from "@intentius/chant/ci-commit";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import type { OpSetupRunStep } from "@intentius/chant/lexicon";
import { sqlCiSetup, type SqlCiDialect } from "./ci-setup";

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

// ── commit jobs (#4724) ────────────────────────────────────────────────────

/**
 * The first chant with yodel's commit jobs: {@link yodelNewArgs},
 * {@link yodelRebaseArgs}, {@link yodelCommitSpec} and
 * {@link yodelRefusalReply}. It is the commit job's own floor for the parts
 * they need (`commandEnv`, `CHANT_COMMIT_PR`, the refusal reply), so it
 * freezes with it.
 */
export const YODEL_COMMIT_FLOOR: string = CI_COMMIT_REPLY_FLOOR;

/** The words of yodel's commit jobs: `/yodel new` and `/yodel rebase`. */
export type YodelCommitWord = "new" | "rebase";
export const YODEL_COMMIT_WORDS: readonly YodelCommitWord[] = ["new", "rebase"];

/** The `yodel lint` finding (its `rule`) that starts each commit job on the check trigger. */
export const YODEL_COMMIT_FINDINGS: Readonly<Record<YodelCommitWord, string>> = { new: "unmigrated", rebase: "fork" };

/** A migration name as yodel takes one: lowercase letters and digits, words joined by `-` or `_`. */
const MIGRATION_NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/**
 * The only yodel commands chant's commit job runs for yodel (#4724), each
 * optionally followed by `--dir <project>`. Apart from
 * {@link YODEL_COMMANDS}: the capability never runs them, and the commit
 * job never runs the capability's.
 */
export const YODEL_COMMIT_COMMANDS: readonly string[] = ["yodel new [<name>] --if-changed --replace-own", "yodel rebase [--env <env>]..."];

/** `--dir <d>` at most, and nothing else: the tail of the commit commands. */
function dirTail(rest: readonly string[]): boolean {
  if (rest.length === 0) return true;
  return rest.length === 2 && rest[0] === "--dir" && value(rest[1]);
}

/** Whether `args` is one of {@link YODEL_COMMIT_COMMANDS}. */
export function allowedYodelCommitArgv(args: readonly string[]): boolean {
  if (args[0] === "new") {
    const at = typeof args[1] === "string" && MIGRATION_NAME.test(args[1]) ? 2 : 1;
    return args[at] === "--if-changed" && args[at + 1] === "--replace-own" && dirTail(args.slice(at + 2));
  }
  if (args[0] === "rebase") {
    let i = 1;
    while (args[i] === "--env") {
      if (!value(args[i + 1])) return false;
      i += 2;
    }
    return dirTail(args.slice(i));
  }
  return false;
}

/** The directory yodel keeps the migrations in, under the project. */
export const YODEL_MIGRATIONS_DIR = "migrations";

/**
 * `yodel new [<name>] --if-changed --replace-own [--dir <project>]`, without
 * the binary (sql-yodeler#311). With no name yodel takes `ci.new.name`, by
 * default `pr-<number>` from `CHANT_COMMIT_PR`. `--if-changed` writes
 * nothing and exits 0 when the build equals the newest migration's recorded
 * schema; `--replace-own` replaces the newest migration only when the pull
 * request adds it and no history records it, so asking twice gives one
 * migration.
 */
export function yodelNewArgs(opts: { name?: string; dir?: string } = {}): string[] {
  if (opts.name !== undefined && !MIGRATION_NAME.test(opts.name)) throw new Error(`yodel new: ${JSON.stringify(opts.name)} is not a migration name (lowercase letters and digits, words joined by - or _)`);
  return ["new", ...(opts.name ? [opts.name] : []), "--if-changed", "--replace-own", ...(opts.dir ? ["--dir", opts.dir] : [])];
}

/**
 * `yodel rebase [--env <env>]... [--dir <project>]`, without the binary. No
 * `<id>` or `--onto`: the directory's one fork is resolved. Never `--force`,
 * so a migration edited by hand stays a refusal.
 */
export function yodelRebaseArgs(opts: { envs?: readonly string[]; dir?: string } = {}): string[] {
  for (const e of opts.envs ?? []) if (!value(e)) throw new Error(`yodel rebase: ${JSON.stringify(e)} is not an environment name`);
  return ["rebase", ...(opts.envs ?? []).flatMap((e) => ["--env", e]), ...(opts.dir ? ["--dir", opts.dir] : [])];
}

/** An environment's variable prefix as yodel names it: `DEV_POSTGRES` for `dev` on Postgres. */
export const yodelVariablePrefix = (env: string, dialect: SqlCiDialect): string => `${env.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${dialect.toUpperCase()}`;

/** The reader's variables of `env` on `dialect`: its URL, user and password, as yodel's credentials name them by default. */
export function yodelReaderVariables(env: string, dialect: SqlCiDialect): string[] {
  const p = yodelVariablePrefix(env, dialect);
  return [`${p}_URL`, `${p}_READER_USER`, `${p}_READER_PASSWORD`];
}

/** Whether a variable picks or carries a writer: never passed to a commit command. */
function writerVariable(v: string): boolean {
  return YODEL_ROLE_VARIABLES.includes(v) || WRITER_VARIABLE.test(v) || /_WRITER_/.test(v);
}

export interface YodelCommitOptions {
  /** `comment`: the job answers `/<product> <word>`. `check`: it follows the check's run and starts when the run exits with chant's `drift` code ({@link yodelFindingExit}). */
  on: "comment" | "check";
  /** The yodel project, from the repository root. Default: the root. */
  dir?: string;
  /** The product's name in the comment. Default `yodel`. */
  product?: string;
  /** The yodel binary. Default `yodel`, the checkout's `node_modules/.bin/yodel` once the setup lines put it on PATH. */
  bin?: string;
  /** new: the migration's name. Default: yodel's `ci.new.name`. */
  name?: string;
  /** rebase: the environments whose histories must not record a migration the rebase rewrites (`--env`). Needs `dialect`. */
  envs?: readonly string[];
  /** rebase with `envs`: the dialect, for the reader's variable names. */
  dialect?: SqlCiDialect;
  /** rebase with `envs`: the reader's variables, when `credentials()` names others than the defaults. A writer's is refused. */
  readerVariables?: readonly string[];
  /** As the commit job's spec: the push token's secret, or the job's own token. */
  tokenEnv?: string;
  jobToken?: boolean;
  maxRuns?: number;
  timeout?: number;
  env?: string;
  after?: string[];
}

/**
 * The commit job's spec for `/yodel new` or `/yodel rebase` (#4724). It may
 * change the project's migrations directory only. rebase merges the base
 * branch into the head first (`mergeBase`, #4723), as a fork shows only on
 * that merge, and with `envs` the command sees those environments' reader
 * variables and nothing of the writer. Checked by chant's
 * `resolveCommitSpec`, so a bad one fails when the pipeline is generated.
 */
export function yodelCommitSpec(word: YodelCommitWord, o: YodelCommitOptions): OpCommitSpec {
  if (!YODEL_COMMIT_WORDS.includes(word)) throw new Error(`yodel's commit jobs are ${YODEL_COMMIT_WORDS.join(" and ")}, not ${JSON.stringify(word)}`);
  const dir = (o.dir ?? "").replace(/^\.\/?/, "").replace(/\/+$/, "");
  const product = o.product ?? "yodel";
  const envs = o.envs ?? [];
  if (word === "new" && envs.length > 0) throw new Error("yodel new reads no history in a commit job, so it takes no envs");
  if (word === "rebase" && o.name !== undefined) throw new Error("yodel rebase takes no name");
  let commandEnv: string[] = [];
  if (envs.length > 0) {
    if (o.readerVariables === undefined && o.dialect === undefined) throw new Error("yodel rebase with envs needs dialect, for the reader's variable names, or readerVariables");
    commandEnv = o.readerVariables ? [...o.readerVariables] : envs.flatMap((e) => yodelReaderVariables(e, o.dialect!));
    const writers = commandEnv.filter(writerVariable);
    if (writers.length > 0) throw new Error(`yodel rebase --env reads histories as the reader only, so it is not given ${writers.join(", ")}`);
  }
  const args = word === "new" ? yodelNewArgs({ ...(o.name ? { name: o.name } : {}), ...(dir ? { dir } : {}) }) : yodelRebaseArgs({ envs, ...(dir ? { dir } : {}) });
  if (!allowedYodelCommitArgv(args)) throw new Error(`yodel ${args.join(" ")} is not one of ${YODEL_COMMIT_COMMANDS.join(", ")}`);
  const spec: OpCommitSpec = {
    on: o.on,
    ...(o.on === "comment" ? { comment: `/${product} ${word}` } : { findings: [CHANT_EXIT.drift] }),
    command: [o.bin ?? "yodel", ...args],
    allowed: [`${dir ? `${dir}/` : ""}${YODEL_MIGRATIONS_DIR}/`],
    ...(word === "rebase" ? { mergeBase: true } : {}),
    ...(commandEnv.length > 0 ? { commandEnv } : {}),
    ...(o.tokenEnv !== undefined ? { tokenEnv: o.tokenEnv } : {}),
    ...(o.jobToken !== undefined ? { jobToken: o.jobToken } : {}),
    ...(o.maxRuns !== undefined ? { maxRuns: o.maxRuns } : {}),
    ...(o.timeout !== undefined ? { timeout: o.timeout } : {}),
    ...(o.env !== undefined ? { env: o.env } : {}),
    ...(o.after !== undefined ? { after: o.after } : {}),
  };
  resolveCommitSpec(`${product}-${word}`, spec, product);
  return spec;
}

/**
 * The commit job's setup steps for the project at `dir` (an absolute path
 * at generation time): the sql lexicon's CI setup lines (`./ci-setup.ts`),
 * the Node check and the project's install with its bins on PATH, each a
 * run step. None when the project has no config.
 */
export function yodelCommitSetup(ctx: { dir: string }): OpSetupRunStep[] {
  return sqlCiSetup(ctx).map((run) => ({ run }));
}

// ── the check trigger ──────────────────────────────────────────────────────

/** The parts of `yodel lint --json` (sql-yodeler's lint.schema.json) the trigger reads. */
interface LintReport {
  status?: unknown;
  findings?: Array<{ rule?: unknown; silenced?: unknown }>;
}

/** The rules of a lint report's findings that are not silenced, or undefined when it is not a report. */
function lintRules(lint: unknown): Set<string> | undefined {
  const r = (typeof lint === "string" ? safeJson(lint) : lint) as LintReport | undefined;
  if (!r || typeof r !== "object" || !Array.isArray(r.findings)) return undefined;
  return new Set(r.findings.filter((f) => f && typeof f.rule === "string" && f.silenced === undefined).map((f) => f.rule as string));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The commit job a `yodel lint --json` report starts, or undefined. A fork
 * comes first: `yodel new` refuses a directory that is not one chain, so
 * with both findings the rebase runs, and the next check finds
 * `unmigrated` again if it still holds.
 */
export function yodelFindingTrigger(lint: unknown): YodelCommitWord | undefined {
  const rules = lintRules(lint);
  if (!rules) return undefined;
  if (rules.has(YODEL_COMMIT_FINDINGS.rebase)) return "rebase";
  if (rules.has(YODEL_COMMIT_FINDINGS.new)) return "new";
  return undefined;
}

/**
 * The exit code a check that starts `word`'s commit job exits with, from a
 * `yodel lint --json` report: chant's `drift` (the code
 * {@link yodelCommitSpec}'s check trigger reads) when the report starts that
 * job, else `failed` for a report that failed or does not read, else `done`.
 */
export function yodelFindingExit(lint: unknown, word: YodelCommitWord): number {
  if (yodelFindingTrigger(lint) === word) return CHANT_EXIT.drift;
  const r = (typeof lint === "string" ? safeJson(lint) : lint) as LintReport | undefined;
  if (!lintRules(lint) || r?.status === "failed") return CHANT_EXIT.failed;
  return CHANT_EXIT.done;
}

// ── the refusal replies ────────────────────────────────────────────────────

/** A migration id, an environment or an object name as a reply may quote it: printable, no backtick, bounded. */
const QUOTABLE = /^[A-Za-z0-9_.:/$"' -]{1,200}$/;
const MIGRATION_ID = /^[0-9]{8}T[0-9]{4,6}-[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

const q = (s: string): string => "`" + s + "`";

function quotable(list: readonly string[]): boolean {
  return list.length > 0 && list.length <= 20 && list.every((x) => QUOTABLE.test(x));
}

/** The last `yodel <verb>: refused: ...` line of the output, the refusal yodel prints last. */
function refusalLine(output: string, verb: string): string | undefined {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith(`yodel ${verb}: `));
  return lines.at(-1)?.slice(`yodel ${verb}: `.length);
}

/**
 * The reply to a refused `yodel new` or `yodel rebase` (#4724), naming the
 * object, from what yodel printed on standard error; undefined for any other
 * failure, which keeps chant's own reply. The output is from a command run on
 * the pull request's files, so a reply quotes only names that match a
 * migration id or a plain object name, and says the rest in its own words:
 *
 * - rebase, two branches changing one object: `refused: <a> and <b> both
 *   change <objects>, differently; ...`
 * - rebase, an edit by hand: `refused: <ids> has|have files that differ from
 *   what yodel wrote ...`
 * - rebase, a history: `refused: <env>'s history records <id> (applied),
 *   ...`; new with `--replace-own`: `refused: <id> is applied in <env>, ...`
 */
export function yodelRefusalReply(o: { command: readonly string[]; rc: string; output: string }): string | undefined {
  if (o.rc !== "1") return undefined;
  const verb = o.command[1];
  if (verb !== "new" && verb !== "rebase") return undefined;
  const line = refusalLine(o.output, verb);
  if (!line?.startsWith("refused: ")) return undefined;
  const text = line.slice("refused: ".length);

  if (verb === "rebase") {
    const both = /^(\S+) and (\S+) both change (.+?), differently;/.exec(text);
    if (both) {
      const [, mine, theirs, objects] = both as unknown as [string, string, string, string];
      const names = objects.split(", ");
      if (!MIGRATION_ID.test(mine) || !MIGRATION_ID.test(theirs) || !quotable(names)) return undefined;
      return (
        `\`yodel rebase\` refused: ${q(mine)} and ${q(theirs)} both change ${names.map(q).join(", ")}, differently, and a rebase does not merge two changes to one object. ` +
        `Resolve it on the branch: delete ${q(mine)}'s directory, declare both changes, then run \`yodel new\` (or comment \`/yodel new\`).`
      );
    }
    const edited = /^(.+?) (?:has|have) files that differ from what yodel wrote/.exec(text);
    if (edited) {
      const ids = edited[1]!.split(", ");
      if (!ids.every((id) => MIGRATION_ID.test(id))) return undefined;
      const one = ids.length === 1;
      return (
        `\`yodel rebase\` refused: ${ids.map(q).join(", ")} ${one ? "was" : "were"} edited by hand (${one ? "its" : "their"} files differ from what yodel wrote), and a rebase writes ${one ? "it" : "them"} again from the recorded schema, dropping the edit. ` +
        `Rebase on your machine with \`yodel rebase --force\` and make the edit again, or put the change in the declared schema.`
      );
    }
  }
  const history = /^(\S+)'s history records (.+?)\. Nothing was written/.exec(text);
  if (history) {
    const env = history[1]!;
    const listed = history[2]!;
    // `<id> (applied)` or `<id> (ran part way, <status>)`, joined by ", ".
    const ran = [...listed.matchAll(/(\S+) \((applied|ran part way, [a-z_-]+)\)(?:, |$)/g)];
    if (!QUOTABLE.test(env) || ran.length === 0 || ran.map((m) => m[0]).join("") !== listed || ran.some((m) => !MIGRATION_ID.test(m[1]!))) return undefined;
    const ids = ran.map((m) => `${q(m[1]!)} (${m[2]})`);
    return (
      `\`yodel ${verb}\` refused: ${q(env)}'s history records ${ids.join(", ")}, and a migration that ran is never rewritten. ` +
      `Rebase the other branch onto it instead: \`yodel rebase <the other> --onto <the end of this one>\`.`
    );
  }
  const applied = /^(\S+) is applied in (\S+?), so it is not (?:redone|replaced)/.exec(text);
  if (applied && verb === "new") {
    const [, id, env] = applied as unknown as [string, string, string];
    if (!MIGRATION_ID.test(id) || !QUOTABLE.test(env)) return undefined;
    return `\`yodel new\` refused: ${q(id)} is applied in ${q(env)}, so it is not replaced. Write the change as a migration of its own: \`yodel new <name>\`.`;
  }
  return undefined;
}

/** {@link yodelRefusalReply} as chant's commit job takes it: a product's bin passes it to `setCommitRefusalReply`. */
export const yodelCommitRefusalReply: CommitRefusalReply = ({ settings, rc, output }) => {
  const at = settings.command.findIndex((a) => a === "new" || a === "rebase");
  if (at < 1) return undefined;
  return yodelRefusalReply({ command: ["yodel", ...settings.command.slice(at)], rc, output });
};
