/**
 * The commit job (#4722): run a product's fixed command on a pull request's
 * head and push what it changed to the pull request's branch. terragucci's
 * `respond.fmt` (a formatter after a failed format check) and sql-yodeler's
 * `yodel rebase` (a forked migrations directory) are the motivating uses.
 *
 * It has the agent job's shape (./ci-agent.ts) without the model:
 *
 * - the commit job holds a read token. `chant commit prepare` reads the
 *   request from the run (a `/<product> <word>` comment, or the check job
 *   that failed before it), refuses a fork, a commenter who cannot write, a
 *   head the job pushed itself (the loop guard) and a pull request over
 *   `maxRuns`, and on the `check` trigger a head whose plan is approved on
 *   the ledger. `chant commit run` then runs the command's argv, with no
 *   shell and no forge token, in a worktree of the head, and leaves what it
 *   changed as a patch.
 * - the push job holds the push token. `chant commit land` reads the
 *   request from the event again, checks the head, the limit and the
 *   approval again, refuses a patch outside `allowed` or on a path no job
 *   may change ({@link agentForbiddenPaths}), commits with a `Commit-run:`
 *   trailer, pushes without force, replies on a comment, and records the
 *   run on the ledger under op `<name>`.
 *
 * An empty patch lands nothing, and on the `check` trigger says nothing.
 * Nothing here applies, approves or merges.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANT_EXIT } from "./exit-codes";
import { NEXT_RELEASE } from "./release-floors";
import { FORGE_TOKEN_VARS } from "./ci-handover";
import { agentForbiddenPaths, AgentError, branchOk, errText, LOGIN, readSmall, SHA, type AgentGit } from "./ci-agent";
import { COMMIT_COMMENT_ARG, parseProductComment, type CiProductWords } from "./ci-product-words";
import type { OpRunRecord, OpRunRecordInput } from "./op/runtime";
import type { RunOrigin } from "./lifecycle/release-ledger";
import type { PrForge } from "./pr-forge";

/** The first chant with the commit job and the scheduled Op spec's `commit` (#4722). Products feature-detect on it. */
export const CI_COMMIT_FLOOR = "0.124.71";

/** The first chant with a commit job after a check that runs on push, `jobToken` and `after` (#4749). Products feature-detect on it. */
export const CI_COMMIT_PUSH_FLOOR = "0.124.72";
/** The first chant whose commit job takes `allowedFiles` (#4758). */
export const CI_COMMIT_FILES_FLOOR = "0.124.73";
/**
 * The first chant whose commit job takes `commandEnv`, gives the command
 * `CHANT_COMMIT_PR`, keeps the tail of its standard error and replies with a
 * product's refusal text ({@link setCommitRefusalReply}) (#4724).
 */
export const CI_COMMIT_REPLY_FLOOR = "0.124.77";
/** The first chant whose commit job takes `commentArg`, one argument after the comment's word passed into the argv (#4820). */
export const CI_COMMIT_ARG_FLOOR = "0.124.78";
/** The first chant whose `commit land` reads {@link COMMIT_HARNESS_BREAK_ENV} in a BREAK arm of chant's e2e harness (#4836). */
export const CI_COMMIT_HARNESS_BREAK_FLOOR = "0.124.78";
/** The first chant whose `commit land` replies to a comment refused as it is read, such as a bad argument or a stray word (#4838). */
export const CI_COMMIT_REFUSAL_REPLY_FLOOR = NEXT_RELEASE;

/** What starts a commit run: a person's comment, or a check job's finding. */
export type CommitTrigger = "comment" | "check";
export const COMMIT_TRIGGERS: readonly CommitTrigger[] = ["comment", "check"];

/**
 * A scheduled Op spec's `commit` (#4722). With `on: "comment"` the spec is
 * the commit job's own workflow, answering `comment` on a pull request, and
 * its trigger is not read. With `on: "check"` the jobs follow the Op's own
 * job (the check) on a pull request and run when its run exits with one of
 * `findings`.
 */
export interface OpCommitSpec {
  on: CommitTrigger;
  /** The comment the job answers, `/<product> <word>`, for `on: "comment"`. The word maps onto `commit` in the product's words. */
  comment?: string;
  /** The command, an argv run with no shell: the product's own, such as `["terraform", "fmt", "-recursive"]`. */
  command: string[];
  /** The only paths the change may touch, from the repository root; a trailing `/` names a directory. */
  allowed: string[];
  /**
   * File names the change may touch in any directory (#4758), matched on the
   * basename: `*.tf` or an exact name such as `terragrunt.hcl`. A path passes
   * when it is in `allowed` or matches one of these; a guarded path is still
   * refused. With these, `allowed` may be empty.
   */
  allowedFiles?: string[];
  /** For `on: "check"`: the exit codes of the Op's run that name a finding. Default `[2]`, chant's `drift` code. */
  findings?: number[];
  /** The secret (GitHub, Forgejo) or protected variable (GitLab) holding the push token. Required on GitHub and Forgejo; `CHANT_FORGE_TOKEN` by default on GitLab. */
  tokenEnv?: string;
  /** The most commits the job pushes to one pull request, counted on the ledger. Default 3. */
  maxRuns?: number;
  /** Paths beyond chant's own that the change may not touch. */
  guarded?: string[];
  /** Minutes the command may run. Default 10. */
  timeout?: number;
  /** The ledger environment the runs are recorded under. Default `local`. */
  env?: string;
  /** GitLab only: run the `check` trigger, which is off there by default. */
  gitlabCheck?: boolean;
  /**
   * Merge the base branch's tip into the head (`--no-ff`) before the command
   * runs (#4723), as a migrations fork shows only on that merge. A conflict
   * is refused. The pushed commit is that merge, with the command's change:
   * its parents are the head and the base tip.
   */
  mergeBase?: boolean;
  /**
   * GitHub and Forgejo (#4749): push with the job's own token, so `tokenEnv`
   * may be left out. Such a push starts no workflow run, so the new head gets
   * no plan from it; `after` is where a product does what that run would
   * have done. Refused on GitLab, where a job token cannot push.
   */
  jobToken?: boolean;
  /**
   * Shell lines the push job runs once it has pushed a commit (#4749), with
   * `CHANT_COMMIT_SHA` set to it, such as a product taking the plan locks of
   * the new head. Not run when nothing was pushed.
   */
  after?: string[];
  /**
   * Variables of the commit job the command sees, by name (#4724), such as a
   * database reader's user and password. Every other variable is left out,
   * as before. A forge token's name is refused. GitHub and Forgejo pass each
   * one from the secret of the same name to the step that runs the command;
   * on GitLab they are the project's CI/CD variables.
   */
  commandEnv?: string[];
  /**
   * For `on: "comment"` (#4820): the comment may carry one argument after
   * the word, `/<product> <word> <arg>`, which must match `pattern` (a
   * regular expression's source, anchored with `^` and `$`) and chant's
   * own plain-name check ({@link COMMIT_COMMENT_ARG}). It goes into the
   * command's argv at index `position`, from 1 (after the program) to the
   * argv's length (at the end). With no argument the argv is `command`. On
   * GitLab the pipeline's {@link GITLAB_COMMIT_ARG_VAR} carries it.
   */
  commentArg?: CommitCommentArg;
}

/** Where a commit job's command takes the comment's argument (#4820). */
export interface CommitCommentArg {
  pattern: string;
  position: number;
}

/** A commit job's settings, every default filled and checked. */
export interface CommitSettings {
  name: string;
  on: CommitTrigger;
  comment?: string;
  command: string[];
  allowed: string[];
  allowedFiles: string[];
  findings: number[];
  maxRuns: number;
  guarded: string[];
  timeout: number;
  env: string;
  mergeBase: boolean;
  /** Push with the job token (#4749). */
  jobToken: boolean;
  /** Lines the push job runs after a push (#4749). */
  after: string[];
  /** The job variables the command sees (#4724). */
  commandEnv: string[];
  /** The comment's argument and where it goes in the argv (#4820). */
  commentArg?: CommitCommentArg;
}

export const COMMIT_MAX_RUNS = 3;
export const COMMIT_TIMEOUT_MINUTES = 10;
/** The GitLab variable the push job reads its token from unless `tokenEnv` names another. */
export const COMMIT_GITLAB_TOKEN_ENV = "CHANT_FORGE_TOKEN";
/** The trailer each of the job's commits carries, naming the job. The loop guard reads it. */
export const COMMIT_TRAILER = "Commit-run";

