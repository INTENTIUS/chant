/**
 * `chant ci run plan|apply` (#4094, epic #4101): run one pull-request job as
 * a pipeline Op, the first slice of the chant runner.
 *
 * The job is the typed value `prLoopJobs` (../components/pr-pipeline.ts)
 * returns, the one the github, gitlab and forgejo generators wrap in a
 * workflow, so the runner and a generated workflow run the same command with
 * the same values. Nothing reads generated YAML.
 *
 * The job runs as an Op on the local executor (../op/local-executor.ts):
 *
 * - a `setup` phase with the setup lines the default image needs,
 * - a `build` phase with the lines given to run before the command
 *   (`--before-script`, which a generated workflow runs in the same place),
 *   then the job's build and lint lines with `--pr-build` (#4088),
 * - and a phase named for the job, `plan` or `apply`, with the job's own
 *   setup lines and its command in one shell.
 *
 * Each line is one shell step with a clean environment: a short list of the
 * runner's variables (PATH, HOME and the like), the forge's connection and
 * token variables the commands read, any `--pass-env` names, and the job's
 * own variables. The forge values a generated job reads from `${{ ... }}`
 * expressions or GitLab's predefined variables come from flags here:
 * `BASE_SHA` from `--base`, `PR_NUMBER` from `--pr`, and the commit from
 * `--commit`.
 *
 * The steps run in a fresh checkout of the commit: a detached `git worktree`
 * in a temporary directory outside the repository, removed when the run
 * ends. A worktree shares the repository's refs, so what the job records on
 * `chant/lifecycle` (pr-apply's pending gate facts) and the remote it pushes
 * to are the repository's own, as in a forge job's checkout. The report the
 * job writes under `.chant/pr` is copied out of the worktree before it goes,
 * where a forge would keep it as an artifact.
 *
 * The run is recorded as Op `pr-plan` or `pr-apply` in the run ledger
 * (`<env>/runs__<op>.jsonl` on `chant/lifecycle`), and signed when a runner
 * key is given, so `chant ci tick --source runs` (#4044) judges the commit
 * from it. Its events are `kind: "pipeline"` and `runtime: "ci"`, and the
 * record and the events carry `runOrigin: { forge: "chant" }`.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { PR_APPLY_RECORD, PR_LOOP_REPORT_DIR, prLoopJobs, prLoopSetup, PR_LOOP_IMAGE, type PrLoopJob, type PrLoopPipelineOptions } from "../components/pr-pipeline";
import { detectForge, FORGE_KINDS, type ForgeKind } from "../pr-forge";
import type { CommandContext } from "../cli/registry";
import { formatError, formatWarning } from "../cli/format";
import type { RunOrigin } from "../lifecycle/release-ledger";
import { pushLifecycleReport } from "../lifecycle/git";
import { ACTIVITY_PROFILES } from "../op/activity-profiles";
import type { ActivityFn, ActivityProfile } from "../op/activity-registry";
import { shellCmd } from "../op/activities/shell";
import { OpRunFailure, runOpLocally, type OpRunResult, type StepRecord } from "../op/local-executor";
import type { OpRunFailureReason, OpRunRecord } from "../op/runtime";
import type { ActivityStep, OpConfig, PhaseDefinition } from "../op/types";
import { findWorkspaceRoot } from "../project-root";
import { ciTagSigner, RUNNER_KEY_ENV } from "./ci-green";
import { resolveMemberContext } from "./member-pipeline";
import { signOpRunRecord } from "./trust/op-run-statement";
import { gitTop } from "./tree";

/** The two jobs a pull-request pipeline has. */
export type CiJobName = PrLoopJob["jobName"];
export const CI_JOB_NAMES: readonly CiJobName[] = ["plan", "apply"];

/** The Op each job is recorded as, which `ci.green` phases match. */
export const CI_JOB_OPS: Record<CiJobName, string> = { plan: "pr-plan", apply: "pr-apply" };

