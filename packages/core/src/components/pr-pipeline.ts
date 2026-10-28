/**
 * The jobs of a generated pull-request pipeline (#3183): a plan job on every
 * pull request and, on every push to the target branch, a record job, or an
 * apply job when the pipeline opts into apply on merge (#4168).
 *
 * Each forge's generator (the github, gitlab and forgejo lexicons) adds its
 * own triggers, permissions and artifact handling; the commands and the
 * values they read from the forge live here so the three cannot disagree.
 *
 * - The plan job runs `chant components pr-plan` against the pull request's
 *   target commit. It writes nothing to `chant/lifecycle` and holds no forge
 *   token, since it runs the pull request's code (#4295): it writes the note
 *   and the status into its report with `--no-status`, and the `plan-note`
 *   job after it posts them with `chant components pr-post`
 *   ({@link prLoopPostJob}, ../ci-handover.ts).
 * - The record job (#4168 step 1, the default) runs `chant components
 *   pr-record` against the commit the push replaced. It plans the same
 *   members on the merged commit, stores the change set and writes the merge
 *   record, `_merges/<commit>.json` on `chant/lifecycle`. It applies nothing:
 *   a release that carries the commit deploys it. It needs write access to
 *   `chant/lifecycle`. One record runs at a time per environment.
 * - With `applyOnMerge` the apply job takes the record job's place. It runs
 *   `chant components pr-apply` against the commit the
 *   push replaced, finds the pull request that merged the pushed commit
 *   through the forge, and applies only when an approval stands for the
 *   digest it plans. With `requireReview` (off by default since #4168, on
 *   under the `review-rules` security group) the approver must also have
 *   approved the pull request on the forge. It needs write access
 *   to `chant/lifecycle`, to record the pending fact when the gate stops it.
 *   One apply runs at a time per environment.
 *
 * The apply job passes `--resume` (#3543) with a record path outside the
 * report directory, and each forge keeps that file in its CI cache under a
 * key that names the environment, the member and the pushed commit
 * (`prApplyRecordKey`). A re-run of a failed apply job restores it and
 * finishes the approved set under the same approval; the record itself is
 * checked against the pull request's gate, the commit, the selection and
 * the ledger before it counts (`pr-apply --resume`, #3464).
 *
 * Measuring the push from the commit it replaced works for merge commits,
 * squash merges and rebase merges alike, and every job measures from the
 * merge base of that commit and its own head (`resolveMergeBase`).
 *
 * With `events` (#4007) both commands pass `--events-json`, so the job log
 * carries the run-event stream, and keep a copy of it under the report
 * directory through `CHANT_RUN_EVENTS_DIR`, so the report artifact carries
 * it too. With `reportUrl` both pass `--report-url`, which copies the report,
 * the change set and the events where a reader outside CI can fetch them;
 * the job's own environment brings the credentials an `s3://` URL needs.
 * The record job passes the same flags as the apply.
 *
 * With `build` (#4088) both jobs run the project's build and `chant lint`
 * before their command, and fail on an error. A `cfn-deploy` member's plan
 * and apply read the built template, so a project with one needs it. The
 * build is `chant build --env <env>`, or `buildCommand` when the templates
 * come from several builds (`npm run build`).
 *
 * With `waveGate` (#4003) the apply runs a wave at a time: `pr-apply
 * --wave-gate <gate>`, each wave planned after the one before it applied. A
 * generator writes one apply job per wave of the component graph
 * (`prLoopWaveJobs`), job `apply-wave-<k>` passing `--wave <k>` and needing
 * the job before it, and the attempt record carries the approved set from
 * one job to the next. A wave whose plan the approved change set covers
 * applies under the pull request's approval; one whose plan moved stops at
 * `<gate>-wave-<k>` (exit 3), and re-running its job after the approval
 * carries on. `chant ci serve` runs the one apply job, which runs the waves
 * in order until one stops.
 *
 * Each generated job runs its command through `chant ci run plan|apply
 * --in-place` (#4156, `PrLoopJob.run`), so a forge job writes the same run
 * record the chant runner does: Op `pr-plan` or `pr-apply`, signed with
 * the runner key a forge secret puts in `CHANT_RUNNER_KEY`, and naming the
 * forge's run as its `runOrigin`. `ci run` runs `command` in the job's own
 * checkout with the job's environment, less the key. The plan passes
 * `--no-push`, so it still writes nothing to the remote `chant/lifecycle`.
 * The plan job gets no `CHANT_RUNNER_KEY` (#4328): it runs the pull request's
 * code, and a key in the job's environment is one that code could read and
 * sign with, whatever `ci run` leaves out of its steps. Its record is
 * unsigned.
 *
 * In a workspace member (#3465) both commands run in the member's directory
 * and pass `--member <name>`, so the member's gate (`pr-<number>-<member>`),
 * note and statuses stay apart from every other member's on the same pull
 * request. They still measure the whole change: a file outside the member
 * that one of its units reaches selects that unit.
 */

import type { ForgeKind } from "../pr-forge";
import { PR_APPLY_GATE } from "../pr-loop";
import { parseRequiresList } from "../pr-requires";
import { CI_IMAGE, GITHUB_JOB_TOKEN } from "../ci-jobs";
import { withoutForgeTokens } from "../ci-handover";
import { EMPTY_TREE_SHA } from "./changed-files";
import { layerWaves } from "../gated-waves";
import type { DriverComponent } from "./driver";
import type { GatedWavePipelineOptions } from "./gated-wave-pipeline";
import type { CloudTradeSpec, PipelineCloudIdentity } from "../ci-identity";
import { commentLine, resolveProductWords, type CiProductWords, type CiProductWordsInput } from "../ci-product-words";
import type { ControlTarget } from "../control/dispatch";