/** The variables the generated jobs carry the settings in. The workflow file is the base branch's, so they are not the change's. */
export const COMMIT_ENV = {
  name: "CHANT_COMMIT_NAME",
  on: "CHANT_COMMIT_ON",
  comment: "CHANT_COMMIT_COMMENT",
  command: "CHANT_COMMIT_COMMAND",
  allowed: "CHANT_COMMIT_ALLOWED",
  allowedFiles: "CHANT_COMMIT_ALLOWED_FILES",
  findings: "CHANT_COMMIT_FINDINGS",
  maxRuns: "CHANT_COMMIT_MAX_RUNS",
  guarded: "CHANT_COMMIT_GUARDED",
  timeout: "CHANT_COMMIT_TIMEOUT",
  env: "CHANT_COMMIT_ENV",
  mergeBase: "CHANT_COMMIT_MERGE_BASE",
  commandEnv: "CHANT_COMMIT_COMMAND_ENV",
  commentArg: "CHANT_COMMIT_COMMENT_ARG",
} as const;

/** The variable the command reads the pull request's number from (#4724), such as for a default name. */
export const COMMIT_PR_ENV = "CHANT_COMMIT_PR";

/** GitLab starts no pipeline on a note: a pipeline of the default branch started with these runs a comment commit job. */
export const GITLAB_COMMIT_PR_VAR = "CHANT_COMMIT_PR";
export const GITLAB_COMMIT_WORD_VAR = "CHANT_COMMIT";
/** With `commentArg` (#4820): the argument, as the comment would give it after the word. */
export const GITLAB_COMMIT_ARG_VAR = "CHANT_COMMIT_ARG";

/** Where the jobs keep the decision, the exit code and the patch, from the job's directory. */
export const COMMIT_DIR = ".chant/commit";
/** The local ref the checkout fetches a pull request's head into. */
export const COMMIT_HEAD_REF = "refs/chant/commit-head";
/** The local ref the jobs fetch the base branch's tip into, with `mergeBase`. */
export const COMMIT_BASE_REF = "refs/chant/commit-base";
export const COMMIT_DECISION_FILE = "decision.json";
export const COMMIT_PATCH_FILE = "change.patch";
export const COMMIT_RC_FILE = "rc";
/** The tail of the command's standard error (#4724), which a product's refusal reply reads. */
export const COMMIT_OUTPUT_FILE = "output";
/** How much of the command's standard error {@link COMMIT_OUTPUT_FILE} keeps, from the end. */
export const COMMIT_OUTPUT_LIMIT = 8192;
/** What `chant commit land` leaves when it pushed (#4749): the pushed commit, which the push job's `after` lines read. */
export const COMMIT_PUSHED_FILE = "pushed";

/**
 * After a check that runs on push (#4749): fetch the pushed commit, by its
 * sha in `shaVar`, into `into` as the head. The pull request is found from
 * the pushed branch (`resolveCommitRequest`).
 */
export function commitPushedHeadFetchLine(shaVar: string, into: string = COMMIT_HEAD_REF): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(shaVar)) throw new AgentError(`${shaVar} is not a variable name`);
  return `case "$${shaVar}" in *[!0-9a-f]*|'') echo "no pushed commit" >&2; exit 1 ;; esac\ngit -c protocol.version=2 fetch -q --no-tags origin "+$${shaVar}:${into}"`;
}

/** The push job's lines after land (#4749): `after`, run only when a commit was pushed, with \`CHANT_COMMIT_SHA\` set. */
export function commitAfterLines(s: Pick<CommitSettings, "after">, dir: string = COMMIT_DIR): string[] {
  if (s.after.length === 0) return [];
  return [`if [ -s ${dir}/${COMMIT_PUSHED_FILE} ]; then`, `  export CHANT_COMMIT_SHA="$(cat ${dir}/${COMMIT_PUSHED_FILE})"`, ...s.after.map((l) => `  ${l}`), "fi"];
}

/** The commit identity the job's commits carry. */
export const COMMIT_GIT_NAME = "chant commit";
export const COMMIT_GIT_EMAIL = "chant-commit@localhost";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An argv word as the job may carry it: no control characters, and the first one names a program, not a flag. */
const ARG = /^[^\u0000-\u001f\u007f]{1,500}$/;

function intIn(where: string, v: unknown, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new AgentError(`${where} is a whole number from ${lo} to ${hi}`);
  return v;
}