/** Where a job the chant runner ran says it ran (#4094). */
export const CHANT_RUNNER_ORIGIN: RunOrigin = { forge: "chant" };

/** The runner's variables every job gets, when the runner has them. */
export const CI_RUN_BASE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"] as const;

/**
 * The forge's connection and token variables the pull-request commands read
 * (`forgeFromEnv` in ../pr-forge.ts), which a forge job gets from the forge
 * and a job here gets from the runner's environment.
 */
export const CI_RUN_FORGE_ENV = [
  "CHANT_FORGE_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_SERVER_URL",
  "GITHUB_API_URL",
  "GITLAB_TOKEN",
  "CI_API_V4_URL",
  "CI_PROJECT_ID",
  "CI_SERVER_HOST",
  "CI_SERVER_URL",
] as const;

/** How long one step may run: a forge job's own limit, six hours. */
const STEP_TIMEOUT = "6h";

/** The forge values a job reads, given on the command line in place of a forge's expressions. */
export interface CiRunValues {
  /** `--base`: the commit the change is measured from, `BASE_SHA`. */
  base?: string;
  /** `--pr`: the pull request, `PR_NUMBER`. The plan needs it. */
  pr?: number;
  /** The full commit the job runs at. */
  commit: string;
}

export class CiRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CiRunError";
  }
}

/**
 * The job's environment: the runner's base variables, the forge variables
 * and `passEnv` names it has, `CHANT_ENV` as a generated workflow sets it,
 * the commit as the forge spells it, and the job's own variables. A job
 * variable the forge fills from an expression comes from a flag, or from
 * the runner's environment for a token such as `GITHUB_TOKEN`; a literal
 * one, such as `CHANT_RUN_EVENTS_DIR`, is kept as it is.
 */
export function ciJobEnv(
  job: PrLoopJob,
  input: { forge: ForgeKind; env: string; values: CiRunValues; hostEnv: Record<string, string | undefined>; passEnv?: readonly string[] },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...CI_RUN_BASE_ENV, ...CI_RUN_FORGE_ENV, ...(input.passEnv ?? [])]) {
    const value = input.hostEnv[name];
    if (value !== undefined) out[name] = value;
  }
  out.CHANT_ENV = input.env;
  out[input.forge === "gitlab" ? "CI_COMMIT_SHA" : "GITHUB_SHA"] = input.values.commit;
  const flags: Record<string, { value: string | undefined; flag: string }> = {
    BASE_SHA: { value: input.values.base, flag: "--base <sha>" },
    PR_NUMBER: { value: input.values.pr !== undefined ? String(input.values.pr) : undefined, flag: "--pr <number>" },
  };
  for (const [name, value] of Object.entries(job.env)) {
    const given = flags[name];
    if (given) {
      if (given.value === undefined) throw new CiRunError(`the ${job.jobName} job reads ${name}, which a forge fills from the event; pass ${given.flag}`);
      out[name] = given.value;
    } else if (!value.includes("$")) {
      out[name] = value;
    } else if (input.hostEnv[name] !== undefined) {
      out[name] = input.hostEnv[name]!;
    }
  }
  return out;
}

/** What {@link ciJobOp} builds the Op from. */
export interface CiJobOpInput {
  job: PrLoopJob;
  env: string;
  /** The directory the steps run in, inside the fresh checkout. */
  cwd: string;
  /** The job's environment, from {@link ciJobEnv}. */
  jobEnv: Record<string, string>;
  /** Setup lines, from `prLoopSetup`. */
  setup: readonly string[];
  /** Lines to run before the command, in order: `--before-script`, then the job's build and lint lines (#4088). */
  build: readonly string[];
  /** What runs chant, in place of `chant` at the start of the command. */
  chant?: string;
}

/** `line` with a `chant` at its start replaced by the command the caller names, when it names one. */
export function withChant(line: string, chant?: string): string {
  return chant && line.startsWith("chant ") ? `${chant}${line.slice("chant".length)}` : line;
}