/** The variable `chant ci run` reads its runner key from (`RUNNER_KEY_ENV` in ../workspace/ci-green.ts). */
const RUNNER_KEY_ENV = "CHANT_RUNNER_KEY";

/** Where both jobs write their reports, kept as a CI artifact. */
export const PR_LOOP_REPORT_DIR = ".chant/pr";

/**
 * The attempt record the apply job resumes from (#3543), relative to the
 * directory the job runs in. It sits outside `PR_LOOP_REPORT_DIR`, so the
 * report artifact never carries it: it holds the outputs the members read.
 */
export const PR_APPLY_RECORD = ".chant/pr-resume/pr-apply.json";

/**
 * The image the pull-request pipeline runs in when the caller sets none. The
 * full `node` image has git, which both jobs measure the change with;
 * `PR_LOOP_SETUP` adds OpenTofu on top of it. A caller who sets `image`
 * brings both and gets no setup lines.
 */
export const PR_LOOP_IMAGE = CI_IMAGE;

/** Installs OpenTofu into `PR_LOOP_IMAGE`. */
export const PR_LOOP_SETUP = [
  "command -v tofu >/dev/null 2>&1 || (curl -fsSL https://get.opentofu.org/install-opentofu.sh -o /tmp/install-opentofu.sh && sh /tmp/install-opentofu.sh --install-method standalone)",
];

/**
 * The setup lines for a pipeline running in `image`: the install when it is
 * the default image, none otherwise. `engine` is the lines the project's
 * lexicons give (#4550, `LexiconPlugin.ciSetup`, {@link engineSetupLines}):
 * Pulumi or plunge for a Pulumi member, OpenTofu for a Terraform one. Absent,
 * OpenTofu, as before.
 */
export function prLoopSetup(image: string, engine?: readonly string[]): string[] {
  if (image !== PR_LOOP_IMAGE) return [];
  return engine && engine.length > 0 ? [...engine] : PR_LOOP_SETUP;
}

/**
 * Join the setup lines each lexicon gives (#4550), each line once, in the
 * order the lexicons come. A project whose lexicons give none gets none, and
 * {@link prLoopSetup} then falls back to OpenTofu.
 */
export function engineSetupLines(perLexicon: ReadonlyArray<readonly string[] | undefined>): string[] {
  return [...new Set(perLexicon.flatMap((lines) => lines ?? []))];
}

/**
 * Where the jobs keep their run-event files with `events` (#4007), as
 * `CHANT_RUN_EVENTS_DIR`: inside the report directory, so the report
 * artifact carries them.
 */
export const PR_LOOP_EVENTS_DIR = `${PR_LOOP_REPORT_DIR}/run-events`;