function pathsIn(where: string, v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((p) => typeof p === "string" && p !== "" && !p.startsWith("/") && !p.split("/").some((s) => s === ".." ))) {
    throw new AgentError(`${where} is a list of paths from the repository root`);
  }
  return (v as string[]).map((p) => p.replace(/^\.\//, ""));
}

/** The settings of commit job `name` from a spec's `commit`, checked. */
export function resolveCommitSpec(name: string, spec: OpCommitSpec, product = "chant"): CommitSettings {
  const where = `Scheduled Op "${name}" commit`;
  if (!NAME.test(name)) throw new AgentError(`${where}: the name is letters, digits, '.', '_' and '-'`);
  if (!COMMIT_TRIGGERS.includes(spec.on)) throw new AgentError(`${where}: on is "comment" or "check"`);
  if (spec.on === "comment" && !(typeof spec.comment === "string" && /^\/[a-z][a-z0-9-]* [a-z][a-z0-9-]*$/.test(spec.comment))) {
    throw new AgentError(`${where}: on "comment" needs comment, the line it answers, such as "/${product} fmt"`);
  }
  if (!Array.isArray(spec.command) || spec.command.length === 0 || !spec.command.every((a) => typeof a === "string" && ARG.test(a)) || spec.command[0]!.startsWith("-")) {
    throw new AgentError(`${where}: command is an argv, a program and its arguments, with no control characters`);
  }
  const allowed = pathsIn(`${where}: allowed`, spec.allowed);
  const allowedFiles = spec.allowedFiles ?? [];
  if (!Array.isArray(allowedFiles) || !allowedFiles.every((f) => typeof f === "string" && FILE_PATTERN.test(f))) {
    throw new AgentError(`${where}: allowedFiles are file names, such as "*.tf" or "terragrunt.hcl", with no "/"`);
  }
  if (allowed.length === 0 && allowedFiles.length === 0) throw new AgentError(`${where}: allowed or allowedFiles names at least one path the change may touch`);
  const guarded = spec.guarded === undefined ? [] : pathsIn(`${where}: guarded`, spec.guarded);
  if (spec.tokenEnv !== undefined && !VAR.test(spec.tokenEnv)) throw new AgentError(`${where}: tokenEnv is a variable name`);
  const findings = spec.findings ?? [CHANT_EXIT.drift];
  if (!Array.isArray(findings) || findings.length === 0) throw new AgentError(`${where}: findings lists at least one exit code`);
  for (const f of findings) intIn(`${where}: findings`, f, 1, 255);
  const env = spec.env ?? "local";
  if (!NAME.test(env)) throw new AgentError(`${where}: env is a ledger environment name`);
  if (spec.jobToken !== undefined && typeof spec.jobToken !== "boolean") throw new AgentError(`${where}: jobToken is true or false`);
  if (spec.jobToken && spec.tokenEnv !== undefined) throw new AgentError(`${where}: jobToken pushes with the job's own token, so leave tokenEnv out`);
  const after = spec.after ?? [];
  if (!Array.isArray(after) || !after.every((l) => typeof l === "string" && l.trim() !== "" && !l.includes("\n"))) throw new AgentError(`${where}: after is a list of shell lines, one command each`);
  const commandEnv = spec.commandEnv ?? [];
  if (!Array.isArray(commandEnv) || !commandEnv.every((v) => typeof v === "string" && VAR.test(v))) throw new AgentError(`${where}: commandEnv is a list of variable names`);
  const tokens = commandEnv.filter((v) => (FORGE_TOKEN_VARS as readonly string[]).includes(v) || v === spec.tokenEnv || v.startsWith("CHANT_COMMIT_"));
  if (tokens.length > 0) throw new AgentError(`${where}: commandEnv may not pass ${tokens.join(", ")}: the command never sees a forge token or the job's own settings`);
  let commentArg: CommitCommentArg | undefined;
  if (spec.commentArg !== undefined) {
    const a = spec.commentArg as Partial<CommitCommentArg>;
    if (spec.on !== "comment") throw new AgentError(`${where}: commentArg is for the comment trigger, which has a comment to read it from`);
    if (typeof a.pattern !== "string" || !a.pattern.startsWith("^") || !a.pattern.endsWith("$") || a.pattern.length > 200) {
      throw new AgentError(`${where}: commentArg's pattern is a regular expression's source anchored with ^ and $, such as "^[a-z0-9]+(?:[-_][a-z0-9]+)*$"`);
    }
    try {
      new RegExp(a.pattern);
    } catch (e) {
      throw new AgentError(`${where}: commentArg's pattern is not a regular expression (${(e as Error).message})`);
    }
    commentArg = { pattern: a.pattern, position: intIn(`${where}: commentArg's position`, a.position, 1, spec.command.length) };
  }
  return {
    name,
    on: spec.on,
    ...(spec.on === "comment" ? { comment: spec.comment! } : {}),
    command: [...spec.command],
    allowed,
    allowedFiles: [...allowedFiles],
    findings: [...findings],
    maxRuns: spec.maxRuns === undefined ? COMMIT_MAX_RUNS : intIn(`${where}: maxRuns`, spec.maxRuns, 1, 100),
    guarded,
    timeout: spec.timeout === undefined ? COMMIT_TIMEOUT_MINUTES : intIn(`${where}: timeout`, spec.timeout, 1, 120),
    env,
    mergeBase: spec.mergeBase === true,
    jobToken: spec.jobToken === true,
    after: [...after],
    commandEnv: [...new Set(commandEnv)],
    ...(commentArg ? { commentArg } : {}),
  };
}

/** The words that take an argument, for {@link parseProductComment}: this job's word, when it has `commentArg`. */
function commentArgPatterns(s: Partial<Pick<CommitSettings, "comment" | "commentArg">>): Record<string, RegExp> {
  const word = s.comment?.split(" ")[1];
  return word && s.commentArg ? { [word]: new RegExp(s.commentArg.pattern) } : {};
}

/**
 * The argv the command runs (#4820): `command`, with the comment's argument
 * at `commentArg.position` when there is one. An argument the settings do
 * not take, or one off its pattern, throws.
 */
export function commitArgv(s: Pick<CommitSettings, "command"> & Partial<Pick<CommitSettings, "commentArg">>, arg: string | undefined): string[] {
  if (arg === undefined) return [...s.command];
  if (!s.commentArg) throw new AgentError("this commit job takes no argument after its word");
  if (!COMMIT_COMMENT_ARG.test(arg) || !new RegExp(s.commentArg.pattern).test(arg)) throw new AgentError(`${JSON.stringify(arg)} is not a name this commit job takes`);
  return [...s.command.slice(0, s.commentArg.position), arg, ...s.command.slice(s.commentArg.position)];
}

/** The settings as the generated jobs' variables. */
export function commitSettingsEnv(s: CommitSettings): Record<string, string> {
  return {
    [COMMIT_ENV.name]: s.name,
    [COMMIT_ENV.on]: s.on,
    ...(s.comment ? { [COMMIT_ENV.comment]: s.comment } : {}),
    [COMMIT_ENV.command]: JSON.stringify(s.command),
    [COMMIT_ENV.allowed]: JSON.stringify(s.allowed),
    ...(s.allowedFiles.length > 0 ? { [COMMIT_ENV.allowedFiles]: JSON.stringify(s.allowedFiles) } : {}),
    [COMMIT_ENV.findings]: s.findings.join(","),
    [COMMIT_ENV.maxRuns]: String(s.maxRuns),
    ...(s.guarded.length > 0 ? { [COMMIT_ENV.guarded]: JSON.stringify(s.guarded) } : {}),
    [COMMIT_ENV.timeout]: String(s.timeout),
    [COMMIT_ENV.env]: s.env,
    ...(s.mergeBase ? { [COMMIT_ENV.mergeBase]: "1" } : {}),
    ...(s.commandEnv.length > 0 ? { [COMMIT_ENV.commandEnv]: JSON.stringify(s.commandEnv) } : {}),
    ...(s.commentArg ? { [COMMIT_ENV.commentArg]: JSON.stringify(s.commentArg) } : {}),
  };
}

/** The settings back from the job's variables, checked as {@link resolveCommitSpec} checks a spec. */
export function commitSettingsFromEnv(env: Record<string, string | undefined>, product = "chant"): CommitSettings {
  const name = env[COMMIT_ENV.name];
  if (!name) throw new AgentError(`${COMMIT_ENV.name} is not set: run this in a job the Op generator wrote`);
  const list = (k: string): string[] | undefined => {
    const v = env[k];
    if (v === undefined || v === "") return undefined;
    try {
      const parsed: unknown = JSON.parse(v);
      if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === "string")) throw new Error("not a list of strings");
      return parsed as string[];
    } catch (e) {
      throw new AgentError(`${k} is a JSON list of strings (${(e as Error).message})`);
    }
  };
  const num = (k: string): number | undefined => {
    const v = env[k];
    if (v === undefined || v === "") return undefined;
    if (!/^[0-9]+$/.test(v)) throw new AgentError(`${k} is a whole number: got ${JSON.stringify(v)}`);
    return Number(v);
  };
  const f = env[COMMIT_ENV.findings];
  if (f !== undefined && f !== "" && !/^[0-9]+(,[0-9]+)*$/.test(f)) throw new AgentError(`${COMMIT_ENV.findings} is exit codes separated by commas: got ${JSON.stringify(f)}`);
  const maxRuns = num(COMMIT_ENV.maxRuns);
  const timeout = num(COMMIT_ENV.timeout);
  const guarded = list(COMMIT_ENV.guarded);
  let commentArg: CommitCommentArg | undefined;
  const argText = env[COMMIT_ENV.commentArg];
  if (argText) {
    try {
      const parsed = JSON.parse(argText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      commentArg = parsed as CommitCommentArg;
    } catch (e) {
      throw new AgentError(`${COMMIT_ENV.commentArg} is a JSON object with pattern and position (${(e as Error).message})`);
    }
  }
  const spec: OpCommitSpec = {
    on: env[COMMIT_ENV.on] as CommitTrigger,
    ...(env[COMMIT_ENV.comment] ? { comment: env[COMMIT_ENV.comment] } : {}),
    command: list(COMMIT_ENV.command) ?? [],
    allowed: list(COMMIT_ENV.allowed) ?? [],
    ...(list(COMMIT_ENV.allowedFiles) ? { allowedFiles: list(COMMIT_ENV.allowedFiles)! } : {}),
    ...(f ? { findings: f.split(",").map(Number) } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(guarded ? { guarded } : {}),
    ...(env[COMMIT_ENV.env] ? { env: env[COMMIT_ENV.env] } : {}),
    ...(env[COMMIT_ENV.mergeBase] === "1" ? { mergeBase: true } : {}),
    ...(list(COMMIT_ENV.commandEnv) ? { commandEnv: list(COMMIT_ENV.commandEnv)! } : {}),
    ...(commentArg ? { commentArg } : {}),
  };
  return resolveCommitSpec(name, spec, product);
}

// ── what the change may touch ──────────────────────────────────────────────

/** An `allowedFiles` entry: `*.<ext>` or an exact file name, never a path. */
const FILE_PATTERN = /^(\*\.[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)$/;

/** Whether `path`'s basename matches one of `files` (#4758). */
function fileAllowed(path: string, files: readonly string[]): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return files.some((f) => (f.startsWith("*.") ? base.endsWith(f.slice(1)) && base.length > f.length - 1 : base === f));
}

/** Whether `path` is inside one of `allowed` (a trailing `/` names a directory), matched as git spells it, or its file name is in `files`. */
function inAllowed(path: string, allowed: readonly string[], files: readonly string[] = []): boolean {
  return allowed.some((a) => (a.endsWith("/") ? path.startsWith(a) || `${path}/` === a : path === a)) || fileAllowed(path, files);
}

/** The paths of a change the job may not push: outside `allowed`, or on a path no job changes ({@link agentForbiddenPaths}). */
export function commitRefusedPaths(paths: readonly string[], s: Pick<CommitSettings, "allowed" | "guarded"> & Partial<Pick<CommitSettings, "allowedFiles">>): { forbidden: string[]; outside: string[] } {
  return { forbidden: agentForbiddenPaths(paths, s.guarded), outside: paths.filter((p) => !inAllowed(p, s.allowed, s.allowedFiles ?? [])) };
}

// ── the request ────────────────────────────────────────────────────────────

/** What a run was asked for: the pull request, and who asked on the `comment` trigger. */
export interface CommitRequest {
  pr: number;
  /** The commenter, or the person who started the GitLab pipeline. Absent on the `check` trigger. */
  user?: string;
  /** The comment's argument (#4820), checked against `commentArg`. */
  arg?: string;
}

/**
 * A request refused (#4838). `replyOn` is set when the comment named this
 * job's command and was refused as it was read (a bad argument, a stray
 * word): the pull request, who asked, and the comment's first line, so land
 * can say why on the pull request. A comment for another word has none,
 * since that word's own job answers it.
 */
export interface CommitRequestRefusal {
  refused: string;
  replyOn?: { pr: number; user: string; asked: string };
}

/** The most of a comment a refusal reply quotes (#4838). */
const ASKED_MAX = 100;

/** The comment's first line as a reply quotes it, cut at {@link ASKED_MAX}. */
function askedLine(body: string): string {
  const line = body.trim().split(/\r?\n/)[0]!.trim();
  return line.length > ASKED_MAX ? `${line.slice(0, ASKED_MAX - 3)}...` : line;
}

/**
 * The request from the run. `comment`: the event's comment on GitHub and
 * Forgejo, read against the product's grammar, which must name this job's
 * word; on GitLab the pipeline's {@link GITLAB_COMMIT_PR_VAR} and
 * {@link GITLAB_COMMIT_WORD_VAR}, and the user who started it. `check`: the
 * pull request the check ran for, from the `pull_request` event or the
 * merge request pipeline.
 */
export function commitRequestFromRun(words: CiProductWords, s: Pick<CommitSettings, "on" | "comment"> & Partial<Pick<CommitSettings, "commentArg">>, env: Record<string, string | undefined>, event: unknown): CommitRequest | CommitRequestRefusal {
  const gitlab = env.GITLAB_CI === "true";
  let pr: unknown;
  if (s.on === "check") {
    pr = gitlab ? (env.CI_MERGE_REQUEST_IID ? Number(env.CI_MERGE_REQUEST_IID) : openMergeRequestOf(env)) : (event as { pull_request?: { number?: unknown } } | undefined)?.pull_request?.number;
    if (typeof pr !== "number" || !Number.isInteger(pr) || pr < 1) return { refused: "the run names no pull request" };
    return { pr };
  }
  let body: unknown;
  let user: unknown;
  const word = s.comment?.split(" ")[1];
  if (gitlab) {
    pr = Number(env[GITLAB_COMMIT_PR_VAR]);
    const arg = env[GITLAB_COMMIT_ARG_VAR];
    body = env[GITLAB_COMMIT_WORD_VAR] === word ? `${s.comment}${arg ? ` ${arg}` : ""}` : `/${words.product} ${env[GITLAB_COMMIT_WORD_VAR] ?? ""}`;
    user = env.GITLAB_USER_LOGIN;
  } else {
    const e = event as { comment?: { body?: unknown; user?: { login?: unknown } }; issue?: { number?: unknown } } | undefined;
    body = e?.comment?.body;
    pr = e?.issue?.number;
    user = e?.comment?.user?.login;
  }
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr < 1) return { refused: "the run names no pull request" };
  if (typeof user !== "string" || !LOGIN.test(user)) return { refused: "the run names nobody who asked" };
  const parsed = parseProductComment(words, body, env, commentArgPatterns(s));
  if (parsed?.kind === "refused") {
    // #4838: answered only when the comment's command is this job's, so two jobs never both reply.
    const said = typeof body === "string" ? body.trim().split(/[ \t\r\n]+/) : [];
    const ours = said[0] === `/${words.product}` && said[1] === word;
    return { refused: parsed.reason, ...(ours ? { replyOn: { pr, user, asked: askedLine(body as string) } } : {}) };
  }
  if (parsed?.kind !== "commit" || parsed.word !== word) return { refused: `the comment is not ${s.comment}` };
  return { pr, user, ...(parsed.arg !== undefined ? { arg: parsed.arg } : {}) };
}