/** The job's own setup lines and its command, as one shell script, with `chant` at its start replaced by the command the caller names. */
export function ciJobCommand(job: PrLoopJob, chant?: string): string {
  return [...(job.setup ?? []), withChant(job.command, chant)].join("\n");
}

/**
 * The job as an Op: `setup`, `build` and the job's own phase, each line one
 * shell step in `cwd` with the job's environment and nothing else. A phase
 * with no lines is left out.
 */
export function ciJobOp(input: CiJobOpInput): OpConfig {
  const step = (cmd: string): ActivityStep => ({
    kind: "activity",
    fn: "shellCmd",
    args: { cmd, cwd: input.cwd, env: input.jobEnv, inheritEnv: false },
    profile: "atMostOnce",
    timeout: STEP_TIMEOUT,
  });
  const phases: PhaseDefinition[] = [
    { name: "setup", steps: input.setup.map(step) },
    { name: "build", steps: input.build.map((line) => step(withChant(line, input.chant))) },
    { name: input.job.jobName, steps: [step(ciJobCommand(input.job, input.chant))] },
  ].filter((p) => p.steps.length > 0);
  const op = CI_JOB_OPS[input.job.jobName];
  return {
    name: op,
    overview: input.job.jobName === "plan" ? "Plan the members this pull request reaches" : "Apply the plan a reviewer approved",
    labels: { Env: input.env, Pipeline: "pr", Job: input.job.jobName },
    phases,
  };
}

/** The pull-request report statuses that mean the job did not do its work, which a failed job's `failure.code` takes. */
const FAILED_REPORT_STATUSES = new Set(["plan-failed", "failed", "refused"]);

/** The exit code a failed shell step's error names (`command exited <n>`), when it names one. */
function exitCodeOf(error: string | undefined): number | undefined {
  const m = /command exited (\d+)/.exec(error ?? "");
  return m ? Number(m[1]) : undefined;
}

/** The first line of a step's error, for a reason. */
const firstLine = (text: string): string => text.split("\n").find((l) => l.trim() !== "")?.trim() ?? text;

/**
 * Why a failed job failed (#4094), from its step records and, when the
 * command wrote one, its pull-request report (`pr-plan.json` or
 * `pr-apply.json` under `reportDir`):
 *
 * - a failed setup or build line: `setup-failed` or `build-failed`, the line
 *   and its exit code as the reason, and the phase;
 * - a failed command with a report: the report's `refusal`, else its
 *   `status`, with its `message` as the reason, else the members that failed;
 * - a failed command with no report: `command-failed` and the step's error.
 *
 * Undefined when no step failed, such as a run that stopped on an error of
 * its own before any step ran.
 */
export function ciJobFailure(input: { job: CiJobName; op: OpConfig; records: readonly StepRecord[]; reportDir: string }): OpRunFailureReason | undefined {
  const failed = input.records.find((r) => r.status === "fail");
  if (!failed) return undefined;
  const exitCode = exitCodeOf(failed.error);
  const exit = exitCode !== undefined ? { exitCode } : {};
  if (failed.phase === "setup" || failed.phase === "build") {
    const at = input.records.filter((r) => r.phase === failed.phase).indexOf(failed);
    const step = input.op.phases.find((p) => p.name === failed.phase)?.steps[at] as ActivityStep | undefined;
    const line = typeof step?.args?.cmd === "string" ? step.args.cmd : undefined;
    const reason = line !== undefined
      ? `${line} ${exitCode !== undefined ? `exited ${exitCode}` : `failed: ${firstLine(failed.error ?? "")}`}`
      : firstLine(failed.error ?? "the step failed");
    return { code: `${failed.phase}-failed`, reason, phase: failed.phase, ...exit };
  }
  const file = join(input.reportDir, `${CI_JOB_OPS[input.job]}.json`);
  let report: { status?: unknown; refusal?: unknown; message?: unknown; members?: unknown } | undefined;
  try {
    if (existsSync(file)) report = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    report = undefined;
  }
  const status = typeof report?.status === "string" ? report.status : undefined;
  if (report && status && (FAILED_REPORT_STATUSES.has(status) || typeof report.refusal === "string")) {
    const code = typeof report.refusal === "string" ? report.refusal : status;
    let reason = typeof report.message === "string" && report.message.trim() !== "" ? firstLine(report.message) : undefined;
    if (reason === undefined) {
      const members = Array.isArray(report.members) ? (report.members as { member?: unknown; status?: unknown; error?: unknown }[]) : [];
      const bad = members.filter((m) => m.status === "failed" || m.status === "plan-failed");
      reason = bad.length > 0
        ? `${bad.length === 1 ? "member" : "members"} ${bad.map((m) => `${String(m.member)} ${String(m.status)}${typeof m.error === "string" ? ` (${firstLine(m.error)})` : ""}`).join(", ")}`
        : `the ${CI_JOB_OPS[input.job]} report says ${status}`;
    }
    return { code, reason, phase: failed.phase, ...exit };
  }
  return { code: "command-failed", reason: firstLine(failed.error ?? "the command failed"), phase: failed.phase, ...exit };
}

