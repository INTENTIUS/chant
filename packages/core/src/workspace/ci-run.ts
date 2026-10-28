/**
 * `chant ci run plan|record|apply` (#4094, epic #4101, record #4168): run one pull-request job as
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
 * The plan runs the pull request's code, so no step of the plan job gets a
 * forge token (#4295, ../ci-handover.ts): every name in `FORGE_TOKEN_VARS`
 * is left out of its steps' environment, from the runner, a secret or the
 * forge job alike, and `pr-plan` runs with `--no-status`. Once the steps
 * settle, the runner posts the note and the `chant/plan` status from the
 * report with its own token (`postPlanReport`, ../pr-post.ts). In place, a
 * generated job holds no token and its `plan-note` job posts; a job that
 * still holds one was generated before #4295, and the runner posts for it
 * with a warning to regenerate. Either way the note's overdue check (#4289)
 * reads the scheduled Ops from a fresh checkout of `--base`, as the
 * plan-note job reads them at the target branch's commit (#4328).
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
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PR_APPLY_RECORD, PR_ENV_POST_JOB, PR_ENV_REPORT_DIR, PR_LOOP_REPORT_DIR, prEnvJobs, prLoopJobs, prLoopSetup, PR_LOOP_IMAGE, type PrEnvJob, type PrLoopJob, type PrLoopPipelineOptions } from "../components/pr-pipeline";
import { detectForge, ForgeEnvironmentError, forgeFromEnv, FORGE_KINDS, type CommitStatus, type ForgeKind, type PrForge } from "../pr-forge";
import { holdsForgeToken, withoutForgeTokens } from "../ci-handover";
import { postPlanReport } from "../pr-post";
import { overdueOpsAt } from "../op/schedule-overdue";
import { PR_APPLY_GATE, type PrOverdue } from "../pr-loop";
import { activeProductWords, productContext, type CiProductWords } from "../ci-product-words";
import type { CommandContext } from "../cli/registry";
import { formatError, formatWarning } from "../cli/format";
import { CHANT_CI_RUN_FORGE_ENV, CHANT_CI_RUN_ID_ENV, FORGE_RUN_ENV, resolveCiJob, type RunOrigin } from "../lifecycle/release-ledger";
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
import { reportUrlOf } from "./ci-report-url";
import { ciTagSigner, RUNNER_KEY_ENV, signedRunsRequired } from "./ci-green";
import { loadRunnerKey } from "./trust/dsse";
import { ciRedactor, ciSecretsFor, CI_SECRETS_ENV, readCiSecrets, type CiSecrets } from "./ci-secrets";
import { updateCiRunIndex, type CiRunIndexEntry } from "./ci-run-index";
import { resolveMemberContext } from "./member-pipeline";
import { signOpRunRecord } from "./trust/op-run-statement";
import { gitTop } from "./tree";
import { hostRunnerKey } from "./ci-runner-key";
import { requireRunnerStart } from "./ci-runner-start";
import { securityGroupsAt } from "./security";

/**
 * The jobs a pull-request pipeline has: plan, and on merge record (#4168) or,
 * opted in, apply; and with `--pr-env` (#4298, #4330) the jobs of a pull
 * request's environment.
 */
export type CiJobName = PrLoopJob["jobName"] | PrEnvJob["jobName"];
export const CI_JOB_NAMES: readonly CiJobName[] = ["plan", "apply", "record", "env-up", "env-post", "env-down", "env-sweep"];

/** The jobs of a pull request's environment (#4330). */
export const CI_ENV_JOB_NAMES: readonly PrEnvJob["jobName"][] = ["env-up", "env-post", "env-down", "env-sweep"];

/** Whether `job` is one of a pull request environment's jobs. */
export const isCiEnvJob = (job: CiJobName): job is PrEnvJob["jobName"] => (CI_ENV_JOB_NAMES as readonly string[]).includes(job);

/** The Op each job is recorded as, which `ci.green` phases match. An environment job's is its report's stem too. */
export const CI_JOB_OPS: Record<CiJobName, string> = { plan: "pr-plan", apply: "pr-apply", record: "pr-record", "env-up": "pr-env-up", "env-post": "pr-env-post", "env-down": "pr-env-down", "env-sweep": "pr-env-sweep" };