/**
 * GitLab, a branch pipeline (a check that runs on push): the merge request
 * of this project whose source is the branch, from `CI_OPEN_MERGE_REQUESTS`
 * (`group/project!12,other/fork!3`), which GitLab sets with no token. The
 * first of this project's when there are several; undefined when none.
 */
function openMergeRequestOf(env: Record<string, string | undefined>): number | undefined {
  const project = env.CI_PROJECT_PATH;
  if (!project) return undefined;
  for (const ref of (env.CI_OPEN_MERGE_REQUESTS ?? "").split(",")) {
    const at = ref.trim().lastIndexOf("!");
    if (at > 0 && ref.trim().slice(0, at) === project) {
      const n = Number(ref.trim().slice(at + 1));
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  return undefined;
}

/** The branch a push run is for, on GitHub and Forgejo: `refs/heads/<branch>` from `GITHUB_REF` on a `push` event. */
function pushedBranch(env: Record<string, string | undefined>): string | undefined {
  if (env.GITHUB_EVENT_NAME !== "push") return undefined;
  const ref = env.GITHUB_REF ?? "";
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
}

/**
 * {@link commitRequestFromRun}, and for the `check` trigger of a check that
 * runs on push (as terragucci's does), the open pull request whose head is
 * the pushed branch, asked of the forge on GitHub and Forgejo. A branch with
 * no open pull request is refused as before, which the check trigger skips.
 */
export async function resolveCommitRequest(
  words: CiProductWords,
  s: Pick<CommitSettings, "on" | "comment"> & Partial<Pick<CommitSettings, "commentArg">>,
  env: Record<string, string | undefined>,
  event: unknown,
  forge?: Partial<Pick<PrForge, "findPullRequest">>,
): Promise<CommitRequest | CommitRequestRefusal> {
  const req = commitRequestFromRun(words, s, env, event);
  if (!("refused" in req) || s.on !== "check" || env.GITLAB_CI === "true" || !forge?.findPullRequest) return req;
  const branch = pushedBranch(env);
  if (!branch) return req;
  const found = await forge.findPullRequest(branch);
  return found && found.number > 0 ? { pr: found.number } : { refused: `${branch} has no open pull request` };
}

// ── the files between the jobs ─────────────────────────────────────────────

/** How a run ended, as its record says. `skipped` is a run with nothing to do, which says nothing and is not recorded. */
export type CommitResult = "pushed" | "refused" | "stopped" | "skipped" | "failed";

/** What `commit prepare` decided. The push job reads it as data and checks every field it uses. */
export interface CommitDecision {
  version: 1;
  name: string;
  on: CommitTrigger;
  go: boolean;
  reason?: string;
  /** Why not, as the record says it: `skipped` says nothing on the pull request. */
  stop?: Exclude<CommitResult, "pushed" | "failed">;
  sha?: string;
  pr?: number;
  branch?: string;
  user?: string;
  /** The comment's argument (#4820), which `commit run` puts in the argv. */
  arg?: string;
  /** With `mergeBase`: the base branch and the tip the command ran on. */
  base?: string;
  baseSha?: string;
  started: string;
}

export function readCommitDecision(dir: string): CommitDecision | undefined {
  try {
    const d = JSON.parse(readFileSync(join(dir, COMMIT_DECISION_FILE), "utf8")) as Partial<CommitDecision>;
    if (d.version !== 1 || typeof d.name !== "string" || !COMMIT_TRIGGERS.includes(d.on as CommitTrigger) || typeof d.go !== "boolean" || typeof d.started !== "string") return undefined;
    if (d.sha !== undefined && !SHA.test(d.sha)) return undefined;
    if (d.pr !== undefined && !(Number.isInteger(d.pr) && d.pr > 0)) return undefined;
    if (d.branch !== undefined && !branchOk(d.branch)) return undefined;
    if (d.base !== undefined && !branchOk(d.base)) return undefined;
    if (d.baseSha !== undefined && !SHA.test(d.baseSha)) return undefined;
    if (d.arg !== undefined && !(typeof d.arg === "string" && COMMIT_COMMENT_ARG.test(d.arg))) return undefined;
    return d as CommitDecision;
  } catch {
    return undefined;
  }
}

// ── the ledger ─────────────────────────────────────────────────────────────

/** The commits the job pushed to pull request `pr`, from its run records. */
export function pushedTo(records: readonly Pick<OpRunRecord, "outcomes">[], pr: number): number {
  return records.filter((r) => {
    const c = r.outcomes?.commit as { pr?: unknown; result?: unknown } | undefined;
    return c?.pr === pr && c.result === "pushed";
  }).length;
}

function overRuns(s: Pick<CommitSettings, "maxRuns" | "name">, records: readonly Pick<OpRunRecord, "outcomes">[], pr: number): string | undefined {
  const n = pushedTo(records, pr);
  return n >= s.maxRuns ? `${s.name} pushed ${n} commit${n === 1 ? "" : "s"} to #${pr}, and its limit is ${s.maxRuns}` : undefined;
}

/** Whether the head's own last commit is this job's: the loop guard of the `check` trigger. */
function ownCommit(git: AgentGit, sha: string, name: string): boolean {
  try {
    const values = git(["log", "-1", `--format=%(trailers:key=${COMMIT_TRAILER},valueonly)`, sha]).split("\n").map((v) => v.trim());
    return values.includes(name);
  } catch {
    return false;
  }
}

/** The run record of one commit run: op `<name>`, one phase with one step, the outcome in `outcomes.commit`. */
export function commitRunRecordInput(o: {
  settings: Pick<CommitSettings, "name" | "on" | "env">;
  started: string;
  ended: string;
  result: CommitResult;
  reason: string;
  requestedBy?: string;
  pr?: number;
  commit?: string;
  approvalVoided?: string;
  gitSha?: string;
  runOrigin?: RunOrigin;
}): OpRunRecordInput {
  const ok = o.result === "pushed";
  const durationMs = Math.max(0, Date.parse(o.ended) - Date.parse(o.started)) || 0;
  const status = ok ? "ok" : o.result === "failed" ? "fail" : "skipped";
  return {
    op: o.settings.name,
    env: o.settings.env,
    started: o.started,
    ended: o.ended,
    status: o.result === "failed" ? "fail" : "ok",
    labels: { Commit: o.settings.on },
    outcomes: {
      commit: {
        trigger: o.settings.on,
        result: o.result,
        reason: o.reason,
        ...(o.requestedBy ? { requestedBy: o.requestedBy } : {}),
        ...(o.pr !== undefined ? { pr: o.pr } : {}),
        ...(o.commit ? { commit: o.commit } : {}),
        ...(o.approvalVoided ? { approvalVoided: o.approvalVoided } : {}),
      },
    },
    phases: [{ name: "commit", status, steps: [{ fn: `commit:${o.settings.on}`, status, durationMs, ...(o.result === "failed" ? { error: o.reason } : {}) }] }],
    ...(o.gitSha ? { gitSha: o.gitSha } : {}),
    ...(o.runOrigin ? { runOrigin: o.runOrigin } : {}),
  };
}

// ── the base merge (#4723) ─────────────────────────────────────────────────

/**
 * The branch the pull request merges into: the forge's answer, else the
 * run's own (the `pull_request` event's base, GitLab's target branch).
 */
function baseBranchOf(asked: string | undefined, env: Record<string, string | undefined>, event: unknown): string | undefined {
  const fromEvent = (event as { pull_request?: { base?: { ref?: unknown } } } | undefined)?.pull_request?.base?.ref;
  const b = asked ?? (typeof fromEvent === "string" ? fromEvent : undefined) ?? (env.GITLAB_CI === "true" ? env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME : undefined);
  return b && branchOk(b) ? b : undefined;
}

/** Fetch the base branch's tip into {@link COMMIT_BASE_REF} and return it. */
function fetchBase(git: AgentGit, base: string): string {
  git(["fetch", "-q", "--no-tags", "origin", `+refs/heads/${base}:${COMMIT_BASE_REF}`]);
  return git(["rev-parse", COMMIT_BASE_REF]).trim();
}

/** The identity the base merge is made under; the job's commit carries it too. */
const MERGE_ID = ["-c", `user.name=${COMMIT_GIT_NAME}`, "-c", `user.email=${COMMIT_GIT_EMAIL}`, "-c", "commit.gpgsign=false"];

// ── commit prepare ─────────────────────────────────────────────────────────

/** Who approved the plan of a pull request's head on the ledger, or undefined. The job's own records never answer it. */
export type HeadApproval = (pr: number, sha: string) => Promise<string | undefined>;

export interface CommitPrepareInput {
  settings: CommitSettings;
  words: CiProductWords;
  dir: string;
  env: Record<string, string | undefined>;
  event?: unknown;
  /** A read client: who may write, and the pull request's head. Absent on GitLab, where this job holds no token. */
  forge?: Pick<PrForge, "pullRequestHead" | "userCanWrite"> & Partial<Pick<PrForge, "findPullRequest">>;
  /** The branch pull request `pr` merges into, asked of the forge (./pr-forge-base.ts), for `mergeBase` (#4723). */
  pullRequestBase?: (pr: number) => Promise<string | undefined>;
  readRuns: () => Promise<OpRunRecord[]>;
  approval: HeadApproval;
  git: AgentGit;
  now: Date;
}

/**
 * `chant commit prepare`: decide whether the command runs, and on what. Every
 * outcome is a decision file; the push job answers a refusal. The return is
 * the decision.
 */
export async function prepareCommitRun(i: CommitPrepareInput): Promise<CommitDecision> {
  const s = i.settings;
  const base = { version: 1 as const, name: s.name, on: s.on, started: i.now.toISOString() };
  const write = (d: CommitDecision): CommitDecision => {
    mkdirSync(i.dir, { recursive: true });
    writeFileSync(join(i.dir, COMMIT_DECISION_FILE), JSON.stringify(d, null, 2) + "\n");
    return d;
  };
  const no = (reason: string, stop: CommitDecision["stop"], extra: Partial<CommitDecision> = {}): CommitDecision => write({ ...base, go: false, reason, stop, ...extra });

  const req = await resolveCommitRequest(i.words, s, i.env, i.event, i.forge);
  if ("refused" in req) return no(req.refused, s.on === "check" ? "skipped" : "refused");
  const who = { pr: req.pr, ...(req.user ? { user: req.user } : {}), ...(req.arg !== undefined ? { arg: req.arg } : {}) };
  if (req.user && i.forge?.userCanWrite && !(await i.forge.userCanWrite(req.user))) return no(`${req.user} cannot write to the repository, so ${s.name} does not run for them`, "refused", who);

  let sha: string;
  try {
    sha = i.git(["rev-parse", COMMIT_HEAD_REF]).trim();
  } catch (e) {
    return no(`the pull request's head was not fetched (${errText(e)})`, "refused", who);
  }
  if (!SHA.test(sha)) return no("the pull request's head was not fetched", "refused", who);
  let branch: string | undefined;
  if (i.forge?.pullRequestHead) {
    const head = await i.forge.pullRequestHead(req.pr);
    if (!head) return no(`pull request #${req.pr} could not be read`, "refused", who);
    if (!head.open) return no(`pull request #${req.pr} is not open`, "refused", who);
    if (!head.sameRepo) return no(`pull request #${req.pr} comes from a fork, and ${s.name} pushes only to this repository's branches`, "refused", who);
    if (!branchOk(head.branch)) return no(`pull request #${req.pr}'s branch is not one ${s.name} pushes to`, "refused", who);
    if (sha !== head.sha) return no(`pull request #${req.pr} moved while ${s.name} was starting`, s.on === "check" ? "skipped" : "refused", who);
    branch = head.branch;
  }
  // The loop guard: a check that fails on the job's own commit does not start it again.
  if (s.on === "check" && ownCommit(i.git, sha, s.name)) return no(`the head is ${s.name}'s own commit`, "skipped", { ...who, sha });

  let records: OpRunRecord[];
  try {
    records = await i.readRuns();
  } catch (e) {
    return no(`${s.name}'s runs could not be read from the ledger (${errText(e)}), so its limit cannot be checked`, "refused", who);
  }
  const over = overRuns(s, records, req.pr);
  if (over) return no(over, "stopped", who);

  if (s.on === "check") {
    let approved: string | undefined;
    try {
      approved = await i.approval(req.pr, sha);
    } catch (e) {
      return no(`the approvals could not be read from the ledger (${errText(e)})`, "refused", who);
    }
    if (approved) return no(`the plan of ${sha.slice(0, 8)} is approved by ${approved}, and a commit would void that approval`, "refused", { ...who, sha });
  }
  let merge: { base: string; baseSha: string } | undefined;
  if (s.mergeBase) {
    const target = baseBranchOf(await i.pullRequestBase?.(req.pr), i.env, i.event);
    if (!target) return no(`the branch #${req.pr} merges into is not known, so ${s.name} cannot merge it first`, "refused", who);
    try {
      merge = { base: target, baseSha: fetchBase(i.git, target) };
    } catch (e) {
      return no(`${target} could not be fetched (${errText(e)})`, "refused", who);
    }
  }
  return write({ ...base, go: true, sha, ...who, ...(branch ? { branch } : {}), ...(merge ?? {}) });
}

// ── commit run ─────────────────────────────────────────────────────────────

/**
 * Run an argv in `cwd`, with no shell. A failure or a timeout is an outcome.
 * `output` is the tail of its standard error (#4724), at most
 * {@link COMMIT_OUTPUT_LIMIT} bytes.
 */
export type CommitRunCommand = (argv: readonly string[], o: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<{ exitCode: number | null; timedOut: boolean; output?: string }>;

export const runCommitArgv: CommitRunCommand = (argv, o) =>
  new Promise((done) => {
    let timedOut = false;
    let tail = Buffer.alloc(0);
    const child = spawn(argv[0]!, argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ["ignore", "inherit", "pipe"] });
    // The job's log still gets all of it; the tail is kept for the reply.
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > COMMIT_OUTPUT_LIMIT) tail = tail.subarray(tail.length - COMMIT_OUTPUT_LIMIT);
    });
    const output = (): string => tail.toString("utf8");
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, o.timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      done({ exitCode: null, timedOut, output: output() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ exitCode: code, timedOut, output: output() });
    });
  });