/** What `chant ci run` runs. */
export interface CiRunRequest {
  /** Where the command was run: the project, or a workspace member's directory. */
  cwd: string;
  job: CiJobName;
  /** `--env`: the environment the pipeline is for. */
  env: string;
  forge: ForgeKind;
  /** `--base`, `--pr` and `--commit` (default `HEAD`). */
  base?: string;
  pr?: number;
  commit?: string;
  /** The generator's options: `--gate`, `--branch`, `--events-json`, `--report-url`, `--pr-build` and `--pr-build-command`. */
  loop?: PrLoopPipelineOptions;
  /** `--image`: the image a generated pipeline names. Only the default gets setup lines. */
  image?: string;
  /** `--before-script` lines, run in the build phase before the job's build lines. */
  beforeScript?: readonly string[];
  /** `--chant`: what runs chant in the job. Default `chant`. */
  chant?: string;
  /** `--pass-env`: more of the runner's variables the job gets. */
  passEnv?: readonly string[];
  /** The runner's environment. Default `process.env`. */
  hostEnv?: Record<string, string | undefined>;
  /** `--output`: where the job's report is copied, from `cwd`. Default `.chant/pr`. */
  output?: string;
  /** A runner key, PEM, that signs the run's record. */
  runnerKey?: string;
  /**
   * The key came from `CHANT_RUNNER_KEY`, not `--key`: one `.chant/trust.json`
   * does not list leaves the run unsigned with a warning, as `chant run` does,
   * where `--key` refuses the run.
   */
  runnerKeyFromEnv?: boolean;
  /** The run id. Default `chant-<epoch ms>`. */
  runId?: string;
  /** Where the run's events go as they happen (`--events-json`). They are kept on this host either way. */
  runEvents?: (line: string) => void;
  /** Where each line a step prints goes. */
  stepOutput?: (line: string) => void;
  /** Push `chant/lifecycle` once the record is written. Default true. */
  push?: boolean;
  /**
   * The apply's resume record on this host (#4095), in place of the forge's
   * CI cache: copied into the checkout at `PR_APPLY_RECORD` before the job,
   * when it exists, and the job's record copied back to it after, passed or
   * failed. `chant ci serve` names one per `prApplyRecordKey`.
   */
  resumeRecord?: string;
  signal?: AbortSignal;
}