/** The `prLoop` generator option (`ComponentPipelineOptions.prLoop`). */
export interface PrLoopPipelineOptions {
  /** The gate the apply waits on. Default `pr-apply`. */
  gate?: string;
  /**
   * The branch pull requests target and merges land on. Default `main` on
   * GitHub and Forgejo; on GitLab, the project's default branch.
   */
  branch?: string;
  /** Count an approval only from someone who approved the pull request on the forge. Default false (#4168): review rules are opt-in. */
  requireReview?: boolean;
  /** The job on merge (apply, or record since #4168) has `chant ci run` refuse to start without a runner-start statement for it (`--require-runner-start`, #4147), as under the `isolated-runners` security group (#4168). Default false. */
  requireRunnerStart?: boolean;
  /**
   * Apply the approved plan on merge (#4168), as every pull-request pipeline
   * did before #4168: the apply job in place of the record job. Default
   * false, so a merge deploys nothing. `waveGate` needs it.
   */
  applyOnMerge?: boolean;
  /**
   * Apply an open pull request before it merges (#4301, ws-106): the apply
   * job runs `pr-apply --before-merge` at the pull request's head, started
   * by a `/chant apply` comment on GitHub and Forgejo, or on GitLab by a
   * pipeline of the target branch with `CHANT_APPLY_PR` set. A merge still
   * records. `pr-apply` refuses unless the declaration at base sets
   * `ci.workflow: "apply-before-merge"`. It takes neither `applyOnMerge`,
   * `waveGate` nor `build`.
   */
  applyBeforeMerge?: boolean;
  /**
   * The requires checks the apply before merge asks (#4607): a product's
   * `apply.requires`, passed as `pr-apply --requires <list>`. Absent: all
   * four. Only with `applyBeforeMerge`.
   */
  applyRequires?: readonly string[];
  /**
   * Stream each job's run events (#4007): `--events-json` on both commands,
   * and `CHANT_RUN_EVENTS_DIR` set to {@link PR_LOOP_EVENTS_DIR}. Default false.
   */
  events?: boolean;
  /**
   * Copy each job's report, change set and events to this `s3://` or
   * `file://` URL (#4007, `--report-url`), under `<pr>/<commit>/`. It is
   * passed in double quotes, so it may name a variable the job expands,
   * such as `$CHANT_REPORT_URL`.
   */
  reportUrl?: string;
  /**
   * Build and lint before `pr-plan` and before `pr-apply` (#4088): the build
   * line, then `chant lint`, each failing the job on an error. A `cfn-deploy`
   * member reads the built template, so a project with one sets this. The
   * build line is `chant build --env <env>` unless `buildCommand` names
   * another. Default false.
   */
  build?: boolean;
  /**
   * The shell line that builds the project in place of `chant build --env
   * <env>`, for a project whose templates come from several builds, such as
   * `npm run build`. Setting it turns `build` on.
   */
  buildCommand?: string;
  /**
   * A gate per wave on merge (#4003): the apply runs `pr-apply --wave-gate
   * <waveGate>`, a wave at a time, and a generator writes one apply job per
   * wave. Set from `--wave-gate` beside `--pr-loop` ({@link prLoopWithWaves}).
   */
  waveGate?: string;
  /**
   * The plan and apply cloud identities (#4296), from `ci.identity.cloud`
   * resolved for the pipeline's environment and member
   * (`resolveCloudIdentity` in ../ci-identity.ts). The plan job trades its
   * OIDC token for the plan identity before the checkout, the record job
   * for the plan identity, and the apply jobs for the apply identity.
   * Absent: no job requests an OIDC token.
   */
  identity?: PipelineCloudIdentity;
  /**
   * Which GitHub-shaped forge the workflow is for. Set by the forgejo
   * generator, which reuses the github one; a caller never needs to.
   */
  forge?: "github" | "forgejo";
  /**
   * An environment per open pull request (#4298, `ci.prEnvironment`): an
   * `env-up` job on each opened, updated or reopened pull request, an
   * `env-down` job when it closes, and an `env-sweep` job on a schedule
   * ({@link prEnvJobs}). Set from `--pr-env` beside `--pr-loop`. Default false.
   */
  prEnvironment?: boolean;
  /**
   * `ci.locks: plan` (#4293, #4327): a `lock` job after the plan that runs
   * `chant lock --from-report`, and an `unlock` job when the pull request
   * closes that runs `chant unlock`. Both check out the target branch's
   * commit, so neither runs the change's code. Set from the declaration at
   * base; GitHub and Forgejo only. Absent: neither job.
   */
  locks?: "plan";
  /**
   * `ci.lockGrain: repo` (#4552): one apply at a time in the repository.
   * GitHub's apply jobs share the concurrency group `chant-apply-repo`,
   * GitLab's the resource group of that name, and Forgejo's take the lock
   * tag `refs/tags/chant-apply-lock` in the apply step (./repo-lock.ts). Set
   * from the declaration at base. Absent: per environment and member.
   */
  lockGrain?: "repo";
  /**
   * The cloud identity a pull request environment's jobs take (#4330), from
   * `ci.identity.cloud` (`resolvePrEnvCloudIdentity` in ../ci-identity.ts):
   * the apply identity of a rule that names the pull request environments.
   * env-up, env-down and env-sweep trade their OIDC token for it before the
   * checkout, and env-up's later steps start without the token variables.
   * Absent: they request no OIDC token.
   */
  prEnvIdentity?: CloudTradeSpec;
  /**
   * The product's words (#4550, `@intentius/chant/ci-product`): the comment
   * a job answers, and with `bin` the command every job runs in place of
   * `chant`, whose bin passes the rest to chant in process with the words.
   * The statuses and the note take the words in the running job, from the
   * bin. Absent: chant's.
   */
  words?: CiProductWordsInput | CiProductWords;
  /** The engine install lines of the project's lexicons (#4550), for {@link prLoopSetup}. */
  engineSetup?: string[];
  /**
   * The control repo (#4568, `@intentius/chant/ci-control`): after the last
   * apply on merge succeeds, a `control-dispatch` job tells the control
   * repo this member applied, and the control repo runs its dependents.
   * The job maps the target's secret into `CHANT_CONTROL_TOKEN` for its one
   * step; on GitLab, where a CI/CD variable reaches every job, the plan job
   * unsets it with the forge tokens. `sentCheck` and `markSent` are the
   * product's shell lines that find and set the commit's control status.
   * Needs `applyOnMerge` or `waveGate`; ignored under `applyBeforeMerge`,
   * which applies no default branch.
   */
  control?: { target: ControlTarget; sentCheck?: string; markSent?: string };
}

/** The lock job's step names and commands (#4327), shared by the GitHub-shaped generators. */
export const PR_LOCK_JOB = "lock";
export const PR_UNLOCK_JOB = "unlock";

/** `chant lock --from-report` for the plan's report in {@link PR_LOOP_REPORT_DIR}; reads `PR_NUMBER` and `HEAD_SHA`. */
export function prLockCommand(forge: ForgeKind): string {
  return ["chant", "lock", "--from-report", `${PR_LOOP_REPORT_DIR}/pr-plan.json`, "--pr", '"$PR_NUMBER"', "--head", '"$HEAD_SHA"', "--stage", "plan", "--forge", forge].join(" ");
}

/** `chant unlock` for the pull request that closed; reads `PR_NUMBER`. */
export const PR_UNLOCK_COMMAND = 'chant unlock --pr "$PR_NUMBER"';