/**
 * The variables the command sees: process basics, with the checkout's
 * `node_modules/.bin` first on `PATH` so a product's bin installed on the
 * target branch runs on the head's files. Never a forge or cloud token. Also
 * the variables the spec's `commandEnv` names, and {@link COMMIT_PR_ENV}, the
 * pull request's number (#4724).
 */
export function commitCommandEnv(env: Record<string, string | undefined>, checkout: string, o: { names?: readonly string[]; pr?: number } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "SystemRoot", "npm_config_cache", ...(o.names ?? [])]) {
    const v = env[name];
    if (v !== undefined) out[name] = v;
  }
  if (o.pr !== undefined) out[COMMIT_PR_ENV] = String(o.pr);
  const bin = join(checkout, "node_modules", ".bin");
  if (existsSync(bin)) out.PATH = out.PATH ? `${bin}:${out.PATH}` : bin;
  return out;
}

export interface CommitRunInput {
  settings: CommitSettings;
  dir: string;
  /** The checkout the job runs in: the target branch, with the product installed. */
  checkout: string;
  /** Where the worktree of the head goes: outside the checkout. */
  workDir: string;
  env: Record<string, string | undefined>;
  git: AgentGit;
  runCommand: CommitRunCommand;
}

/** `chant commit run`: the command in a worktree of the head; what it changed leaves as a patch. This step holds no forge token. */
export async function runCommit(i: CommitRunInput): Promise<{ rc: string; changed: boolean }> {
  const rcFile = join(i.dir, COMMIT_RC_FILE);
  const decision = readCommitDecision(i.dir);
  if (!decision || !decision.go || !decision.sha) {
    writeFileSync(rcFile, "refused\n");
    return { rc: "refused", changed: false };
  }
  let argv: string[];
  try {
    argv = commitArgv(i.settings, decision.arg);
  } catch {
    writeFileSync(rcFile, "refused\n");
    return { rc: "refused", changed: false };
  }
  i.git(["worktree", "add", "--detach", "--force", i.workDir, decision.sha]);
  if (i.settings.mergeBase) {
    if (!decision.baseSha) {
      writeFileSync(rcFile, "refused\n");
      return { rc: "refused", changed: false };
    }
    try {
      i.git([...MERGE_ID, "merge", "-q", "--no-ff", "--no-edit", decision.baseSha], { cwd: i.workDir });
    } catch {
      writeFileSync(rcFile, "conflict\n");
      writeFileSync(join(i.dir, COMMIT_PATCH_FILE), "");
      return { rc: "conflict", changed: false };
    }
  }
  const env = commitCommandEnv(i.env, i.checkout, { names: i.settings.commandEnv, ...(decision.pr !== undefined ? { pr: decision.pr } : {}) });
  const out = await i.runCommand(argv, { cwd: i.workDir, env, timeoutMs: i.settings.timeout * 60_000 });
  const rc = out.timedOut ? "timeout" : out.exitCode === null ? "no-exit" : String(out.exitCode);
  writeFileSync(rcFile, `${rc}\n`);
  if (out.output) writeFileSync(join(i.dir, COMMIT_OUTPUT_FILE), out.output.slice(-COMMIT_OUTPUT_LIMIT));
  i.git(["add", "-A"], { cwd: i.workDir });
  const patch = i.git(["diff", "--cached", "--binary", "--no-renames", "HEAD"], { cwd: i.workDir });
  writeFileSync(join(i.dir, COMMIT_PATCH_FILE), patch);
  return { rc, changed: patch.length > 0 };
}