export interface CiRunResult {
  op: string;
  /** The executor's outcome: `ok` or `fail` for a job. */
  status: OpRunResult["status"];
  record: OpRunRecord;
  /** The step that failed and why, for a failed run. */
  failure?: { phase: string; error: string };
  /** Where the job's report was copied, or null when it wrote none. */
  report: string | null;
  /** The runner the record was signed as, or null. */
  signer: string | null;
  pushed: boolean;
  pushWarning?: string;
  /** What went wrong beside the job, such as a record the key could not sign. */
  warnings: string[];
  /** The checkout the job ran in, removed by now. */
  checkout: string;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

/** The full commit `rev` names, fetched from `origin` when the repository lacks it. */
function resolveJobCommit(top: string, rev: string): string {
  if (rev.startsWith("-")) throw new CiRunError(`--commit takes a commit, not ${JSON.stringify(rev)}`);
  const local = tryGit(top, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (local) return local;
  if (tryGit(top, ["fetch", "--quiet", "--no-tags", "origin", rev]) !== undefined) {
    const fetched = tryGit(top, ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]);
    if (fetched && (fetched === rev || fetched.startsWith(rev))) return fetched;
  }
  throw new CiRunError(`${rev} names no commit here or on origin`);
}

/** The member a job runs for, and its directory from the repository root, as the generator decides it. */
export function ciJobPlace(cwd: string, top: string): { member?: string; dir: string } {
  const found = findWorkspaceRoot(cwd);
  const member = found ? resolveMemberContext(cwd, found) : undefined;
  const at = member ? member.memberRoot : cwd;
  const dir = relative(top, realpathSync(at)).split(sep).join("/");
  return { ...(member ? { member: member.member.name } : {}), dir: dir === "" ? "." : dir };
}

/** A detached worktree of `commit` in a new temporary directory, and how to remove it. */
function freshCheckout(top: string, commit: string): { dir: string; remove(): void } {
  const holder = mkdtempSync(join(realpathSync(tmpdir()), "chant-ci-run-"));
  const dir = join(holder, "checkout");
  try {
    git(top, ["worktree", "add", "--quiet", "--detach", dir, commit]);
  } catch (err) {
    rmSync(holder, { recursive: true, force: true });
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    throw new CiRunError(`could not check out ${commit.slice(0, 12)} in a fresh worktree: ${String(stderr ?? err).trim()}`);
  }
  return {
    dir,
    remove() {
      tryGit(top, ["worktree", "remove", "--force", dir]);
      rmSync(holder, { recursive: true, force: true });
      tryGit(top, ["worktree", "prune"]);
    },
  };
}

const ACTIVITIES = new Map<string, ActivityFn>([["shellCmd", shellCmd as unknown as ActivityFn]]);

/**
 * Run one pull-request job as a pipeline Op in a fresh checkout of the
 * commit, record it, and copy its report out. Throws {@link CiRunError}
 * before anything runs when the request can't be run.
 */
export async function ciRun(req: CiRunRequest): Promise<CiRunResult> {
  const hostEnv = req.hostEnv ?? process.env;
  const cwd = realpathSync(resolve(req.cwd));
  const top = gitTop(cwd);
  if (!top) throw new CiRunError("a job runs in a fresh checkout of a commit, and this directory is not in a git repository");
  const commit = resolveJobCommit(top, req.commit ?? "HEAD");
  const place = ciJobPlace(cwd, top);
  const jobs = prLoopJobs(req.forge, req.env, req.loop ?? {}, place.member);
  const job = jobs.find((j) => j.jobName === req.job);
  if (!job) throw new CiRunError(`the pull-request pipeline has no ${req.job} job; it has ${jobs.map((j) => j.jobName).join(" and ")}`);
  const jobEnv = ciJobEnv(job, { forge: req.forge, env: req.env, values: { base: req.base, pr: req.pr, commit }, hostEnv, passEnv: req.passEnv });

  // The record is signed against .chant/trust.json at the commit the job runs, so a key that commit does not list is refused before anything runs.
  let signer: ReturnType<typeof ciTagSigner> | undefined;
  const early: string[] = [];
  if (req.runnerKey !== undefined) {
    try {
      signer = ciTagSigner(top, commit, req.runnerKey, "the runs it signed");
    } catch (err) {
      if (!req.runnerKeyFromEnv) throw new CiRunError(`the run would not be signed: ${message(err)}`);
      early.push(`${RUNNER_KEY_ENV} is set, and the run will not be signed: ${message(err)}`);
    }
  }

  const checkout = freshCheckout(top, commit);
  try {
    const jobDir = place.dir === "." ? checkout.dir : join(checkout.dir, place.dir);
    const op = ciJobOp({
      job,
      env: req.env,
      cwd: jobDir,
      jobEnv,
      setup: prLoopSetup(req.image ?? PR_LOOP_IMAGE),
      build: [...(req.beforeScript ?? []), ...(job.build ?? [])],
      ...(req.chant ? { chant: req.chant } : {}),
    });
    const runId = req.runId ?? `chant-${Date.now()}`;
    const warnings: string[] = [...early];
    const resume = req.job === "apply" && req.resumeRecord ? { host: resolve(req.resumeRecord), job: join(jobDir, PR_APPLY_RECORD) } : undefined;
    if (resume && existsSync(resume.host)) {
      mkdirSync(dirname(resume.job), { recursive: true });
      copyFileSync(resume.host, resume.job);
    }
    let ledgerError: string | undefined;
    let result: OpRunResult;
    try {
      result = await runOpLocally(op, ACTIVITIES, ACTIVITY_PROFILES as unknown as Record<string, ActivityProfile>, req.signal, {
        runId,
        env: req.env,
        cwd: jobDir,
        commit,
        ledger: { cwd: jobDir },
        runner: { kind: "pipeline", runtime: "ci", runOrigin: CHANT_RUNNER_ORIGIN },
        describeFailure: (records) => ciJobFailure({ job: req.job, op, records, reportDir: join(jobDir, PR_LOOP_REPORT_DIR) }),
        ...(req.runEvents ? { runEvents: { write: req.runEvents } } : {}),
        ...(req.stepOutput ? { stepOutput: req.stepOutput } : {}),
        ...(signer ? { signRecord: (record: OpRunRecord) => signOpRunRecord(record, signer!) } : {}),
        onSignError: (err) => warnings.push(`the run was not signed: ${message(err)}`),
        onLedgerError: (err) => {
          ledgerError = `the job ran, and its record could not be written to chant/lifecycle: ${message(err)}`;
        },
      });
    } catch (err) {
      if (!(err instanceof OpRunFailure)) throw err;
      result = err.result;
    }

    if (resume && existsSync(resume.job)) {
      try {
        mkdirSync(dirname(resume.host), { recursive: true });
        copyFileSync(resume.job, resume.host);
      } catch (err) {
        warnings.push(`the resume record could not be kept at ${resume.host}: ${message(err)}`);
      }
    }
    const written = join(jobDir, PR_LOOP_REPORT_DIR);
    let report: string | null = null;
    if (existsSync(written)) {
      report = resolve(cwd, req.output ?? PR_LOOP_REPORT_DIR);
      cpSync(written, report, { recursive: true });
    }
    if (ledgerError) throw new CiRunError(ledgerError);
    const pushed: { pushed: boolean; pushWarning?: string } = req.push === false ? { pushed: false, pushWarning: "chant/lifecycle was not pushed" } : await pushLifecycleReport({ cwd: top });
    const failed = result.records.find((r) => r.status === "fail");
    return {
      op: op.name,
      status: result.status,
      record: result.record,
      ...(failed ? { failure: { phase: failed.phase, error: failed.error ?? "the step failed" } } : {}),
      report,
      signer: signer?.principal ?? null,
      pushed: pushed.pushed,
      ...(pushed.pushWarning ? { pushWarning: pushed.pushWarning } : {}),
      warnings,
      checkout: checkout.dir,
    };
  } finally {
    checkout.remove();
  }
}

/** The text `chant ci run` prints when the run settles. */
export function formatCiRun(r: CiRunResult): string {
  const lines = [`${r.op} ${r.status === "ok" ? "passed" : r.status === "fail" ? "failed" : r.status} at ${r.record.gitSha?.slice(0, 12) ?? "an unknown commit"}, run ${r.record.id} in ${r.record.env}`];
  const why = r.record.failure;
  if (why) lines.push(`  failure: ${why.code}${why.phase ? ` in ${why.phase}` : ""}${why.exitCode !== undefined ? `, exit ${why.exitCode}` : ""}: ${why.reason}`);
  else if (r.failure) lines.push(`  ${r.failure.phase}: ${r.failure.error}`);
  lines.push(`  record: ${r.record.env}/runs__${r.op}.jsonl on chant/lifecycle, ${r.signer ? `signed by ${r.signer}` : "unsigned, so ci tick from runs does not count it"}`);
  if (r.report) lines.push(`  report: ${r.report}`);
  if (!r.pushed) lines.push(`  ${r.pushWarning ?? "chant/lifecycle was not pushed"}`);
  return lines.join("\n");
}

// ── The command ──────────────────────────────────────────────────────────────

const USAGE =
  "chant ci run plan|apply --env <env> --base <sha> [--pr <n>] [--commit <sha>] [--forge github|gitlab|forgejo] " +
  "[--gate <name>] [--branch <name>] [--events-json] [--report-url <url>] [--image <image>] [--before-script <line>]... " +
  "[--pr-build] [--pr-build-command <line>] " +
  "[--chant <command>] [--pass-env <NAME>]... [--key <runner key.pem>] [-o <dir>]";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `chant ci run plan|apply` (#4094). */
export async function runCiRun(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  try {
    const job = args.extraPositional;
    if (job !== "plan" && job !== "apply") throw new CiRunError(`ci run takes the job to run, plan or apply${job ? `, not ${JSON.stringify(job)}` : ""}`);
    if (!args.env) throw new CiRunError("--env names the environment the pipeline is for, as chant build --components --generate <lexicon> --pr-loop took it: --env <env>");
    const forge = args.forge ?? detectForge(process.env);
    if (!forge) throw new CiRunError("--forge names the forge the job posts to: --forge github|gitlab|forgejo");
    if (!(FORGE_KINDS as readonly string[]).includes(forge)) throw new CiRunError(`--forge takes github, gitlab or forgejo, not ${JSON.stringify(forge)}`);
    for (const name of args.passEnv ?? []) if (!ENV_NAME.test(name)) throw new CiRunError(`--pass-env takes a variable's name, not ${JSON.stringify(name)}`);
    const fromFlag = args.key !== undefined;
    const runnerKey = fromFlag ? readFileSync(resolve(args.key!), "utf-8") : process.env[RUNNER_KEY_ENV] || undefined;
    const result = await ciRun({
      cwd: process.cwd(),
      job,
      env: args.env,
      forge: forge as ForgeKind,
      ...(args.base ? { base: args.base } : {}),
      ...(args.pr !== undefined ? { pr: args.pr } : {}),
      ...(args.commit ? { commit: args.commit } : {}),
      loop: {
        ...(args.gate ? { gate: args.gate } : {}),
        ...(args.branch ? { branch: args.branch } : {}),
        ...(args.eventsJson ? { events: true } : {}),
        ...(args.reportUrl ? { reportUrl: args.reportUrl } : {}),
        ...(args.prBuild ? { build: true } : {}),
        ...(args.prBuildCommand ? { buildCommand: args.prBuildCommand } : {}),
      },
      ...(args.image ? { image: args.image } : {}),
      ...(args.beforeScript?.length ? { beforeScript: args.beforeScript } : {}),
      ...(args.ciChant ? { chant: args.ciChant } : {}),
      ...(args.passEnv?.length ? { passEnv: args.passEnv } : {}),
      ...(args.output ? { output: args.output } : {}),
      ...(runnerKey !== undefined ? { runnerKey, runnerKeyFromEnv: !fromFlag } : {}),
      ...(args.eventsJson ? { runEvents: (line: string) => void process.stdout.write(line) } : {}),
      stepOutput: (line) => void process.stderr.write(`${line}\n`),
    });
    for (const w of result.warnings) console.error(formatWarning({ message: w }));
    console.error(formatCiRun(result));
    return result.status === "ok" ? 0 : 1;
  } catch (err) {
    console.error(formatError({ message: `chant ci run: ${message(err)}`, hint: USAGE }));
    return 1;
  }
}