/** What each job's Op says it does. */
const CI_JOB_OVERVIEWS: Record<CiJobName, string> = {
  plan: "Plan the members this pull request reaches",
  apply: "Apply the plan a reviewer approved",
  record: "Record the plan on the merged commit; nothing applies",
  "env-up": "Plan this pull request's environment and apply it once its plan is approved",
  "env-post": "Keep the environment's record and post its note",
  "env-down": "Tear down what this pull request's environment owns",
  "env-sweep": "Tear down the environments whose TTL passed or whose pull request closed",
};

/** One job as `ci run` runs it: a pull-request job, or an environment job (#4330). */
export type CiJob = Pick<PrLoopJob, "command" | "env" | "setup" | "build" | "wave"> & { jobName: CiJobName };

/** Where a job writes its report, inside its checkout. */
export function ciJobReportDir(job: CiJobName): string {
  return isCiEnvJob(job) ? PR_ENV_REPORT_DIR : PR_LOOP_REPORT_DIR;
}

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
  /** `--head`: the pull request's head, `HEAD_SHA`, which `env-post` reads (#4330). */
  head?: string;
  /** `--result`: the env-up job's result, `UP_RESULT`, which `env-post` reads on GitHub and Forgejo (#4330). */
  upResult?: string;
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
  job: CiJob,
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
    HEAD_SHA: { value: input.values.head, flag: "--head <sha>" },
    UP_RESULT: { value: input.values.upResult, flag: "--result success|failure" },
  };
  // #4330: an environment job's CHANT_ENV is pr-<n>, which a forge fills from the event.
  const prEnv = isCiEnvJob(job.jobName) && input.values.pr !== undefined ? `pr-${input.values.pr}` : undefined;
  for (const [name, value] of Object.entries(job.env)) {
    const given = flags[name];
    if (given) {
      if (given.value === undefined) throw new CiRunError(`the ${job.jobName} job reads ${name}, which a forge fills from the event; pass ${given.flag}`);
      out[name] = given.value;
    } else if (name === "CHANT_ENV" && prEnv) {
      out[name] = prEnv;
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
  job: CiJob;
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
export function ciJobCommand(job: CiJob, chant?: string): string {
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
    overview: CI_JOB_OVERVIEWS[input.job.jobName],
    labels: { Env: input.env, Pipeline: "pr", Job: input.job.jobName },
    phases,
  };
}

/** The pull-request report statuses that mean the job did not do its work, which a failed job's `failure.code` takes. */
const FAILED_REPORT_STATUSES = new Set(["plan-failed", "failed", "refused", "incomplete"]);

/** The exit code a failed shell step's error names (`command exited <n>`), when it names one. */
function exitCodeOf(error: string | undefined): number | undefined {
  const m = /command exited (\d+)/.exec(error ?? "");
  return m ? Number(m[1]) : undefined;
}

/**
 * The code `chant ci run` exits with for a settled job: 0 when it passed,
 * else its command's own code when that is 1 to 255, such as 3 for a moved
 * plan or a waiting wave (#4156), else 1. The run index records the same
 * code (#4165).
 */
export function ciJobExitCode(result: { status: OpRunResult["status"]; exitCode?: number }): number {
  if (result.status === "ok") return 0;
  return result.exitCode && result.exitCode > 0 && result.exitCode < 256 ? result.exitCode : 1;
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
 * A job's status context: `chant/pr-plan` for the plan, `chant/pr-record` for the record (#4168), and for the apply
 * `chant/<gate>`, which is `chant/pr-apply` unless `--gate` renamed the gate.
 * pr-plan's own status is `chant/plan` (../pr-loop.ts), a different context.
 */
export function ciStatusContext(job: CiJobName, gate?: string, words: CiProductWords = activeProductWords()): string {
  // #4550: every context chant posts takes the product's prefix, so a product's repository shows no `chant/` check.
  return productContext(words, job === "apply" ? (gate ?? PR_APPLY_GATE) : CI_JOB_OPS[job]);
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
  /**
   * Run the job's command without `--forge` (#4016 gap 6): `ci serve --forge
   * git` reads a plain git server, which has no API for the command to ask.
   * `forge` then only shapes the job's variables.
   */
  noForge?: boolean;
  /** `--base`, `--pr` and `--commit` (default `HEAD`; for `env-post`, `--base`). */
  base?: string;
  pr?: number;
  commit?: string;
  /** `--head`: for `env-post` (#4330), the pull request's head its environment was applied from. */
  head?: string;
  /** `--result`: for `env-post` (#4330), the env-up job's result. */
  upResult?: string;
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
  /**
   * The forge client that posts the plan's note and `chant/plan` status from
   * its report once the steps settle (#4295). Default: one built from the
   * runner's environment when it holds a forge token.
   */
  planForge?: PrForge;
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
   * `--require-runner-start` (#4147): refuse the job before its first step
   * unless a runner-start statement, signed by a runner key
   * `.chant/trust.json` at `base` lists, names this forge job.
   */
  requireRunnerStart?: boolean;
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
  /**
   * For `env-up` (#4330): the `env-post` job the runner ran after it at
   * `--base`, with its own token, which kept the record and posted the note.
   */
  post?: CiRunResult;
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
  job: PrLoopJob["jobName"];
  commit: string;
  member?: string;
  pr?: number;
  record: OpRunRecord;
  runOrigin: RunOrigin;
  /** The runner that signed the record, or null (#4156). */
  signer: string | null;
  /** The code `chant ci run` exits with for the job (#4165). */
  exitCode: number;
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
    exitCode: input.exitCode,
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
  // #4330: env-post runs at the target branch's commit, none of the change's code.
  const commit = resolveJobCommit(top, req.commit ?? (req.job === PR_ENV_POST_JOB && req.base ? req.base : "HEAD"));
  if (req.inPlace && commit !== resolveJobCommit(top, "HEAD")) throw new CiRunError(`--in-place runs the checkout's HEAD, and --commit names ${commit.slice(0, 12)}`);
  if (req.local && req.inPlace) throw new CiRunError("--in-place runs a forge job in the forge's checkout, and --local runs one on this machine; pass one of them");
  const place = ciJobPlace(cwd, top);
  const loop = req.local ? localLoop(req.loop) : (req.loop ?? {});
  // #4330: the jobs of a pull request's environment, as the generators wrap them with --pr-env.
  const jobs: CiJob[] = isCiEnvJob(req.job) ? prEnvJobs(req.forge, loop, place.member) : prLoopJobs(req.forge, req.env, loop, place.member);
  const found = jobs.find((j) => j.jobName === req.job);
  if (!found) throw new CiRunError(`the pull-request pipeline has no ${req.job} job; it has ${jobs.map((j) => j.jobName).join(" and ")}`);
  if (req.wave !== undefined && (req.job !== "apply" || !req.loop?.waveGate)) throw new CiRunError("--wave names the one wave an apply runs, and takes --wave-gate: ci run apply --wave-gate <gate> --wave <k>");
  // #4147: before anything runs or any secret reaches a step, the provisioner's word that this runner was started for this job.
  // #4168: under the isolated-runners security group an apply job requires the statement too, unless it runs on this machine.
  const isolated = !req.requireRunnerStart && !req.local && req.job === "apply" && securityGroupsAt(cwd).has("isolated-runners");
  const started = req.requireRunnerStart || isolated ? runnerStartFor(req, { top, commit, hostEnv }) : undefined;
  // A generated wave job's command, as prLoopWaveJobs writes it. #4161: a local job's command posts no status or note.
  const forgeCommand = req.noForge ? found.command.replace(` --forge ${req.forge}`, "") : found.command;
  const noStatus = req.local && !/ --no-status(?: |$)/.test(forgeCommand);
  // #4325: a record or apply on a routed branch is told the branch, as the forge's ref would tell it in a pipeline. `ci serve` has no such ref.
  const branch = req.job !== "plan" && req.loop?.branch !== undefined && !/ --branch(?: |=)/.test(forgeCommand) ? ` --branch ${/^[A-Za-z0-9._\/=:@%+,-]+$/.test(req.loop.branch) ? req.loop.branch : `'${req.loop.branch.replace(/'/g, `'\\''`)}'`}` : "";
  const command = `${forgeCommand}${branch}${req.wave !== undefined ? ` --wave ${req.wave}` : ""}${noStatus ? " --no-status" : ""}`;
  const job = { ...found, command, ...(req.wave !== undefined ? { wave: req.wave } : {}) };
  const own = ciJobEnv(job, {
    forge: req.forge,
    env: req.env,
    values: { base: req.base, pr: req.pr, commit, ...(req.head ? { head: req.head } : {}), ...(req.upResult ? { upResult: req.upResult } : {}) },
    hostEnv,
    passEnv: req.passEnv,
    secrets: ciSecretsFor(req.secrets, req.job),
  });
  // #4156: in place, the forge job's environment is the job's, less the runner key.
  // #4295: the plan and env-up run the pull request's code, so no step of them gets a forge token, whatever gave it one.
  const merged = req.inPlace ? { ...definedEnv(hostEnv), ...own } : own;
  const jobEnv = req.job === "plan" || req.job === "env-up" ? withoutForgeTokens(merged) : merged;
  delete jobEnv[RUNNER_KEY_ENV];
  const poster = req.job === "plan" ? planPoster(req, hostEnv) : undefined;
  // #4096: the secrets and the job's secret-looking variables, redacted from everything the run writes and returns.
  // In place the forge's own variables come too; one whose value is short, such as a flag, is left out, so it can't blank common words.
  const redact = ciRedactor(req.inPlace ? { ...longValues(jobEnv), ...own } : jobEnv, req.secrets);
  try {
    const ran = await runCiJob(req, { cwd, top, commit, place, job, jobEnv, ...(redact ? { redact } : {}) });
    const posted = poster ? await postFromReport(req, poster, ran, { top, dir: place.dir, commit, ...(place.member ? { member: place.member } : {}) }) : [];
    const envPost = req.job === "env-up" ? await envPostAfterUp(req, { cwd, top, head: commit, place, jobs, hostEnv, ran }) : undefined;
    const withPost = envPost ? ("result" in envPost ? { ...ran, post: envPost.result } : { ...ran, warnings: [...ran.warnings, envPost.warning] }) : ran;
    const withPosts = posted.length > 0 ? { ...withPost, warnings: [...withPost.warnings, ...posted] } : withPost;
    const result = started ? { ...withPosts, notes: [started, ...withPosts.notes] } : withPosts;
    return redact ? { ...result, warnings: result.warnings.map(redact), notes: result.notes.map(redact), ...(result.pushWarning ? { pushWarning: redact(result.pushWarning) } : {}) } : result;
  } catch (err) {
    if (redact && err instanceof Error) err.message = redact(err.message);
    throw err;
  }
}

/**
 * The env-post job after an env-up (#4330), as a generated pipeline runs it
 * in a job of its own: at `--base`, the target branch's commit, with the
 * forge token env-up's steps never got, taking the report and record env-up
 * handed on. None on `--local`, in place (the forge's env-post job posts),
 * for a plain git server, without `--base` and `--pr`, or without a token.
 */
async function envPostAfterUp(
  req: CiRunRequest,
  at: { cwd: string; top: string; head: string; place: { member?: string; dir: string }; jobs: CiJob[]; hostEnv: Record<string, string | undefined>; ran: CiRunResult },
): Promise<{ result: CiRunResult } | { warning: string } | undefined> {
  if (req.local || req.inPlace || req.noForge || req.pr === undefined) return undefined;
  if (!req.base) return { warning: "env-post did not run: it runs at the target branch's commit, so pass --base <sha>" };
  if (!holdsForgeToken(at.hostEnv)) return { warning: "env-post did not run: there is no forge token, so the environment's record is in the report and nothing kept it" };
  const found = at.jobs.find((j) => j.jobName === PR_ENV_POST_JOB);
  if (!found) return undefined;
  const base = resolveJobCommit(at.top, req.base);
  const job = { ...found, command: req.noForge ? found.command.replace(` --forge ${req.forge}`, "") : found.command };
  const postReq: CiRunRequest = { ...req, job: PR_ENV_POST_JOB, commit: base, head: at.head, upResult: at.ran.status === "ok" ? "success" : "failure" };
  delete postReq.status;
  delete postReq.resumeRecord;
  delete postReq.wave;
  const jobEnv = ciJobEnv(job, { forge: req.forge, env: req.env, values: { base: req.base, pr: req.pr, commit: base, head: at.head, upResult: postReq.upResult! }, hostEnv: at.hostEnv, passEnv: req.passEnv, secrets: ciSecretsFor(req.secrets, PR_ENV_POST_JOB) });
  delete jobEnv[RUNNER_KEY_ENV];
  // Its own redactor: env-post holds the token env-up's steps never got.
  const redact = ciRedactor(jobEnv, req.secrets);
  try {
    const result = await runCiJob(postReq, { cwd: at.cwd, top: at.top, commit: base, place: at.place, job, jobEnv, ...(redact ? { redact } : {}), ...(at.ran.report ? { seed: at.ran.report } : {}) });
    return { result: redact ? { ...result, warnings: result.warnings.map(redact), notes: result.notes.map(redact), ...(result.pushWarning ? { pushWarning: redact(result.pushWarning) } : {}) } : result };
  } catch (err) {
    return { warning: `env-post did not run: ${message(err)}` };
  }
}

/**
 * Who posts the plan's note and `chant/plan` status (#4295): the runner,
 * from the report, once the plan's steps settled, with the forge token the
 * steps never got. None on `--local`, for a plain git server (`noForge`), or
 * without a token. In place, a token means the job was generated before the
 * plan-note job existed: the runner still posts, and says to regenerate.
 */
function planPoster(req: CiRunRequest, hostEnv: Record<string, string | undefined>): { forge: PrForge; warning?: string } | { error: string } | undefined {
  if (req.local || req.noForge || req.pr === undefined) return undefined;
  const warning = req.inPlace
    ? "this plan job holds a forge token, which the pull request's code runs beside in the same job; regenerate the pipeline, whose plan-note job posts the note from a fresh job (#4295)"
    : undefined;
  if (req.planForge) return { forge: req.planForge, ...(warning ? { warning } : {}) };
  if (!holdsForgeToken(hostEnv)) return undefined;
  try {
    return { forge: forgeFromEnv(req.forge, hostEnv), ...(warning ? { warning } : {}) };
  } catch (err) {
    return { error: `the plan's note and status will not be posted: ${message(err)}` };
  }
}

/** Post the plan's note and status from the report the job wrote (#4295), and return the warnings. */
async function postFromReport(
  req: CiRunRequest,
  poster: NonNullable<ReturnType<typeof planPoster>>,
  ran: CiRunResult,
  at: { top: string; dir: string; commit: string; member?: string },
): Promise<string[]> {
  if ("error" in poster) return [poster.error];
  const warnings = poster.warning ? [poster.warning] : [];
  const checked: string[] = [];
  const dir = ran.report ?? resolve(req.cwd, req.output ?? PR_LOOP_REPORT_DIR);
  const posted = await postPlanReport({
    forge: poster.forge,
    dir,
    pr: req.pr!,
    head: at.commit,
    env: req.env,
    ...(at.member ? { member: at.member } : {}),
    result: ran.status === "ok" ? "success" : "failure",
    // #4328: as pr-post does (#4289), with the Ops read at --base, never from the change's checkout.
    overdue: () => overdueAtBase(req, { forge: poster.forge, top: at.top, dir: at.dir, ...(at.member ? { member: at.member } : {}), log: (line) => checked.push(line) }),
  });
  if (posted.refused) warnings.push(`the plan report was not posted: ${posted.refused}`);
  return [...warnings, ...checked, ...posted.warnings];
}

/**
 * The overdue check for the plan's note (#4289, #4328), at `--base`, as the
 * plan-note job's `pr-post` runs it at the target branch's commit. The Ops
 * are read from a fresh checkout of the base outside the repository, never
 * from the checkout the change's code ran in, in place or not. That checkout
 * resolves packages from the `node_modules` the running chant is installed
 * in ({@link chantNodeModules}), so an Op file's `@intentius/chant` is the
 * chant running the job, not one the change installed. Without `--base`
 * nothing is checked, and `log` says so.
 */
async function overdueAtBase(
  req: CiRunRequest,
  at: { forge: PrForge; top: string; dir: string; member?: string; log: (line: string) => void },
): Promise<PrOverdue[]> {
  if (!at.forge.scheduledRuns) return [];
  if (!req.base) {
    at.log("the scheduled Ops were not checked: the check reads them at the target branch's commit, so pass --base <sha>");
    return [];
  }
  let checkout: { dir: string; remove(): void };
  try {
    checkout = freshCheckout(at.top, resolveJobCommit(at.top, req.base));
  } catch (err) {
    at.log(`the scheduled Ops were not checked: ${message(err)}`);
    return [];
  }
  try {
    const modules = chantNodeModules();
    const link = join(checkout.dir, "node_modules");
    if (modules && !existsSync(link)) symlinkSync(modules, link, "dir");
    return await overdueOpsAt({ forge: at.forge, cwd: at.dir === "." ? checkout.dir : join(checkout.dir, at.dir), ...(at.member ? { member: at.member } : {}), log: at.log });
  } finally {
    checkout.remove();
  }
}

/**
 * The `node_modules` directory the running chant is installed in, or
 * undefined when it runs from a source checkout, where chant's own packages
 * resolve without one (../ts-loader.ts).
 */
export function chantNodeModules(from: string = fileURLToPath(import.meta.url)): string | undefined {
  let dir = dirname(from);
  for (;;) {
    if (basename(dir) === "node_modules") return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * `--require-runner-start` (#4147): the runner-start statement for this
 * forge job, checked against `.chant/trust.json` at `--base` (the commit
 * before the change, as a push's `before` is), or at the job's commit
 * without one. Throws {@link CiRunError} unless it verifies.
 */
function runnerStartFor(req: CiRunRequest, at: { top: string; commit: string; hostEnv: Record<string, string | undefined> }): string {
  if (req.local) throw new CiRunError("--require-runner-start checks a forge job's runner, and --local runs the job on this machine");
  const base = req.base ? resolveJobCommit(at.top, req.base) : at.commit;
  try {
    return requireRunnerStart({ top: at.top, base, commit: at.commit, env: at.hostEnv }).reason;
  } catch (err) {
    throw new CiRunError(message(err));
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

/**
 * The steps' environment (#4275). A job the chant runner ran gets its run's id
 * and origin, so a release record written inside it names the run the run
 * index lists, and none of the forge's run variables. Any other job, in place
 * in a forge job or on this machine, never carries the runner's.
 */
export function ciRunStepEnv(jobEnv: Record<string, string>, origin: RunOrigin, runId: string): Record<string, string> {
  const out = { ...jobEnv };
  delete out[CHANT_CI_RUN_ID_ENV];
  delete out[CHANT_CI_RUN_FORGE_ENV];
  if (origin.forge !== "chant") return out;
  for (const name of FORGE_RUN_ENV) delete out[name];
  out[CHANT_CI_RUN_ID_ENV] = runId;
  out[CHANT_CI_RUN_FORGE_ENV] = "chant";
  return out;
}

/** Where the job runs: a fresh worktree of the commit, or with `inPlace` the checkout itself, which is left as it is. */
function jobCheckout(top: string, commit: string, inPlace?: boolean): { dir: string; remove(): void } {
  return inPlace ? { dir: top, remove() {} } : freshCheckout(top, commit);
}

/** {@link ciRun} once the job and its environment are known. */
async function runCiJob(
  req: CiRunRequest,
  at: { cwd: string; top: string; commit: string; place: { member?: string; dir: string }; job: CiJob; jobEnv: Record<string, string>; redact?: Redact; seed?: string },
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
    const runId = req.runId ?? `chant-${Date.now()}`;
    const op = ciJobOp({
      job,
      env: req.env,
      cwd: jobDir,
      jobEnv: ciRunStepEnv(jobEnv, origin, runId),
      setup: req.inPlace ? [] : prLoopSetup(req.image ?? PR_LOOP_IMAGE),
      build: [...(req.beforeScript ?? []), ...(job.build ?? [])],
      ...(req.chant ? { chant: req.chant } : {}),
    });
    const warnings: string[] = [...early];
    // #4330: env-post takes the report env-up wrote, as a forge job takes it from the up job's outputs.
    if (at.seed && existsSync(at.seed)) cpSync(at.seed, join(jobDir, ciJobReportDir(req.job)), { recursive: true });
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
        describeFailure: (records) => ciJobFailure({ job: req.job, op, records, reportDir: join(jobDir, ciJobReportDir(req.job)) }),
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
    const written = join(jobDir, ciJobReportDir(req.job));
    let report: string | null = null;
    if (existsSync(written)) {
      report = resolve(cwd, req.output ?? ciJobReportDir(req.job));
      // In place the report is already where the forge keeps it, and stays as the command wrote it.
      if (!(existsSync(report) && realpathSync(report) === realpathSync(written))) {
        cpSync(written, report, { recursive: true });
        if (redact) redactTree(report, redact);
      }
    }
    const failed = result.records.find((r) => r.status === "fail");
    const exitCode = failed?.phase === req.job ? exitCodeOf(failed.error) : undefined;
    // The run index lists the pull-request jobs; an environment job's run is in its record only (#4330).
    if (reportUrl && !isCiEnvJob(req.job)) {
      await recordInIndex({ url: reportUrl, job: req.job, commit, member: place.member, pr: req.pr, record: result.record, runOrigin: origin, signer: result.record.statement && signer ? signer.principal : null, exitCode: ciJobExitCode({ status: result.status, ...(exitCode !== undefined ? { exitCode } : {}) }), reportDir: written, limit: req.runIndexLimit, ...(redact ? { redact } : {}), warn: (w) => warnings.push(w) });
    }
    // In place the forge job's outcome is the command's, so a record that could not be written is a warning there.
    if (ledgerError && req.inPlace) warnings.push(ledgerError);
    else if (ledgerError) throw new CiRunError(ledgerError);
    const pushed: { pushed: boolean; pushWarning?: string } = local
      ? { pushed: false }
      : req.push === false ? { pushed: false, pushWarning: "chant/lifecycle was not pushed" } : await pushLifecycleReport({ cwd: top });
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
 * `--pr-build-command`, `--wave-gate` (#4003) and `--require-review`
 * (#4168; `--no-require-review`, the default, is still accepted).
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
    ...(args.requireReview === true ? { requireReview: true } : {}),
    ...(args.applyBeforeMerge ? { applyBeforeMerge: true } : {}),
    ...(args.requires ? { applyRequires: args.requires } : {}),
    ...(args.parallelism !== undefined ? { parallelism: args.parallelism } : {}),
    ...(args.commentTargets ? { commentTargets: true } : {}),
    ...(args.refresh ? { refresh: true } : {}),
  };
}

const USAGE =
  "chant ci run plan|record|apply|env-up|env-post|env-down|env-sweep --env <env> --base <sha> [--pr <n>] [--commit <sha>] [--head <sha>] [--result <r>] [--forge github|gitlab|forgejo] " +
  "[--gate <name>] [--wave-gate <name>] [--wave <k>] [--branch <name>] [--events-json] [--report-url <url>] [--run-index-limit <n>] [--image <image>] [--before-script <line>]... " +
  "[--pr-build] [--pr-build-command <line>] [--parallelism <n>] [--comment-targets] [--refresh] [--require-review] [--apply-before-merge [--requires <list>]] [--no-status] [--status-url <url template>] " +
  "[--chant <command>] [--pass-env <NAME>]... [--secrets <file>] [--key <runner key.pem>] [-o <dir>] [--in-place | --local] [--no-push] [--verbose] | chant ci run --at <sha> | chant ci run --setup-key [--trust [--principal <name>]] [--state <dir>] [--branch <name>]";

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

/**
 * `chant ci run --at <sha>` (#4169): ask for every required phase to be built
 * at a commit of the green branch. On GitHub, with a token in the
 * environment, the workflows holding the phases start at once.
 */
async function requestBuildCommand(at: string): Promise<number> {
  const { requestBuild } = await import("./ci-green");
  const { ciForgeFromEnv } = await import("./ci-green-forge");
  let forge: Awaited<ReturnType<typeof ciForgeFromEnv>> | undefined;
  try {
    forge = process.env.GITHUB_REPOSITORY ? ciForgeFromEnv("github") : undefined;
  } catch {
    forge = undefined;
  }
  const r = await requestBuild({ cwd: process.cwd(), at, ...(forge ? { forge } : {}) });
  for (const w of r.warnings) console.error(formatWarning({ message: w }));
  const what = `${r.request.phases.join(", ")} at ${r.request.commit.slice(0, 12)}`;
  console.log(
    `${r.existed ? `${r.request.tag} already asks for a build` : `Asked for ${what}: ${r.request.tag}`}. ` +
      (r.dispatched.length > 0 ? `Started ${r.dispatched.join(", ")}.` : "The next ci tick starts it on GitHub, and ci serve --build-command serves it for chant runs."),
  );
  return 0;
}

/** `chant ci run plan|record|apply` (#4094, #4168). */
export async function runCiRun(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  try {
    if (args.setupKey) return (await import("./ci-serve")).runnerKeySetupCommand(ctx);
    if (args.at !== undefined && args.extraPositional === undefined) return await requestBuildCommand(args.at);
    const job = args.extraPositional as CiJobName | undefined;
    if (!job || !CI_JOB_NAMES.includes(job)) throw new CiRunError(`ci run takes the job to run, ${CI_JOB_NAMES.join(", ")}${job ? `, not ${JSON.stringify(job)}` : ""}`);
    // #4330: an environment job's environment is pr-<n>; the sweep's run is recorded under --env, else local.
    const env = args.env ?? (isCiEnvJob(job) ? (args.pr !== undefined && job !== "env-sweep" ? `pr-${args.pr}` : "local") : undefined);
    if (!env) throw new CiRunError("--env names the environment the pipeline is for, as chant build --components --generate <lexicon> --pr-loop took it: --env <env>");
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
    // #4160: without --report-url, the declaration's ci.reportUrl.
    const reportUrl = await reportUrlOf(args.reportUrl, process.cwd());
    const result = await ciRun({
      cwd: process.cwd(),
      ...(status ? { status } : {}),
      job,
      env,
      forge: forge as ForgeKind,
      ...(args.base ? { base: args.base } : {}),
      ...(args.pr !== undefined ? { pr: args.pr } : {}),
      ...(args.commit ? { commit: args.commit } : {}),
      ...(args.head ? { head: args.head } : {}),
      ...(args.planResult ? { upResult: args.planResult } : {}),
      loop: ciLoopOptions(reportUrl ? { ...args, reportUrl } : args),
      ...(args.ciInPlace ? { inPlace: true } : {}),
      ...(args.local ? { local: true } : {}),
      ...(args.noPush ? { push: false } : {}),
      ...(args.wave !== undefined ? { wave: args.wave } : {}),
      ...(args.requireRunnerStart ? { requireRunnerStart: true } : {}),
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
    if (result.post) {
      for (const w of result.post.warnings) console.error(formatWarning({ message: w }));
      console.error(formatCiRun(result.post));
    }
    // #4156: a failed command's own exit code, such as 3 for a moved plan, is the job's, as it was before the job ran through ci run.
    // #4330: an env-up whose env-post failed fails too, since its record was not kept.
    const code = ciJobExitCode(result);
    return code === 0 && result.post ? ciJobExitCode(result.post) : code;
  } catch (err) {
    console.error(formatError({ message: `chant ci run: ${message(err)}`, hint: USAGE }));
    return 1;
  }
}