// ── the harness's BREAK switch (#4836) ─────────────────────────────────────

/**
 * The push job's variable that turns one of land's checks off, for a BREAK
 * arm of a product's e2e harness scenario: a comma list of
 * {@link COMMIT_HARNESS_CHECKS}. It proves the check matters: with it off,
 * the scenario's expectations must fail. Read only by `chant commit land`,
 * and refused anywhere but chant's harness ({@link commitHarnessBreaks}).
 * The command never sees it: `commandEnv` refuses every `CHANT_COMMIT_*`.
 */
export const COMMIT_HARNESS_BREAK_ENV = "CHANT_COMMIT_HARNESS_BREAK";

/**
 * The checks the switch may turn off. `paths`: a change outside `allowed`
 * and `allowedFiles` lands (a guarded path is still refused). `moved-base`:
 * with `mergeBase`, a base that moved while the command ran lands the merge
 * of the tip the command ran on.
 */
export const COMMIT_HARNESS_CHECKS = ["paths", "moved-base"] as const;
export type CommitHarnessCheck = (typeof COMMIT_HARNESS_CHECKS)[number];

/** The forge a job of chant's e2e harness reaches, `HARNESS_HOSTS.forgejo` (./e2e-harness/stack.ts). */
export const COMMIT_HARNESS_FORGE = "http://forgejo:3000";

const HARNESS_WORDS: Record<CommitHarnessCheck, string> = { paths: "the path check", "moved-base": "the moved-base check" };

/**
 * The checks {@link COMMIT_HARNESS_BREAK_ENV} turns off, or why it is
 * refused. It is read only in a BREAK arm of chant's e2e harness: `BREAK=1`,
 * not GitLab, and a job whose `GITHUB_SERVER_URL` is the harness's Forgejo,
 * {@link COMMIT_HARNESS_FORGE}. Unset or empty, no check is off.
 */
export function commitHarnessBreaks(env: Record<string, string | undefined>): { checks: CommitHarnessCheck[] } | { refused: string } {
  const raw = env[COMMIT_HARNESS_BREAK_ENV]?.trim() ?? "";
  if (raw === "") return { checks: [] };
  const server = env.GITHUB_SERVER_URL?.replace(/\/+$/, "");
  if (env.BREAK !== "1" || env.GITLAB_CI === "true" || server !== COMMIT_HARNESS_FORGE) {
    return { refused: `${COMMIT_HARNESS_BREAK_ENV} is read only in a BREAK arm of chant's e2e harness (BREAK=1 on the harness's Forgejo, ${COMMIT_HARNESS_FORGE}), and this job is not one` };
  }
  const named = raw.split(",").map((c) => c.trim()).filter((c) => c !== "");
  const bad = named.filter((c) => !(COMMIT_HARNESS_CHECKS as readonly string[]).includes(c));
  if (bad.length > 0) return { refused: `${COMMIT_HARNESS_BREAK_ENV} names ${bad.join(", ")}; the checks it turns off are ${COMMIT_HARNESS_CHECKS.join(" and ")}` };
  return { checks: [...new Set(named)] as CommitHarnessCheck[] };
}