/** One job's command and the forge values it reads, as environment variables for its step. */
export interface PrLoopJob {
  /** `plan`, `apply` or `record` (#4168). */
  jobName: "plan" | "apply" | "record";
  /** The command line. Reads `$BASE_SHA` and, for the plan, `$PR_NUMBER`. */
  command: string;
  /**
   * Values the command reads, by variable name, as the forge spells them:
   * `${{ ... }}` expressions on GitHub and Forgejo, GitLab's predefined
   * variables on GitLab.
   */
  env: Record<string, string>;
  /** Shell lines to run before the command, to settle values the forge may leave unusable. */
  setup?: string[];
  /**
   * Shell lines a generated job runs first, before `setup`, to check out the
   * commit it works on (#4168 step 9): the apply checks out the newest green
   * commit. `chant ci run` and `ci serve` already run the job at that commit,
   * so they skip these.
   */
  checkout?: string[];
  /** With `build` (#4088): the build line and the lint line, run in this order before the command. */
  build?: string[];
  /** With `waveGate` (#4003): the wave a generated apply job runs, 1-based. */
  wave?: number;
  /**
   * The branch an apply job takes its green commit from (#4168 step 9). A
   * wave after the first checks out the commit wave 1 took, which the job
   * receives as `GREEN_SHA` (#4221).
   */
  greenBranch?: string;
  /**
   * What the generated job runs in place of `command` (#4156): `chant ci run
   * <job> --in-place` with the same environment, gate, forge, events and
   * report URL, which runs `command` and records the run. `env` is the
   * job's `env` and, on GitHub and Forgejo, `CHANT_RUNNER_KEY` from the
   * repository secret of that name, except for the plan, which runs the
   * pull request's code (#4328). GitLab hands its CI/CD variables to a job
   * itself, so there the key is a protected variable, which a merge request
   * pipeline never gets.
   */
  run: { command: string; env: Record<string, string> };
}

/** The lines `build` (#4088) runs before a job's command: the build, then the lint. Empty without the option. */
export function prLoopBuildLines(env: string, options: PrLoopPipelineOptions = {}): string[] {
  if (!options.build && !options.buildCommand) return [];
  return [options.buildCommand ?? `chant build --env ${env}`, "chant lint"];
}

/**
 * The jobs for `forge`: plan, apply and record, in that order. A generator
 * writes the plan and, on merge, {@link prLoopMergeJob}'s choice of the
 * other two. `member` is the workspace member the pipeline is generated for;
 * the commands then run in its directory, so `--output` is relative to it.
 */
