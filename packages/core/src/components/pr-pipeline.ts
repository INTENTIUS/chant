/**
 * The jobs of a generated pull-request pipeline (#3183): a plan job on every
 * pull request and an apply job on every push to the target branch.
 *
 * Each forge's generator (the github, gitlab and forgejo lexicons) adds its
 * own triggers, permissions and artifact handling; the commands and the
 * values they read from the forge live here so the three cannot disagree.
 *
 * - The plan job runs `chant components pr-plan` against the pull request's
 *   target commit. It posts the note and the `chant/plan` status and writes
 *   nothing to `chant/lifecycle`, since it runs the pull request's code.
 * - The apply job runs `chant components pr-apply` against the commit the
 *   push replaced, finds the pull request that merged the pushed commit
 *   through the forge, and applies only when an approval stands for the
 *   digest it plans. With `requireReview` (the default) the approver must
 *   also have approved the pull request on the forge. It needs write access
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
 *
 * In a workspace member (#3465) both commands run in the member's directory
 * and pass `--member <name>`, so the member's gate (`pr-<number>-<member>`),
 * note and statuses stay apart from every other member's on the same pull
 * request. They still measure the whole change: a file outside the member
 * that one of its units reaches selects that unit.
 */

import type { ForgeKind } from "../pr-forge";
import { PR_APPLY_GATE } from "../pr-loop";
import { CI_IMAGE, GITHUB_JOB_TOKEN } from "../ci-jobs";
import { EMPTY_TREE_SHA } from "./changed-files";
import { layerWaves } from "../gated-waves";
import type { DriverComponent } from "./driver";
import type { GatedWavePipelineOptions } from "./gated-wave-pipeline";

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

/** The setup lines for a pipeline running in `image`: the install when it is the default image, none otherwise. */
export function prLoopSetup(image: string): string[] {
  return image === PR_LOOP_IMAGE ? PR_LOOP_SETUP : [];
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
  /** Count an approval only from someone who approved the pull request on the forge. Default true. */
  requireReview?: boolean;
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
   * Which GitHub-shaped forge the workflow is for. Set by the forgejo
   * generator, which reuses the github one; a caller never needs to.
   */
  forge?: "github" | "forgejo";
}

/** One job's command and the forge values it reads, as environment variables for its step. */
export interface PrLoopJob {
  /** `plan` or `apply`. */
  jobName: "plan" | "apply";
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
  /** With `build` (#4088): the build line and the lint line, run in this order before the command. */
  build?: string[];
  /** With `waveGate` (#4003): the wave a generated apply job runs, 1-based. */
  wave?: number;
  /**
   * What the generated job runs in place of `command` (#4156): `chant ci run
   * <job> --in-place` with the same environment, gate, forge, events and
   * report URL, which runs `command` and records the run. `env` is the
   * job's `env` and, on GitHub and Forgejo, `CHANT_RUNNER_KEY` from the
   * repository secret of that name. GitLab hands its CI/CD variables to a
   * job itself.
   */
  run: { command: string; env: Record<string, string> };
}

/** The lines `build` (#4088) runs before a job's command: the build, then the lint. Empty without the option. */
export function prLoopBuildLines(env: string, options: PrLoopPipelineOptions = {}): string[] {
  if (!options.build && !options.buildCommand) return [];
  return [options.buildCommand ?? `chant build --env ${env}`, "chant lint"];
}

/**
 * The two jobs for `forge`. `member` is the workspace member the pipeline is
 * generated for; the commands then run in its directory, so `--output` is
 * relative to it.
 */
export function prLoopJobs(forge: ForgeKind, env: string, options: PrLoopPipelineOptions = {}, member?: string): PrLoopJob[] {
  const gate = options.gate ?? PR_APPLY_GATE;
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
  const ciRun = (job: "plan" | "apply"): string[] => [
    "chant", "ci", "run", job, "--in-place", ...(job === "plan" ? ["--no-push"] : []),
    "--base", '"$BASE_SHA"', ...(job === "plan" ? ["--pr", '"$PR_NUMBER"'] : []),
    "--env", env, "--gate", gate, "--forge", forge,
    ...(options.waveGate ? ["--wave-gate", options.waveGate] : []),
    ...(job === "apply" && options.branch ? ["--branch", JSON.stringify(options.branch)] : []),
    ...(job === "apply" && options.requireReview === false ? ["--no-require-review"] : []),
    ...(options.events ? ["--events-json"] : []),
    ...(options.reportUrl ? ["--report-url", JSON.stringify(options.reportUrl)] : []),
  ];
  const runEnv = (env: Record<string, string>): Record<string, string> => (github ? { ...env, [RUNNER_KEY_ENV]: `\${{ secrets.${RUNNER_KEY_ENV} }}` } : env);
  const planEnv = github
    ? { BASE_SHA: "${{ github.event.pull_request.base.sha }}", PR_NUMBER: "${{ github.event.pull_request.number }}", ...jobEnv }
    : { BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA", PR_NUMBER: "$CI_MERGE_REQUEST_IID", ...jobEnv };
  const applyEnv = github ? { BASE_SHA: "${{ github.event.before }}", ...jobEnv } : { BASE_SHA: "$CI_COMMIT_BEFORE_SHA", ...jobEnv };
  return [
    {
      jobName: "plan",
      // With `waveGate` the plan's note says the later waves may stop at their own gates (#4003).
      command: ["chant", "components", "pr-plan", "--base", '"$BASE_SHA"', "--pr", '"$PR_NUMBER"', ...common, ...(options.waveGate ? ["--wave-gate", options.waveGate] : [])].join(" "),
      env: planEnv,
      ...build,
      run: { command: ciRun("plan").join(" "), env: runEnv(planEnv) },
    },
    {
      jobName: "apply",
      command: [
        "chant", "components", "pr-apply", "--base", '"$BASE_SHA"', ...common,
        ...(options.requireReview === false ? [] : ["--require-review"]),
        ...(options.waveGate ? ["--wave-gate", options.waveGate] : []),
        "--resume", PR_APPLY_RECORD,
      ].join(" "),
      env: applyEnv,
      setup: [github ? githubBaseFallback(options.branch) : gitlabBaseFallback(options.branch)],
      ...build,
      run: { command: ciRun("apply").join(" "), env: runEnv(applyEnv) },
    },
  ];
}

/**
 * The pull-request options with `--wave-gate` beside `--pr-loop` (#4003):
 * the apply gets a gate per wave. A canary or a fixed base is refused, since
 * the pull request's waves are its derivation's and each push is measured
 * from the commit before it.
 */
export function prLoopWithWaves(prLoop: PrLoopPipelineOptions, gatedWaves?: GatedWavePipelineOptions): PrLoopPipelineOptions {
  if (!gatedWaves) return prLoop;
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