// ── commit land ────────────────────────────────────────────────────────────

/**
 * A product's reply to a command that exited non-zero (#4724): the text that
 * says why, from the command's exit code and the tail of its standard error,
 * or undefined for chant's own reply. The output comes from a command run on
 * the pull request's files, so a reply quotes from it only what it checked.
 * A reply makes the run `refused`, not `failed`.
 */
export type CommitRefusalReply = (o: { settings: CommitSettings; rc: string; output: string }) => string | undefined;

let activeRefusalReply: CommitRefusalReply | undefined;

/** Set the refusal reply for this process (a product's bin, once, as it sets its words). Returns the one it replaced. */
export function setCommitRefusalReply(reply: CommitRefusalReply | undefined): CommitRefusalReply | undefined {
  const was = activeRefusalReply;
  activeRefusalReply = reply;
  return was;
}

/** The refusal reply {@link setCommitRefusalReply} set, if any. */
export function activeCommitRefusalReply(): CommitRefusalReply | undefined {
  return activeRefusalReply;
}

export interface CommitLandOutcome {
  result: CommitResult;
  reason: string;
  commit?: string;
  paths?: string[];
  requestedBy?: string;
  code: number;
}

export interface CommitLandInput {
  settings: CommitSettings;
  words: CiProductWords;
  dir: string;
  workDir: string;
  env: Record<string, string | undefined>;
  event?: unknown;
  /** A write client. */
  forge: Pick<PrForge, "pullRequestHead" | "addComment"> & Partial<Pick<PrForge, "findPullRequest">>;
  /** As {@link CommitPrepareInput.pullRequestBase}: the land checks the base is still the one the command ran on. */
  pullRequestBase?: (pr: number) => Promise<string | undefined>;
  git: AgentGit;
  /** Push `HEAD` of `cwd` to `ref`, never with force. */
  push: (o: { cwd: string; ref: string }) => void;
  readRuns: () => Promise<OpRunRecord[]>;
  approval: HeadApproval;
  /** Append the run's record to the ledger and push it. */
  record: (input: OpRunRecordInput) => Promise<void>;
  now: () => Date;
  runOrigin?: RunOrigin;
  /** The product's reply to a command that exited non-zero (#4724). */
  refusalReply?: CommitRefusalReply;
}

const code = (s: string): string => "`" + s.replaceAll("`", "'") + "`";

/**
 * `chant commit land`: from the commit job's patch to a pushed commit, or a
 * reply saying why not. The request comes from the event again; the
 * decision file is the commit job's and is checked against what this job
 * reads itself. Every outcome but `skipped` is recorded on the ledger.
 */