export function prLoopJobs(forge: ForgeKind, env: string, options: PrLoopPipelineOptions = {}, member?: string): PrLoopJob[] {
  const gate = options.gate ?? PR_APPLY_GATE;
  const early = options.applyBeforeMerge === true;
  if (early && options.applyOnMerge) throw new Error("--apply-before-merge applies an open pull request and a merge records, so it takes no --apply-on-merge; pass one of them");
  if (early && options.waveGate) throw new Error("--apply-before-merge applies the pull request's plan in one job, so it takes no --wave-gate");
  if (early && (options.build || options.buildCommand)) throw new Error("--apply-before-merge runs no build before its requires checks, so it takes no --pr-build or --pr-build-command yet");
  if (options.applyRequires && !early) throw new Error("--requires names the checks of an apply before merge, so it needs --apply-before-merge");
  const asked = options.applyRequires ? parseRequiresList(options.applyRequires) : undefined;
  if (asked && "error" in asked) throw new Error(asked.error);
  const requires = early && asked ? ["--requires", asked.checks.join(",")] : [];
  const common = [
    "--env", env, "--gate", gate, "--output", PR_LOOP_REPORT_DIR, "--forge", forge,
    ...(member ? ["--member", member] : []),
    ...(options.events ? ["--events-json"] : []),
    ...(options.reportUrl ? ["--report-url", JSON.stringify(options.reportUrl)] : []),
  ];
  const github = forge !== "gitlab";
  const buildLines = prLoopBuildLines(env, options);
  const build = buildLines.length > 0 ? { build: buildLines } : {};
  const jobEnv: Record<string, string> = {
    ...(github ? { GITHUB_TOKEN: GITHUB_JOB_TOKEN } : {}),
    ...(options.events ? { CHANT_RUN_EVENTS_DIR: PR_LOOP_EVENTS_DIR } : {}),
  };
  // #4156: the flags `chant ci run` rebuilds `command` from. It finds the member from the directory it runs in.
  const ciRun = (job: PrLoopJob["jobName"]): string[] => [
    "chant", "ci", "run", job, "--in-place", ...(job === "plan" ? ["--no-push"] : []),
    ...(job === "apply" && !early ? [] : ["--base", '"$BASE_SHA"']), ...(job === "plan" || (job === "apply" && early) ? ["--pr", '"$PR_NUMBER"'] : []),
    ...(job === "apply" && early ? ["--apply-before-merge", ...requires] : []),
    "--env", env, "--gate", gate, "--forge", forge,
    ...(job !== "record" && options.waveGate ? ["--wave-gate", options.waveGate] : []),
    ...(job !== "plan" && options.branch ? ["--branch", JSON.stringify(options.branch)] : []),
    ...(job === "apply" && options.requireReview === true ? ["--require-review"] : []),
    ...(job !== "plan" && options.requireRunnerStart === true ? ["--require-runner-start"] : []),
    ...(options.events ? ["--events-json"] : []),
    ...(options.reportUrl ? ["--report-url", JSON.stringify(options.reportUrl)] : []),
  ];
  const runEnv = (env: Record<string, string>): Record<string, string> => (github ? { ...env, [RUNNER_KEY_ENV]: `\${{ secrets.${RUNNER_KEY_ENV} }}` } : env);
  // #4295: the plan runs the pull request's code, so it gets no forge token. It writes the note and the
  // status into its report (--no-status), and the plan-note job posts them (prLoopPostJob).
  const planEnv = github
    ? { BASE_SHA: "${{ github.event.pull_request.base.sha }}", PR_NUMBER: "${{ github.event.pull_request.number }}", ...withoutForgeTokens(jobEnv) }
    : { BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA", PR_NUMBER: "$CI_MERGE_REQUEST_IID", ...withoutForgeTokens(jobEnv) };
  const greenBranch = github ? JSON.stringify(options.branch ?? "main") : options.branch ? JSON.stringify(options.branch) : "$CI_DEFAULT_BRANCH";
  const applyEnv = github ? { BASE_SHA: "${{ github.event.before }}", ...jobEnv } : { BASE_SHA: "$CI_COMMIT_BEFORE_SHA", ...jobEnv };
  // #4301: the apply before merge runs in a job of the target branch, whose commit is the base, at the pull request's head.
  const earlyEnv = github
    ? { BASE_SHA: "${{ github.sha }}", PR_NUMBER: "${{ github.event.issue.number }}", ...jobEnv }
    : { BASE_SHA: "$CI_COMMIT_SHA", PR_NUMBER: `$${GITLAB_APPLY_PR_VAR}`, ...jobEnv };
  const greenApply: PrLoopJob = {
    // #4168 step 9: the apply applies the newest green commit, measured from the one applied before it.
    jobName: "apply",
    command: [
      "chant", "components", "pr-apply", "--green", ...common,
      ...(options.requireReview === true ? ["--require-review"] : []),
      ...(options.waveGate ? ["--wave-gate", options.waveGate] : []),
      "--resume", PR_APPLY_RECORD,
    ].join(" "),
    env: jobEnv,
    checkout: [greenCheckout(greenBranch)],
    greenBranch,
    ...build,
    run: { command: ciRun("apply").join(" "), env: runEnv(jobEnv) },
  };
  const earlyApply: PrLoopJob = {
    // #4301: the requires checks run inside pr-apply, before any of the head's code loads.
    jobName: "apply",
    command: [
      "chant", "components", "pr-apply", "--before-merge", ...requires, "--base", '"$BASE_SHA"', "--pr", '"$PR_NUMBER"', ...common,
      ...(options.requireReview === true ? ["--require-review"] : []),
      "--resume", PR_APPLY_RECORD,
    ].join(" "),
    env: earlyEnv,
    checkout: [pullRequestCheckout(forge)],
    run: { command: ciRun("apply").join(" "), env: runEnv(earlyEnv) },
  };
  const bin = options.words?.bin;
  return [
    {
      jobName: "plan",
      // With `waveGate` the plan's note says the later waves may stop at their own gates (#4003).
      command: ["chant", "components", "pr-plan", "--base", '"$BASE_SHA"', "--pr", '"$PR_NUMBER"', ...common, ...(options.waveGate ? ["--wave-gate", options.waveGate] : []), "--no-status"].join(" "),
      env: planEnv,
      ...build,
      // #4328: no runner key either. The step drops it, but the job's environment is the pull request's code's too.
      run: { command: ciRun("plan").join(" "), env: planEnv },
    },
    early ? earlyApply : greenApply,
    {
      jobName: "record",
      command: ["chant", "components", "pr-record", "--base", '"$BASE_SHA"', ...common].join(" "),
      env: applyEnv,
      setup: [github ? githubBaseFallback(options.branch) : gitlabBaseFallback(options.branch)],
      ...build,
      run: { command: ciRun("record").join(" "), env: runEnv(applyEnv) },
    },
  ].map((job) => jobWithBin(job as PrLoopJob, bin));
}

/** The name of the job that posts the plan's note and status (#4295). */
export const PR_PLAN_NOTE_JOB = "plan-note";

/**
 * The plan-note job's command and the values it reads (#4295). On GitHub
 * and Forgejo it runs in a fresh job after the plan, at the target branch's
 * commit, and posts the note and the `chant/plan` status from the report
 * the plan job handed on, with the forge token the plan job never held.
 * `HEAD_SHA` is the commit the plan job checked out, `PR_NUMBER` the pull
 * request, and `PLAN_RESULT` the plan job's result, which fails the status
 * when the plan job failed.
 *
 * On GitLab (#4328) it runs `pr-post --open` in a pipeline of the target
 * branch, which GitLab builds from that branch's files and gives the
 * protected `CHANT_FORGE_TOKEN`. A merge request pipeline is built from the
 * merge request's files, so no job in it holds the token. `pr-post --open`
 * asks GitLab for each open merge request's plan job and reads its report
 * from the job's artifacts.
 */
export function prLoopPostJob(forge: ForgeKind, env: string, member?: string, words?: Pick<CiProductWordsInput, "bin">): { command: string; env: Record<string, string> } {
  if (forge === "gitlab") {
    return {
      command: withProductBin(["chant", "components", "pr-post", "--open", "--env", env, "--output", PR_LOOP_REPORT_DIR, "--forge", forge, ...(member ? ["--member", member] : [])].join(" "), words?.bin),
      env: {},
    };
  }
  const command = [
    "chant", "components", "pr-post", "--pr", '"$PR_NUMBER"', "--head", '"$HEAD_SHA"',
    "--env", env, "--output", PR_LOOP_REPORT_DIR, "--forge", forge,
    ...(member ? ["--member", member] : []),
    "--result", '"$PLAN_RESULT"',
  ].join(" ");
  return {
    command: withProductBin(command, words?.bin),
    env: { PR_NUMBER: "${{ github.event.pull_request.number }}", HEAD_SHA: "${{ github.sha }}", PLAN_RESULT: "${{ needs.plan.result }}", GITHUB_TOKEN: GITHUB_JOB_TOKEN },
  };
}

/** The plan job's name in a GitLab merge request pipeline (#3465, #4328): `plan`, or `<member>-plan` in a workspace member's included file. */
export function gitlabPlanJobName(member?: string): string {
  return member ? `${member}-plan` : "plan";
}

/**
 * The GitLab variable a pipeline schedule (or a person starting a pipeline
 * of the target branch) sets to `1` to post the open merge requests' plan
 * notes (#4328).
 */
export const GITLAB_PLAN_NOTES_VAR = "CHANT_PLAN_NOTES";

/**
 * What starts the apply under apply on merge (#4168 step 9): on GitHub the
 * tick's workflow finishing (`workflow_run`, since tags its token pushes start
 * no workflow), elsewhere a pushed `ci/green/*` tag. The name is
 * `CI_GREEN_WORKFLOW_NAME` (../workspace/ci-green-workflow.ts).
 */
export const GREEN_TICK_WORKFLOW = "chant-ci-green";
export const GREEN_TAG_PATTERN = "ci/green/**";

/** The job a push to the target branch runs (#4168): `record`, or `apply` when the pipeline opts into apply on merge. */
export function prLoopMergeJob(jobs: readonly PrLoopJob[], options: PrLoopPipelineOptions = {}): PrLoopJob {
  return jobs.find((j) => j.jobName === (options.applyOnMerge ? "apply" : "record"))!;
}

/**
 * The pull-request options with `--wave-gate` beside `--pr-loop` (#4003):
 * the apply gets a gate per wave. A canary or a fixed base is refused, since
 * the pull request's waves are its derivation's and each push is measured
 * from the commit before it.
 */
export function prLoopWithWaves(prLoop: PrLoopPipelineOptions, gatedWaves?: GatedWavePipelineOptions): PrLoopPipelineOptions {
  if (!gatedWaves) return prLoop;
  if (!prLoop.applyOnMerge) {
    throw new Error("--wave-gate beside --pr-loop gates the apply on merge, so it needs --apply-on-merge (#4168); without it a merge records the plan and a release deploys it");
  }
  if (gatedWaves.canary?.length) throw new Error("a pull-request pipeline's waves are the change's derivation, so it takes no --canary; drop --canary");
  if (gatedWaves.base !== undefined) throw new Error("a pull-request pipeline measures each push from the commit before it, so it takes no --base; drop --base");
  return { ...prLoop, waveGate: gatedWaves.gate };
}

/** The name of the apply job for wave `wave` (#4003). */
export function prApplyWaveJobName(wave: number): string {
  return `apply-wave-${wave}`;
}

/**
 * One apply job per wave of the component graph (#4003), each `apply`'s
 * command with `--wave <k>`. A change selects a subset, which never layers
 * deeper than the graph, so a job past the change's last wave finds nothing
 * left and exits 0.
 */
export function prLoopWaveJobs(components: DriverComponent[], apply: PrLoopJob): PrLoopJob[] {
  const count = Math.max(1, layerWaves(components.map((c) => ({ name: c.name, dependsOn: c.dependsOn ?? [] }))).length);
  return Array.from({ length: count }, (_, i) => ({
    ...apply,
    command: `${apply.command} --wave ${i + 1}`,
    wave: i + 1,
    // #4221: every wave after the first applies the commit wave 1 took.
    ...(i > 0 && apply.greenBranch !== undefined ? { checkout: [pinnedGreenCheckout(apply.greenBranch)] } : {}),
    // #4156: the job runs it through chant ci run, which appends the same --wave to pr-apply.
    run: { ...apply.run, command: `${apply.run.command} --wave ${i + 1}` },
  }));
}

/**
 * The concurrency group (GitHub, Forgejo) or resource group (GitLab) that
 * keeps one apply at a time per environment, and per member in a workspace.
 *
 * A member's group is `chant-apply.<member>.<env>`. Member names hold only
 * lower-case letters, digits and `-`, so the first `.` ends the member and no
 * two member and environment pairs share a group: member `a` with environment
 * `b-c` is `chant-apply.a.b-c`, and member `a-b` with environment `c` is
 * `chant-apply.a-b.c`. The `.` after `chant-apply` keeps a member's groups
 * apart from a single project's `chant-apply-<env>`.
 */
export function prApplyGroup(env: string, member?: string): string {
  return member ? `chant-apply.${member}.${env}` : `chant-apply-${env}`;
}

/** The group that keeps one record job at a time per environment and member (#4168), named as {@link prApplyGroup} names the apply's. */
export function prRecordGroup(env: string, member?: string): string {
  return member ? `chant-record.${member}.${env}` : `chant-record-${env}`;
}

/**
 * The cache key the apply job keeps its attempt record under (#3543), with
 * `commit` the forge's expression for the pushed commit. A push of another
 * commit never restores a record, and the environment and member keep each
 * pipeline's record apart. The pull request and the gate digest are not in
 * the key, since neither is known before the job runs; `pr-apply --resume`
 * refuses a record made for another pull request, gate or digest.
 */
export function prApplyRecordKey(env: string, commit: string, member?: string): string {
  return `${prApplyGroup(env, member)}-${commit}`;
}

/**
 * The shell that settles an unusable push base. `before` is empty or forty
 * zeros on a branch's first push; then the base is `diffBase` when the forge
 * gives one, else the merge base of `target` and `commit`, else `commit`'s
 * parent when the merge base is `commit` itself, else, for a root commit, the
 * empty tree.
 */
function pushBaseFallback(target: string, commit: string, diffBase?: string): string {
  const fromBranch =
    `git fetch origin ${target} && BASE_SHA="$(git merge-base FETCH_HEAD "${commit}")"; ` +
    `if [ "$BASE_SHA" = "${commit}" ]; then BASE_SHA="$(git rev-parse --verify --quiet "${commit}^" || echo ${EMPTY_TREE_SHA})"; fi; `;
  return (
    'if [ -z "$BASE_SHA" ] || [ "$BASE_SHA" = "0000000000000000000000000000000000000000" ]; then ' +
    (diffBase ? `BASE_SHA="\${${diffBase}:-}"; if [ -z "$BASE_SHA" ]; then ${fromBranch}fi; ` : fromBranch) +
    "fi; export BASE_SHA"
  );
}

/** The GitLab variable a person sets on a pipeline of the target branch to apply a merge request before it merges (#4301). */
export const GITLAB_APPLY_PR_VAR = "CHANT_APPLY_PR";

/** The comment that starts the apply before merge on GitHub and Forgejo (#4301). */
export const APPLY_COMMENT = "/chant apply";

/** The comment that starts the apply before merge under the pipeline's words (#4550): `/plywood up`, else {@link APPLY_COMMENT}. */
export function prApplyComment(options: Pick<PrLoopPipelineOptions, "words"> = {}): string {
  return commentLine(resolveProductWords(options.words), "apply") ?? APPLY_COMMENT;
}

/** `chant` at the start of a command, or after a shell `$(`, `(`, `&&` or space. */
const CHANT_WORD = /(^|[\s"(]|\$\()chant (?=[a-z])/g;

/**
 * A command line with the product's bin in place of `chant` (#4550): `npx
 * --no-install plywood components pr-plan ...`. A `chant ci run` line also
 * passes `--chant <bin>`, so the command it runs goes through the bin too.
 */
export function withProductBin(line: string, bin: string | undefined): string {
  if (!bin) return line;
  const swapped = line.replace(CHANT_WORD, (_m, before: string) => `${before}${bin} `);
  return swapped.replace(new RegExp(`^${bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ci run ([a-z-]+) `), (m) => `${m}--chant ${JSON.stringify(bin)} `);
}

/** Every command of `job` through {@link withProductBin}. */
function jobWithBin<T extends Pick<PrLoopJob, "command" | "run"> & Partial<Pick<PrLoopJob, "build" | "checkout" | "setup">>>(job: T, bin: string | undefined): T {
  if (!bin) return job;
  return {
    ...job,
    command: withProductBin(job.command, bin),
    run: { ...job.run, command: withProductBin(job.run.command, bin) },
    ...(job.build ? { build: job.build.map((l) => withProductBin(l, bin)) } : {}),
    ...(job.checkout ? { checkout: job.checkout.map((l) => withProductBin(l, bin)) } : {}),
  };
}

/**
 * The line that checks out pull request `$PR_NUMBER`'s head (#4301) in a job
 * of the target branch: the forge's `refs/pull/<n>/head`, or GitLab's
 * `refs/merge-requests/<n>/head`. A number that is not one fails the job.
 */
export function pullRequestCheckout(forge: ForgeKind): string {
  const ref = forge === "gitlab" ? 'refs/merge-requests/$PR_NUMBER/head' : 'refs/pull/$PR_NUMBER/head';
  return `echo "$PR_NUMBER" | grep -Eq '^[0-9]+$' && git fetch --quiet origin "+${ref}:refs/remotes/origin/chant-apply/$PR_NUMBER" && git checkout --quiet --detach "refs/remotes/origin/chant-apply/$PR_NUMBER"`;
}

/**
 * The line that checks out the newest green commit of `branch` (#4168 step
 * 9), after fetching the branch and its tags, for the apply job. `chant ci
 * last-green` exits 1 when no commit is green, which fails the job.
 */
export function greenCheckout(branch: string): string {
  return `${fetchBranch(branch)} && GREEN_SHA="$(chant ci last-green)" && git checkout --quiet --detach "$GREEN_SHA"`;
}

/**
 * The line a wave after the first runs in place of {@link greenCheckout}
 * (#4221): it checks out `GREEN_SHA`, the commit wave 1 took, so a commit
 * that goes green while the waves run waits for a run of its own. An empty
 * `GREEN_SHA` fails the job.
 */
export function pinnedGreenCheckout(branch: string): string {
  return `test -n "$GREEN_SHA" && ${fetchBranch(branch)} && git checkout --quiet --detach "$GREEN_SHA"`;
}

function fetchBranch(branch: string): string {
  const name = branch.replace(/^"|"$/g, "");
  return `git fetch --quiet --tags origin "+refs/heads/${name}:refs/remotes/origin/${name}"`;
}

/**
 * GitLab sets `CI_COMMIT_BEFORE_SHA` to forty zeros on a branch's first push.
 * The line replaces it with the merge request's diff base when the pipeline
 * has one, and otherwise as {@link pushBaseFallback} does.
 */
export function gitlabBaseFallback(branch?: string): string {
  return pushBaseFallback(branch ? JSON.stringify(branch) : "$CI_DEFAULT_BRANCH", "$CI_COMMIT_SHA", "CI_MERGE_REQUEST_DIFF_BASE_SHA");
}

/**
 * GitHub and Forgejo set `github.event.before` to forty zeros on a branch's
 * first push (#4004). The line replaces it as {@link pushBaseFallback} does,
 * with the target branch `main` unless the pipeline names another, the
 * generators' default.
 */
export function githubBaseFallback(branch?: string): string {
  return pushBaseFallback(JSON.stringify(branch ?? "main"), "$GITHUB_SHA");
}

/** Where the pull request environment jobs (#4298) write their reports, kept as a CI artifact. */
export const PR_ENV_REPORT_DIR = ".chant/pr-env";

/** The cron the generated `env-sweep` job runs on (#4298): hourly, at a minute off the hour. */
export const PR_ENV_SWEEP_CRON = "17 * * * *";

/** One job of a pull request's environment (#4298): its command and the forge values it reads. */
export interface PrEnvJob {
  jobName: "env-up" | "env-post" | "env-down" | "env-sweep";
  /** The command line. `env-up` reads `$BASE_SHA` and `$PR_NUMBER`, `env-down` `$PR_NUMBER`. */
  command: string;
  /** Values the command reads, as the forge spells them. `CHANT_ENV` is the pull request's environment. */
  env: Record<string, string>;
  /** With `build`: the build and lint lines, run before the command. */
  build?: string[];
}

/** The name of the job that keeps an environment's record and posts its note (#4298, #4295). */
export const PR_ENV_POST_JOB = "env-post";

/**
 * The jobs of a pull request's environment (#4298), when `prEnvironment` is
 * on, in this order:
 *
 * - `env-up` runs `chant components pr-env up --no-push`. It runs the
 *   change's code, so it gets no forge token (#4295): it passes no
 *   `--forge`, and it hands its report and its record on.
 * - `env-post` runs `pr-env post` in a fresh job at the target branch's
 *   commit, with the token: it keeps the record on chant/lifecycle and posts
 *   the note and the `chant/pr-env` status. On GitHub and Forgejo it reads
 *   the up job's result as `UP_RESULT`.
 * - `env-down` runs `pr-env down --reason closed`, and `env-sweep` runs
 *   `pr-env sweep`. Neither builds the change's code: a teardown reads the
 *   markers off the live resources.
 *
 * Each writes its report under {@link PR_ENV_REPORT_DIR}.
 */
export function prEnvJobs(forge: ForgeKind, options: PrLoopPipelineOptions = {}, member?: string): PrEnvJob[] {
  const github = forge !== "gitlab";
  const out = ["--output", PR_ENV_REPORT_DIR, ...(member ? ["--member", member] : [])];
  const common = ["--forge", forge, ...out];
  const token: Record<string, string> = github ? { GITHUB_TOKEN: GITHUB_JOB_TOKEN } : {};
  const prNumber = github ? "${{ github.event.pull_request.number }}" : "$CI_MERGE_REQUEST_IID";
  const prEnv = { CHANT_ENV: `pr-${prNumber}` };
  const buildLines = prLoopBuildLines('"$CHANT_ENV"', options);
  return [
    {
      jobName: "env-up",
      // #4295: no --forge and no token; the record stays in the report directory for env-post.
      command: ["chant", "components", "pr-env", "up", "--base", '"$BASE_SHA"', "--pr", '"$PR_NUMBER"', ...out, "--no-push"].join(" "),
      env: { BASE_SHA: github ? "${{ github.event.pull_request.base.sha }}" : "$CI_MERGE_REQUEST_DIFF_BASE_SHA", PR_NUMBER: prNumber, ...prEnv },
      ...(buildLines.length > 0 ? { build: buildLines } : {}),
    },
    {
      jobName: PR_ENV_POST_JOB,
      command: ["chant", "components", "pr-env", "post", "--pr", '"$PR_NUMBER"', "--head", '"$HEAD_SHA"', ...common, ...(github ? ["--result", '"$UP_RESULT"'] : [])].join(" "),
      env: github
        ? { PR_NUMBER: prNumber, HEAD_SHA: "${{ github.sha }}", UP_RESULT: "${{ needs.env-up.result }}", ...token }
        : { PR_NUMBER: prNumber, HEAD_SHA: "$CI_COMMIT_SHA", BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA" },
    },
    {
      jobName: "env-down",
      command: ["chant", "components", "pr-env", "down", "--pr", '"$PR_NUMBER"', "--reason", "closed", ...common].join(" "),
      env: { PR_NUMBER: prNumber, ...prEnv, ...token },
    },
    {
      jobName: "env-sweep",
      command: ["chant", "components", "pr-env", "sweep", ...common].join(" "),
      env: { ...token },
    },
  ];
}
