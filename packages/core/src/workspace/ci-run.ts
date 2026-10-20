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
 * `--commit`. The values a forge job gets from repository secrets come from
 * the host's secrets file (`--secrets`, ./ci-secrets.ts, #4096), and every
 * secret value is redacted from the run's events, record, copied report and
 * output by the executor's `redact` option.
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
 *
 * With a forge client (#4097) the job also sets a commit status at its
 * commit: `pending` when it starts, `success` or `failure` when it settles.
 * A status the forge refuses is a warning and never fails the job.
 *
 * Signing is opt-in (#4156). With no runner key the record is unsigned, and
 * a reader counts it with no signer. A key `.chant/trust.json` does not list
 * leaves it unsigned with a note `--verbose` prints, unless the declaration
 * sets `ci.green.signedSince`; then a run left unsigned is a warning.
 *
 * In place (`--in-place`, #4156) the job runs in the checkout it is started
 * in, as a generated forge job does: no worktree, no setup phase and no
 * commit status of its own (the forge shows the job). The steps get the
 * job's whole environment less `CHANT_RUNNER_KEY`, since the forge job is
 * already the boundary, and the record's `runOrigin` names the forge's run,
 * job and attempt (`resolveCiJob`).
 *
 * Local (`--local`, #4161) runs the job the same way on this machine and
 * leaves nothing outside it. It implies `--no-push` and `--no-status`, and
 * writes nothing under a report URL, given or declared: the command gets no
 * `--report-url`, and gets `--no-status`, so pr-plan and pr-apply post no
 * status or note either. The record is still written to the local
 * `chant/lifecycle`, where a reader on this machine finds it beside CI's for
 * the same commit. It says `runOrigin: { forge: "local" }` and its events say
 * `runtime: "local"`. `ci tick --source runs` and `ci list` never count it.
 * A pr-apply still pushes its own release records and gate facts, as the
 * command always does, since a local apply changes the same infrastructure
 * a CI one does.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { PR_APPLY_RECORD, PR_LOOP_REPORT_DIR, prLoopJobs, prLoopSetup, PR_LOOP_IMAGE, type PrLoopJob, type PrLoopPipelineOptions } from "../components/pr-pipeline";
import { detectForge, ForgeEnvironmentError, forgeFromEnv, FORGE_KINDS, type CommitStatus, type ForgeKind } from "../pr-forge";
import { PR_APPLY_GATE } from "../pr-loop";
import type { CommandContext } from "../cli/registry";
import { formatError, formatWarning } from "../cli/format";
import { resolveCiJob, type RunOrigin } from "../lifecycle/release-ledger";
import { fetchLifecycleStatus, pushLifecycleReport } from "../lifecycle/git";
import { ACTIVITY_PROFILES } from "../op/activity-profiles";
import type { ActivityFn, ActivityProfile } from "../op/activity-registry";
import { shellCmd } from "../op/activities/shell";
import { OpRunFailure, runOpLocally, type OpRunResult, type StepRecord } from "../op/local-executor";
import type { OpRunFailureReason, OpRunRecord } from "../op/runtime";
import type { ActivityStep, OpConfig, PhaseDefinition } from "../op/types";
import { redactText, type Redact } from "../op/redact";
import { findWorkspaceRoot } from "../project-root";
import { parseReportUrl, reportKey } from "../pr-report-url";
import { ciTagSigner, RUNNER_KEY_ENV, signedRunsRequired } from "./ci-green";
import { loadRunnerKey } from "./trust/dsse";
import { ciRedactor, ciSecretsFor, CI_SECRETS_ENV, readCiSecrets, type CiSecrets } from "./ci-secrets";
import { updateCiRunIndex, type CiRunIndexEntry } from "./ci-run-index";
import { resolveMemberContext } from "./member-pipeline";
import { signOpRunRecord } from "./trust/op-run-statement";
import { gitTop } from "./tree";
import { hostRunnerKey } from "./ci-runner-key";

/** The two jobs a pull-request pipeline has. */
export type CiJobName = PrLoopJob["jobName"];
export const CI_JOB_NAMES: readonly CiJobName[] = ["plan", "apply"];

/** The Op each job is recorded as, which `ci.green` phases match. */
export const CI_JOB_OPS: Record<CiJobName, string> = { plan: "pr-plan", apply: "pr-apply" };

/** Where a job the chant runner ran says it ran (#4094). */
export const CHANT_RUNNER_ORIGIN: RunOrigin = { forge: "chant" };

/** Where a job `chant ci run --local` ran says it ran (#4161): this machine, outside CI. */
export const CHANT_LOCAL_ORIGIN: RunOrigin = { forge: "local" };

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
 * and `passEnv` names it has, the job's secrets from the host's secrets file
 * (#4096), `CHANT_ENV` as a generated workflow sets it, the commit as the
 * forge spells it, and the job's own variables. A job variable the forge
 * fills from an expression comes from a flag, or from a secret or the
 * runner's environment for a token such as `GITHUB_TOKEN`; a literal one,
 * such as `CHANT_RUN_EVENTS_DIR`, is kept as it is. A secret replaces the
 * runner's variable of the same name, and none replaces a variable the
 * runner sets for the job. `CHANT_RUNNER_KEY` is never in it.
 */
export function ciJobEnv(
  job: PrLoopJob,
  input: {
    forge: ForgeKind;
    env: string;
    values: CiRunValues;
    hostEnv: Record<string, string | undefined>;
    passEnv?: readonly string[];
    /** The secrets this job gets, from {@link ciSecretsFor}. */
    secrets?: Record<string, string>;
  },
): Record<string, string> {
  if (input.passEnv?.includes(RUNNER_KEY_ENV)) throw new CiRunError(`--pass-env names ${RUNNER_KEY_ENV}, and the runner key is never passed to a job`);
  const out: Record<string, string> = {};
  for (const name of [...CI_RUN_BASE_ENV, ...CI_RUN_FORGE_ENV, ...(input.passEnv ?? [])]) {
    const value = input.hostEnv[name];
    if (value !== undefined) out[name] = value;
  }
  for (const [name, value] of Object.entries(input.secrets ?? {})) if (name !== RUNNER_KEY_ENV) out[name] = value;
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
    } else if (input.secrets?.[name] !== undefined) {
      out[name] = input.secrets[name]!;
    } else if (input.hostEnv[name] !== undefined) {
      out[name] = input.hostEnv[name]!;
    }
  }
  delete out[RUNNER_KEY_ENV];
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

/** What posts a job's commit status (#4097): the `setCommitStatus` of a GitHub or Forgejo client. */
export interface CiStatusClient {
  setCommitStatus(sha: string, status: CommitStatus): Promise<void>;
}

/** Where a job's status goes (#4097). */
export interface CiStatusConfig {
  client: CiStatusClient;
  /** `--status-url`: the link the status carries, `{key}` standing for `<pr>/<commit>[/<member>]`. Otherwise an https `--report-url` is used. */
  urlTemplate?: string;
}

/** A status description is cut to what GitHub and Forgejo keep. */
const STATUS_DESCRIPTION = 140;

const cut = (text: string, max = STATUS_DESCRIPTION): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/**
 * A job's status context: `chant/pr-plan` for the plan, and for the apply
 * `chant/<gate>`, which is `chant/pr-apply` unless `--gate` renamed the gate.
 * pr-plan's own status is `chant/plan` (../pr-loop.ts), a different context.
 */
export function ciStatusContext(job: CiJobName, gate?: string): string {
  return job === "apply" ? `chant/${gate ?? PR_APPLY_GATE}` : `chant/${CI_JOB_OPS.plan}`;
}

/**
 * The link a job's status carries: the `--status-url` template with `{key}`
 * filled, else the https `--report-url` followed by the key and a slash, else
 * none (an `s3://` or `file://` URL is not one a browser opens).
 */
export function ciStatusUrl(input: { urlTemplate?: string; reportUrl?: string; pr?: number; commit: string; member?: string }): string | undefined {
  const key = reportKey(input.pr ?? null, input.commit, input.member);
  if (input.urlTemplate) return input.urlTemplate.split("{key}").join(key);
  const url = input.reportUrl?.trim();
  if (url && /^https:\/\//.test(url)) return `${url.replace(/\/+$/, "")}/${key}/`;
  return undefined;
}

/** What the settled status says: a short summary, or on failure the record's code and reason. */
export function ciStatusSettled(op: string, result: Pick<CiRunResult, "status" | "record" | "failure">, seconds: number): Pick<CommitStatus, "state" | "description"> {
  if (result.status === "ok") return { state: "success", description: cut(`${op} passed in ${seconds}s`) };
  const why = result.record.failure;
  const text = why ? `${why.code}: ${why.reason}` : result.failure ? `${result.failure.phase}: ${firstLine(result.failure.error)}` : `${op} failed`;
  return { state: "failure", description: cut(text) };
}

/**
 * The status client for `chant ci run` and `chant ci serve` (#4097), or none:
 * off with `--no-status`, on GitLab (its client has no commit status call
 * here), and without a forge token. A token with the rest of the forge's
 * variables missing gives a warning instead.
 */
export function ciStatusFromEnv(input: { forge: ForgeKind; hostEnv: Record<string, string | undefined>; noStatus?: boolean; statusUrl?: string }): { status?: CiStatusConfig; warning?: string } {
  if (input.noStatus || input.forge === "gitlab") return {};
  if (input.statusUrl !== undefined && !/^https?:\/\/\S+$/.test(input.statusUrl)) {
    throw new CiRunError(`--status-url takes an http or https URL template such as https://host/reports/{key}, not ${JSON.stringify(input.statusUrl)}`);
  }
  const env = input.hostEnv;
  const hasToken = Boolean(env.CHANT_FORGE_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN);
  if (!hasToken) return {};
  try {
    const client = forgeFromEnv(input.forge, env);
    if (!client.setCommitStatus) return {};
    return { status: { client: { setCommitStatus: client.setCommitStatus.bind(client) }, ...(input.statusUrl ? { urlTemplate: input.statusUrl } : {}) } };
  } catch (err) {
    if (err instanceof ForgeEnvironmentError) return { warning: `no commit status will be set: ${err.message}` };
    throw err;
  }
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
  /**
   * The generator's options: `--gate`, `--branch`, `--events-json`,
   * `--report-url`, `--pr-build` and `--pr-build-command`, and `--wave-gate`
   * (#4003), with which the apply job runs the waves in order and stops at
   * the first whose moved plan waits on its own gate.
   */
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
  /**
   * The host's secrets file, read (#4096, `--secrets`): the job gets the
   * secrets its allowlist names, and every value in it is redacted from the
   * run's events, record, copied report and output.
   */
  secrets?: CiSecrets;
  /** `--output`: where the job's report is copied, from `cwd`. Default `.chant/pr`. */
  output?: string;
  /** `--run-index-limit`: how many runs the index at `loop.reportUrl` keeps (#4098). Default 200. */
  runIndexLimit?: number;
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
  /** Set a commit status at the job's commit (#4097). Absent: none is set. `chant ci run` builds it from the environment. */
  status?: CiStatusConfig;
  /**
   * `--in-place` (#4156): run in the checkout `cwd` is in, at its `HEAD`, as
   * a generated forge job does, with the runner's whole environment less
   * `CHANT_RUNNER_KEY`, no setup phase, and the forge's run as `runOrigin`.
   */
  inPlace?: boolean;
  /**
   * `--local` (#4161): run on this machine and write nothing beyond it. It
   * implies `push: false` and no status (`status` is ignored), writes
   * nothing under `loop.reportUrl`, and the record and events say
   * `runOrigin: { forge: "local" }` and `runtime: "local"`.
   */
  local?: boolean;
  /**
   * `--wave <k>` (#4003, #4156): the one wave a generated apply job runs, as
   * `pr-apply --wave <k>`. Needs `--wave-gate`.
   */
  wave?: number;
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
  /** What `--verbose` prints: such as a run left unsigned when nothing asks for a signature (#4156). */
  notes: string[];
  /** The exit code of the job's command when it failed with one, such as pr-apply's 3 for a moved plan. */
  exitCode?: number;
  /** The checkout the job ran in, removed by now. */
  checkout: string;
  /** The job ran with `local` (#4161): its record stays on this machine. */
  local?: true;
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

/**
 * Add the settled job to the run index at its report URL (#4098). The pull
 * request is the one the job's own report names, since a pr-apply finds it
 * itself, else `--pr`. A warning, never a failure, when the index can't be
 * updated.
 */
async function recordInIndex(input: {
  url: string;
  job: CiJobName;
  commit: string;
  member?: string;
  pr?: number;
  record: OpRunRecord;
  runOrigin: RunOrigin;
  /** The runner that signed the record, or null (#4156). */
  signer: string | null;
  reportDir: string;
  limit?: number;
  /** The run's redactor (#4096): every string written to the index goes through it, as the copied report does. */
  redact?: Redact;
  warn: (message: string) => void;
}): Promise<void> {
  const target = parseReportUrl(input.url);
  if ("error" in target) return input.warn(`the run index is not updated: ${target.error}`);
  let pr: number | null = input.pr ?? null;
  try {
    const file = join(input.reportDir, `${CI_JOB_OPS[input.job]}.json`);
    if (existsSync(file)) {
      const said = (JSON.parse(readFileSync(file, "utf-8")) as { pr?: unknown }).pr;
      if (Number.isInteger(said) && (said as number) > 0) pr = said as number;
    }
  } catch {
    // The report is not readable; the flag stands.
  }
  const failure = input.record.failure;
  const clean = (text: string): string => (input.redact ? input.redact(text) : text);
  const entry: CiRunIndexEntry = {
    job: input.job,
    pr,
    commit: input.commit,
    status: input.record.status === "ok" ? "ok" : "fail",
    ...(input.record.status !== "ok" ? { failure: { code: clean(failure?.code ?? "command-failed") } } : {}),
    ...(input.member ? { member: clean(input.member) } : {}),
    started: input.record.started,
    ended: input.record.ended,
    runId: clean(input.record.id),
    key: clean(reportKey(pr, input.commit, input.member)),
    runOrigin: input.runOrigin,
    signer: input.signer,
  };
  await updateCiRunIndex({ target, entry, ...(input.limit ? { limit: input.limit } : {}), warn: input.warn });
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
  if (req.inPlace && commit !== resolveJobCommit(top, "HEAD")) throw new CiRunError(`--in-place runs the checkout's HEAD, and --commit names ${commit.slice(0, 12)}`);
  if (req.local && req.inPlace) throw new CiRunError("--in-place runs a forge job in the forge's checkout, and --local runs one on this machine; pass one of them");
  const place = ciJobPlace(cwd, top);
  const jobs = prLoopJobs(req.forge, req.env, req.local ? localLoop(req.loop) : (req.loop ?? {}), place.member);
  const found = jobs.find((j) => j.jobName === req.job);
  if (!found) throw new CiRunError(`the pull-request pipeline has no ${req.job} job; it has ${jobs.map((j) => j.jobName).join(" and ")}`);
  if (req.wave !== undefined && (req.job !== "apply" || !req.loop?.waveGate)) throw new CiRunError("--wave names the one wave an apply runs, and takes --wave-gate: ci run apply --wave-gate <gate> --wave <k>");
  // A generated wave job's command, as prLoopWaveJobs writes it. #4161: a local job's command posts no status or note.
  const command = `${found.command}${req.wave !== undefined ? ` --wave ${req.wave}` : ""}${req.local ? " --no-status" : ""}`;
  const job = { ...found, command, ...(req.wave !== undefined ? { wave: req.wave } : {}) };
  const own = ciJobEnv(job, {
    forge: req.forge,
    env: req.env,
    values: { base: req.base, pr: req.pr, commit },
    hostEnv,
    passEnv: req.passEnv,
    secrets: ciSecretsFor(req.secrets, req.job),
  });
  // #4156: in place, the forge job's environment is the job's, less the runner key.
  const jobEnv = req.inPlace ? { ...definedEnv(hostEnv), ...own } : own;
  delete jobEnv[RUNNER_KEY_ENV];
  // #4096: the secrets and the job's secret-looking variables, redacted from everything the run writes and returns.
  // In place the forge's own variables come too; one whose value is short, such as a flag, is left out, so it can't blank common words.
  const redact = ciRedactor(req.inPlace ? { ...longValues(jobEnv), ...own } : jobEnv, req.secrets);
  try {
    const result = await runCiJob(req, { cwd, top, commit, place, job, jobEnv, ...(redact ? { redact } : {}) });
    return redact ? { ...result, warnings: result.warnings.map(redact), notes: result.notes.map(redact), ...(result.pushWarning ? { pushWarning: redact(result.pushWarning) } : {}) } : result;
  } catch (err) {
    if (redact && err instanceof Error) err.message = redact(err.message);
    throw err;
  }
}

/** The generator's options for a `--local` job (#4161): the same, with no report URL. */
function localLoop(loop: PrLoopPipelineOptions | undefined): PrLoopPipelineOptions {
  const { reportUrl: _dropped, ...rest } = loop ?? {};
  return rest;
}

/** The variables of `env` whose value is long enough to be a credential, 8 characters or more. */
function longValues(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value.length >= 8));
}

/** The variables of `env` that have a value. */
function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) out[name] = value;
  return out;
}

/**
 * Who signs the run (#4156): the runner key, checked against
 * `.chant/trust.json` at the commit. A key that isn't an Ed25519 PEM is an
 * error, and so is a `--key` the file does not list. A key from the
 * environment that it does not list, and no key at all, leave the run
 * unsigned: a warning when the declaration's `ci.green.signedSince` asks
 * for signed runs, a note for `--verbose` otherwise.
 */
function ciRunSigner(req: CiRunRequest, at: { cwd: string; top: string; commit: string }): { signer?: ReturnType<typeof ciTagSigner>; warnings: string[]; notes: string[] } {
  // #4161: a local run never counts, signed or not, so nothing about its signature warns.
  const required = req.local ? null : signedRunsRequired(at.cwd);
  const say = (text: string) => (required ? { warnings: [`${text}, and ci.green.signedSince is ${required}, so it will not count`], notes: [] } : { warnings: [], notes: [text] });
  if (req.runnerKey === undefined) return say("there is no runner key, so the run's record is unsigned");
  try {
    loadRunnerKey(req.runnerKey);
  } catch (err) {
    throw new CiRunError(`the runner key${req.runnerKeyFromEnv ? ` in ${RUNNER_KEY_ENV}` : ""} is not an Ed25519 private key in PEM: ${message(err)}`);
  }
  try {
    return { signer: ciTagSigner(at.top, at.commit, req.runnerKey, "the runs it signed"), warnings: [], notes: [] };
  } catch (err) {
    if (!req.runnerKeyFromEnv) throw new CiRunError(`the run would not be signed: ${message(err)}`);
    return say(`${RUNNER_KEY_ENV} is set, and the run will not be signed: ${message(err)}`);
  }
}

/** Where the job runs: a fresh worktree of the commit, or with `inPlace` the checkout itself, which is left as it is. */
function jobCheckout(top: string, commit: string, inPlace?: boolean): { dir: string; remove(): void } {
  return inPlace ? { dir: top, remove() {} } : freshCheckout(top, commit);
}

/** {@link ciRun} once the job and its environment are known. */
async function runCiJob(
  req: CiRunRequest,
  at: { cwd: string; top: string; commit: string; place: { member?: string; dir: string }; job: PrLoopJob; jobEnv: Record<string, string>; redact?: Redact },
): Promise<CiRunResult> {
  const { cwd, top, commit, place, job, jobEnv, redact } = at;
  const local = req.local === true;
  const status = local ? undefined : req.status;
  const reportUrl = local ? undefined : req.loop?.reportUrl;

  // The record is signed against .chant/trust.json at the commit the job runs, so a --key that commit does not list is refused before anything runs.
  const signing = ciRunSigner(req, { cwd, top, commit });
  const signer = signing.signer;
  const early = signing.warnings;
  const notes = signing.notes;
  const origin: RunOrigin = local ? CHANT_LOCAL_ORIGIN : req.inPlace ? (resolveCiJob(req.hostEnv ?? process.env)?.runOrigin ?? CHANT_RUNNER_ORIGIN) : CHANT_RUNNER_ORIGIN;
  // In place, the job writes its record on the checkout's chant/lifecycle, which a forge checkout may not have fetched.
  if (req.inPlace && req.push !== false) await fetchLifecycleStatus({ cwd: top }).catch(() => undefined);

  const checkout = jobCheckout(top, commit, req.inPlace);
  try {
    const jobDir = place.dir === "." ? checkout.dir : join(checkout.dir, place.dir);
    const op = ciJobOp({
      job,
      env: req.env,
      cwd: jobDir,
      jobEnv,
      setup: req.inPlace ? [] : prLoopSetup(req.image ?? PR_LOOP_IMAGE),
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
    const statusContext = ciStatusContext(req.job, req.loop?.gate);
    const statusUrl = status
      ? ciStatusUrl({ ...(status.urlTemplate ? { urlTemplate: status.urlTemplate } : {}), ...(reportUrl ? { reportUrl } : {}), ...(req.pr !== undefined ? { pr: req.pr } : {}), commit, ...(place.member ? { member: place.member } : {}) })
      : undefined;
    const postStatus = async (state: CommitStatus["state"], description: string): Promise<void> => {
      if (!status) return;
      try {
        await status.client.setCommitStatus(commit, { context: statusContext, state, description: cut(redact ? redact(description) : description), ...(statusUrl ? { targetUrl: statusUrl } : {}) });
      } catch (err) {
        warnings.push(`could not set the ${statusContext} status: ${message(err)}`);
      }
    };
    const startedAt = Date.now();
    await postStatus("pending", `${op.name} running`);
    let ledgerError: string | undefined;
    let result: OpRunResult;
    try {
      result = await runOpLocally(op, ACTIVITIES, ACTIVITY_PROFILES as unknown as Record<string, ActivityProfile>, req.signal, {
        runId,
        env: req.env,
        cwd: jobDir,
        commit,
        ledger: { cwd: jobDir },
        runner: { kind: "pipeline", runtime: local ? "local" : "ci", runOrigin: origin },
        describeFailure: (records) => ciJobFailure({ job: req.job, op, records, reportDir: join(jobDir, PR_LOOP_REPORT_DIR) }),
        ...(req.runEvents ? { runEvents: { write: req.runEvents } } : {}),
        ...(req.stepOutput ? { stepOutput: req.stepOutput } : {}),
        ...(signer ? { signRecord: (record: OpRunRecord) => signOpRunRecord(record, signer!) } : {}),
        onSignError: (err) => warnings.push(`the run was not signed: ${message(err)}`),
        ...(redact ? { redact } : {}),
        onLedgerError: (err) => {
          ledgerError = `the job ran, and its record could not be written to chant/lifecycle: ${message(err)}`;
        },
      });
    } catch (err) {
      if (!(err instanceof OpRunFailure)) {
        await postStatus("error", `${op.name} stopped: ${firstLine(message(err))}`);
        throw err;
      }
      result = err.result;
    }
    const failedStep = result.records.find((r) => r.status === "fail");
    const settled = ciStatusSettled(
      op.name,
      { status: result.status, record: result.record, ...(failedStep ? { failure: { phase: failedStep.phase, error: failedStep.error ?? "the step failed" } } : {}) },
      Math.round((Date.now() - startedAt) / 1000),
    );
    await postStatus(settled.state, settled.description);

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
      // In place the report is already where the forge keeps it, and stays as the command wrote it.
      if (!(existsSync(report) && realpathSync(report) === realpathSync(written))) {
        cpSync(written, report, { recursive: true });
        if (redact) redactTree(report, redact);
      }
    }
    if (reportUrl) {
      await recordInIndex({ url: reportUrl, job: req.job, commit, member: place.member, pr: req.pr, record: result.record, runOrigin: origin, signer: result.record.statement && signer ? signer.principal : null, reportDir: written, limit: req.runIndexLimit, ...(redact ? { redact } : {}), warn: (w) => warnings.push(w) });
    }
    // In place the forge job's outcome is the command's, so a record that could not be written is a warning there.
    if (ledgerError && req.inPlace) warnings.push(ledgerError);
    else if (ledgerError) throw new CiRunError(ledgerError);
    const pushed: { pushed: boolean; pushWarning?: string } = local
      ? { pushed: false }
      : req.push === false ? { pushed: false, pushWarning: "chant/lifecycle was not pushed" } : await pushLifecycleReport({ cwd: top });
    const failed = result.records.find((r) => r.status === "fail");
    const exitCode = failed?.phase === req.job ? exitCodeOf(failed.error) : undefined;
    return {
      op: op.name,
      status: result.status,
      record: result.record,
      ...(failed ? { failure: { phase: failed.phase, error: failed.error ?? "the step failed" } } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      report,
      signer: result.record.statement && signer ? signer.principal : null,
      pushed: pushed.pushed,
      ...(pushed.pushWarning ? { pushWarning: pushed.pushWarning } : {}),
      warnings,
      notes,
      checkout: checkout.dir,
      ...(local ? { local: true as const } : {}),
    };
  } finally {
    checkout.remove();
  }
}

/**
 * Redact every text file under `dir` in place (#4096): the job's report, its
 * change set and its component events, as `ci run` copied them out. A
 * JSON file stays JSON. A file with a NUL byte is taken as binary and left.
 */
export function redactTree(dir: string, redact: Redact): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      redactTree(path, redact);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf-8");
    const clean = redactText(text, redact);
    if (clean !== text) writeFileSync(path, clean);
  }
}

/** The text `chant ci run` prints when the run settles. */
export function formatCiRun(r: CiRunResult): string {
  const lines = [`${r.op} ${r.status === "ok" ? "passed" : r.status === "fail" ? "failed" : r.status} at ${r.record.gitSha?.slice(0, 12) ?? "an unknown commit"}, run ${r.record.id} in ${r.record.env}`];
  const why = r.record.failure;
  if (why) lines.push(`  failure: ${why.code}${why.phase ? ` in ${why.phase}` : ""}${why.exitCode !== undefined ? `, exit ${why.exitCode}` : ""}: ${why.reason}`);
  else if (r.failure) lines.push(`  ${r.failure.phase}: ${r.failure.error}`);
  lines.push(`  record: ${r.record.env}/runs__${r.op}.jsonl on chant/lifecycle, ${r.signer ? `signed by ${r.signer}` : "unsigned"}`);
  if (r.report) lines.push(`  report: ${r.report}`);
  if (r.local) lines.push("  local run: the record stays on this machine, with no push, commit status or report upload");
  else if (!r.pushed) lines.push(`  ${r.pushWarning ?? "chant/lifecycle was not pushed"}`);
  return lines.join("\n");
}

// ── The command ──────────────────────────────────────────────────────────────

/**
 * The generator's options from `ci run`'s and `ci serve`'s flags, as `chant
 * build --components --generate <lexicon> --pr-loop` takes them: `--gate`,
 * `--branch`, `--events-json`, `--report-url`, `--pr-build`,
 * `--pr-build-command`, `--wave-gate` (#4003) and `--no-require-review`
 * (#4156).
 */
export function ciLoopOptions(args: CommandContext["args"]): PrLoopPipelineOptions {
  return {
    ...(args.gate ? { gate: args.gate } : {}),
    ...(args.branch ? { branch: args.branch } : {}),
    ...(args.eventsJson ? { events: true } : {}),
    ...(args.reportUrl ? { reportUrl: args.reportUrl } : {}),
    ...(args.prBuild ? { build: true } : {}),
    ...(args.prBuildCommand ? { buildCommand: args.prBuildCommand } : {}),
    ...(args.waveGate ? { waveGate: args.waveGate } : {}),
    ...(args.requireReview === false ? { requireReview: false } : {}),
  };
}

const USAGE =
  "chant ci run plan|apply --env <env> --base <sha> [--pr <n>] [--commit <sha>] [--forge github|gitlab|forgejo] " +
  "[--gate <name>] [--wave-gate <name>] [--wave <k>] [--branch <name>] [--events-json] [--report-url <url>] [--run-index-limit <n>] [--image <image>] [--before-script <line>]... " +
  "[--pr-build] [--pr-build-command <line>] [--no-require-review] [--no-status] [--status-url <url template>] " +
  "[--chant <command>] [--pass-env <NAME>]... [--secrets <file>] [--key <runner key.pem>] [-o <dir>] [--in-place | --local] [--no-push] [--verbose] | chant ci run --setup-key [--trust [--principal <name>]] [--state <dir>] [--branch <name>]";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The host's runner key in `--state`, or in ci serve's default state directory, when `--setup-key` made one there (#4099). */
function hostRunnerKeyAt(cwd: string, statePath: string | undefined): { pem: string } | undefined {
  const common = statePath ? null : (() => {
    try {
      return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      return null;
    }
  })();
  const dir = statePath ? resolve(statePath) : common ? join(common, "chant", "ci-serve") : null;
  return dir ? hostRunnerKey(dir) : undefined;
}

/** The secrets file `--secrets` names, else the one `CHANT_CI_SECRETS` names, read; undefined when neither names one (#4096). */
export function ciSecretsOf(flag: string | undefined, env: Record<string, string | undefined> = process.env): CiSecrets | undefined {
  const file = flag ?? (env[CI_SECRETS_ENV] || undefined);
  return file === undefined ? undefined : readCiSecrets(resolve(file));
}

/** `chant ci run plan|apply` (#4094). */
export async function runCiRun(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  try {
    if (args.setupKey) return (await import("./ci-serve")).runnerKeySetupCommand(ctx);
    const job = args.extraPositional;
    if (job !== "plan" && job !== "apply") throw new CiRunError(`ci run takes the job to run, plan or apply${job ? `, not ${JSON.stringify(job)}` : ""}`);
    if (!args.env) throw new CiRunError("--env names the environment the pipeline is for, as chant build --components --generate <lexicon> --pr-loop took it: --env <env>");
    const forge = args.forge ?? detectForge(process.env);
    if (!forge) throw new CiRunError("--forge names the forge the job posts to: --forge github|gitlab|forgejo");
    if (!(FORGE_KINDS as readonly string[]).includes(forge)) throw new CiRunError(`--forge takes github, gitlab or forgejo, not ${JSON.stringify(forge)}`);
    for (const name of args.passEnv ?? []) if (!ENV_NAME.test(name)) throw new CiRunError(`--pass-env takes a variable's name, not ${JSON.stringify(name)}`);
    const fromFlag = args.key !== undefined;
    // #4099: without --key or CHANT_RUNNER_KEY, the host's key that --setup-key made, if there is one. Like the variable, an unlisted one only warns.
    const hostKey = fromFlag || process.env[RUNNER_KEY_ENV] ? undefined : hostRunnerKeyAt(process.cwd(), args.statePath);
    const runnerKey = fromFlag ? readFileSync(resolve(args.key!), "utf-8") : process.env[RUNNER_KEY_ENV] || hostKey?.pem;
    const hostEnv = process.env;
    // #4156: in place the forge shows the job, so ci run sets no status of its own.
    // #4161: a local run sets no status, so it builds no client and warns about none.
    const { status, warning } = ciStatusFromEnv({ forge: forge as ForgeKind, hostEnv, noStatus: args.noStatus || args.ciInPlace || args.local, statusUrl: args.statusUrl });
    if (warning) console.error(formatWarning({ message: warning }));
    const secrets = ciSecretsOf(args.ciSecrets);
    const result = await ciRun({
      cwd: process.cwd(),
      ...(status ? { status } : {}),
      job,
      env: args.env,
      forge: forge as ForgeKind,
      ...(args.base ? { base: args.base } : {}),
      ...(args.pr !== undefined ? { pr: args.pr } : {}),
      ...(args.commit ? { commit: args.commit } : {}),
      loop: ciLoopOptions(args),
      ...(args.ciInPlace ? { inPlace: true } : {}),
      ...(args.local ? { local: true } : {}),
      ...(args.noPush ? { push: false } : {}),
      ...(args.wave !== undefined ? { wave: args.wave } : {}),
      ...(args.runIndexLimit ? { runIndexLimit: args.runIndexLimit } : {}),
      ...(args.image ? { image: args.image } : {}),
      ...(args.beforeScript?.length ? { beforeScript: args.beforeScript } : {}),
      ...(args.ciChant ? { chant: args.ciChant } : {}),
      ...(args.passEnv?.length ? { passEnv: args.passEnv } : {}),
      ...(secrets ? { secrets } : {}),
      ...(args.output ? { output: args.output } : {}),
      ...(runnerKey !== undefined ? { runnerKey, runnerKeyFromEnv: !fromFlag } : {}),
      ...(args.eventsJson ? { runEvents: (line: string) => void process.stdout.write(line) } : {}),
      stepOutput: (line) => void process.stderr.write(`${line}\n`),
    });
    for (const w of result.warnings) console.error(formatWarning({ message: w }));
    if (args.verbose) for (const n of result.notes) console.error(`ci run: ${n}`);
    console.error(formatCiRun(result));
    // #4156: a failed command's own exit code, such as 3 for a moved plan, is the job's, as it was before the job ran through ci run.
    return result.status === "ok" ? 0 : result.exitCode && result.exitCode > 0 && result.exitCode < 256 ? result.exitCode : 1;
  } catch (err) {
    console.error(formatError({ message: `chant ci run: ${message(err)}`, hint: USAGE }));
    return 1;
  }
}