export async function landCommitChange(i: CommitLandInput): Promise<CommitLandOutcome> {
  const s = i.settings;
  const started = readCommitDecision(i.dir)?.started ?? i.now().toISOString();
  const product = i.words.product;
  const what = i.env.GITLAB_CI === "true" ? "merge request" : "pull request";
  let pr: number | undefined;
  let user: string | undefined;
  let headSha: string | undefined;

  const say = async (text: string): Promise<void> => {
    if (pr === undefined) return;
    try {
      await i.forge.addComment(pr, `${product}: ${text}`);
    } catch (e) {
      console.error(`${product}: could not reply on #${pr}: ${errText(e)}`);
    }
  };
  const finish = async (o: Omit<CommitLandOutcome, "code" | "requestedBy"> & { approvalVoided?: string }, reply?: string): Promise<CommitLandOutcome> => {
    // A check run replies only when it pushed: a refusal there is the check's own red, already on the pull request.
    if (reply && (s.on === "comment" || o.result === "pushed")) await say(reply);
    const out = { result: o.result, reason: o.reason, ...(o.commit ? { commit: o.commit } : {}), ...(o.paths ? { paths: o.paths } : {}), ...(user ? { requestedBy: user } : {}) };
    if (o.result === "skipped") return { ...out, code: CHANT_EXIT.done };
    try {
      await i.record(
        commitRunRecordInput({
          settings: s,
          started,
          ended: i.now().toISOString(),
          result: o.result,
          reason: o.reason,
          ...(user ? { requestedBy: user } : {}),
          ...(pr !== undefined ? { pr } : {}),
          ...(o.commit ? { commit: o.commit } : {}),
          ...(o.approvalVoided ? { approvalVoided: o.approvalVoided } : {}),
          ...(headSha ? { gitSha: headSha } : {}),
          ...(i.runOrigin ? { runOrigin: i.runOrigin } : {}),
        }),
      );
    } catch (e) {
      // The limit counts on the record, so one that cannot be written fails the job.
      console.error(`${product}: could not record the ${s.name} run on the ledger: ${errText(e)}`);
      return { ...out, code: CHANT_EXIT.failed };
    }
    return { ...out, code: o.result === "failed" ? CHANT_EXIT.failed : CHANT_EXIT.done };
  };

  // Who asked and for which pull request: from the event, never from the commit job's files.
  const req = await resolveCommitRequest(i.words, s, i.env, i.event, i.forge);
  if ("refused" in req) {
    // #4838: a comment refused as it was read is answered, naming it and why.
    if (!req.replyOn) return finish({ result: s.on === "check" ? "skipped" : "refused", reason: req.refused });
    ({ pr, user } = req.replyOn);
    return finish({ result: "refused", reason: req.refused }, `${code(req.replyOn.asked)} was refused: ${req.refused}. ${s.name} did not run, and nothing was pushed.`);
  }
  ({ pr, user } = req);
  // #4836: a BREAK arm of the harness may turn a check off; anywhere else the switch fails the land.
  const harness = commitHarnessBreaks(i.env);
  if ("refused" in harness) return finish({ result: "failed", reason: harness.refused }, `${harness.refused}, so nothing was pushed.`);
  const off = new Set(harness.checks);
  const decision = readCommitDecision(i.dir);
  if (!decision || decision.name !== s.name || decision.on !== s.on || (decision.pr !== undefined && decision.pr !== pr) || (decision.go && decision.arg !== req.arg)) {
    return finish({ result: "failed", reason: "the commit job left no decision this job can read" }, "the commit job left nothing to land, so nothing was pushed.");
  }
  if (!decision.go) return finish({ result: decision.stop ?? "refused", reason: decision.reason ?? "refused" }, `${decision.reason ?? `${s.name} did not run`}, so nothing was pushed.`);
  // What ran, as the replies and the commit name it: the command with the comment's argument (#4820).
  let ranArgv: string;
  try {
    ranArgv = commitArgv(s, req.arg).join(" ");
  } catch (e) {
    return finish({ result: "refused", reason: errText(e) }, `${errText(e)}, so nothing was pushed.`);
  }
  const rc = readSmall(join(i.dir, COMMIT_RC_FILE))?.trim() ?? "";
  if (rc === "conflict") {
    return finish({ result: "refused", reason: `merging ${decision.base ?? "the base"} into the head conflicts` }, `merging ${code(decision.base ?? "the base")} into the ${what} conflicts, so ${s.name} did not run and nothing was pushed. Resolve the conflict on the branch.`);
  }
  if (rc === "timeout") return finish({ result: "stopped", reason: `the command passed its ${s.timeout} minute limit` }, `${code(ranArgv)} was stopped at its ${s.timeout} minute limit, so nothing was pushed.`);
  if (rc !== "0" && /^[0-9]+$/.test(rc) && i.refusalReply) {
    let said: string | undefined;
    try {
      said = i.refusalReply({ settings: s, rc, output: readSmall(join(i.dir, COMMIT_OUTPUT_FILE), COMMIT_OUTPUT_LIMIT * 2) ?? "" });
    } catch {
      said = undefined;
    }
    if (said) return finish({ result: "refused", reason: `the command refused, exiting ${rc}` }, `${said.trim()} Nothing was pushed.`);
  }
  if (rc !== "0") return finish({ result: "failed", reason: `the command exited ${rc || "with no code"}` }, `${code(ranArgv)} stopped with ${rc ? `exit code ${rc}` : "no exit code"}, so nothing was pushed. The commit job's log has its output.`);

  const head = await i.forge.pullRequestHead?.(pr!).catch(() => undefined);
  if (!head || !head.open || !head.sameRepo || !branchOk(head.branch)) return finish({ result: "refused", reason: `#${pr} is not an open ${what} from this repository` }, `#${pr} is not an open ${what} from this repository, so nothing was pushed.`);
  let sha: string;
  try {
    sha = i.git(["rev-parse", COMMIT_HEAD_REF]).trim();
  } catch (e) {
    return finish({ result: "failed", reason: `could not read the head (${errText(e)})` });
  }
  headSha = sha;
  if (sha !== head.sha || sha !== decision.sha) return finish({ result: s.on === "check" ? "skipped" : "refused", reason: "the head moved" }, `the ${what} moved while ${s.name} ran, so nothing was pushed. Ask again.`);
  let baseSha: string | undefined;
  if (s.mergeBase) {
    const target = baseBranchOf(await i.pullRequestBase?.(pr!), i.env, i.event);
    if (!target || target !== decision.base || !decision.baseSha) return finish({ result: "refused", reason: "the base branch is not the one the command ran on" }, `the branch #${pr} merges into is not the one ${s.name} merged, so nothing was pushed. Ask again.`);
    try {
      baseSha = fetchBase(i.git, target);
    } catch (e) {
      return finish({ result: "failed", reason: `could not fetch ${target} (${errText(e)})` });
    }
    if (baseSha !== decision.baseSha) {
      if (!off.has("moved-base")) return finish({ result: s.on === "check" ? "skipped" : "refused", reason: "the base moved" }, `${code(target)} moved while ${s.name} ran, so nothing was pushed. Ask again.`);
      // BREAK: land the merge of the tip the command ran on, which the check exists to stop.
      baseSha = decision.baseSha;
    }
  }

  // The limit and the approval again, on this job's own read.
  const earlier = (await i.readRuns().catch(() => [] as OpRunRecord[])).filter((r) => Date.parse(r.started) < Date.parse(started));
  const over = overRuns(s, earlier, pr!);
  if (over) return finish({ result: "stopped", reason: over }, `${over}, so nothing was pushed.`);
  let approved: string | undefined;
  try {
    approved = await i.approval(pr!, sha);
  } catch (e) {
    return finish({ result: "failed", reason: `the approvals could not be read from the ledger (${errText(e)})` }, `the approvals could not be read from the ledger, so nothing was pushed.`);
  }
  if (approved && s.on === "check") return finish({ result: "refused", reason: `the plan of ${sha.slice(0, 8)} is approved by ${approved}, and a commit would void that approval` });

  const patch = join(i.dir, COMMIT_PATCH_FILE);
  const nothing = (): Promise<CommitLandOutcome> =>
    finish({ result: s.on === "check" ? "skipped" : "refused", reason: "the command changed nothing" }, `${code(ranArgv)} changed nothing, so nothing was pushed.`);
  if (!existsSync(patch) || statSync(patch).size === 0) return nothing();
  let paths: string[];
  try {
    i.git(["worktree", "add", "--detach", "--force", i.workDir, sha]);
    // The same merge the commit job made, with no code run: the patch was taken against it.
    let against = "HEAD";
    if (baseSha) {
      try {
        i.git([...MERGE_ID, "merge", "-q", "--no-ff", "--no-commit", baseSha], { cwd: i.workDir });
      } catch {
        return finish({ result: "refused", reason: `merging ${decision.base} into the head conflicts` }, `merging ${code(decision.base!)} into the ${what} conflicts, so nothing was pushed.`);
      }
      against = i.git(["write-tree"], { cwd: i.workDir }).trim();
    }
    i.git(["apply", "--index", "--binary", "--whitespace=nowarn", patch], { cwd: i.workDir });
    paths = i.git(["diff", "--cached", "--name-only", "--no-renames", "-z", against], { cwd: i.workDir }).split("\0").filter(Boolean);
  } catch (e) {
    return finish({ result: "refused", reason: `the patch does not apply to ${sha.slice(0, 8)}` }, `the change does not apply to ${sha.slice(0, 8)} (${errText(e)}), so nothing was pushed.`);
  }
  if (paths.length === 0) return nothing();
  const refusedPaths = commitRefusedPaths(paths, s);
  const forbidden = refusedPaths.forbidden;
  const outside = off.has("paths") ? [] : refusedPaths.outside;
  if (forbidden.length > 0 || outside.length > 0) {
    const bad = [...new Set([...forbidden, ...outside])];
    return finish(
      { result: "refused", reason: `the change touches ${bad.join(", ")}`, paths },
      `${code(ranArgv)} changed ${bad.map(code).join(", ")}, which ${s.name} may not change (it may change ${[...s.allowed, ...s.allowedFiles].map(code).join(", ")}, and never CI, chant's settings and state, code owners, agent instructions or git settings), so nothing was pushed.`,
    );
  }

  const title = s.on === "comment" ? `${s.comment}${req.arg !== undefined ? ` ${req.arg}` : ""} asked for by ${user} on ${what} #${pr}` : `${s.name} after the check found something at ${sha.slice(0, 8)}`;
  const ran = baseSha ? `Merged ${decision.base} at ${baseSha.slice(0, 12)} into ${sha.slice(0, 12)}, then ran ${ranArgv}.` : `Ran ${ranArgv} on ${sha.slice(0, 12)}.`;
  const message = [title, "", ran, "", ...(user ? [`Requested-by: ${user}`] : []), `${COMMIT_TRAILER}: ${s.name}`, ""].join("\n");
  let commitSha: string;
  try {
    i.git([...MERGE_ID, "commit", "-q", "-F", "-"], { cwd: i.workDir, input: message });
    commitSha = i.git(["rev-parse", "HEAD"], { cwd: i.workDir }).trim();
  } catch (e) {
    return finish({ result: "failed", reason: `could not commit (${errText(e)})` });
  }
  // Never a force push to a person's branch: a branch that moved keeps what it has.
  try {
    i.push({ cwd: i.workDir, ref: `refs/heads/${head.branch}` });
  } catch (e) {
    return finish({ result: "failed", reason: `could not push to ${head.branch} (${errText(e)})`, commit: commitSha }, `could not push to ${code(head.branch)} (${errText(e)}), so nothing was pushed.`);
  }
  const breakNote = off.size > 0 ? ` (BREAK: ${[...off].map((c) => HARNESS_WORDS[c]).join(" and ")} ${off.size === 1 ? "was" : "were"} off)` : "";
  const voided = approved ? ` The plan of ${code(sha.slice(0, 8))} was approved by ${approved}; the new commit is planned again and needs approval again.` : "";
  return finish(
    { result: "pushed", reason: `pushed ${commitSha} to ${head.branch}${breakNote}`, commit: commitSha, paths, ...(approved ? { approvalVoided: approved } : {}) },
    `pushed ${code(commitSha.slice(0, 8))} to ${code(head.branch)}${user ? ` for ${user}` : ""}, from ${baseSha ? `a merge of ${code(decision.base!)} and ` : ""}${code(ranArgv)}, changing ${paths.map(code).join(", ")}.${voided} Nothing was applied, approved or merged.${breakNote}`,
  );
}

// ── what the generated jobs run ────────────────────────────────────────────

/** The three commands of the commit jobs, through the product's bin. */
export function commitCommandLines(forge: "github" | "gitlab" | "forgejo", bin?: string, dir: string = COMMIT_DIR): { prepare: string; run: string; land: string } {
  if (!/^[A-Za-z0-9._\/-]+$/.test(dir) || dir.split("/").includes("..")) throw new AgentError(`the commit directory ${JSON.stringify(dir)} is a plain path from the repository root`);
  const line = (action: string): string => {
    const chant = ["chant", "commit", action, "--forge", forge, "--output", dir].join(" ");
    return bin ? chant.replace(/^chant /, `${bin} `) : chant;
  };
  return { prepare: line("prepare"), run: line("run"), land: line("land") };
}
