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
 * In a workspace member (#3465) both commands run in the member's directory
 * and pass `--member <name>`, so the member's gate (`pr-<number>-<member>`),
 * note and statuses stay apart from every other member's on the same pull
 * request. They still measure the whole change: a file outside the member
 * that one of its units reaches selects that unit.
 */

import type { ForgeKind } from "../pr-forge";
import { PR_APPLY_GATE } from "../pr-loop";

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
export const PR_LOOP_IMAGE = "node:22";

/** Installs OpenTofu into `PR_LOOP_IMAGE`. */
export const PR_LOOP_SETUP = [
  "command -v tofu >/dev/null 2>&1 || (curl -fsSL https://get.opentofu.org/install-opentofu.sh -o /tmp/install-opentofu.sh && sh /tmp/install-opentofu.sh --install-method standalone)",
];

/** The setup lines for a pipeline running in `image`: the install when it is the default image, none otherwise. */
export function prLoopSetup(image: string): string[] {
  return image === PR_LOOP_IMAGE ? PR_LOOP_SETUP : [];
}

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
  ];
  const github = forge !== "gitlab";
  const token: Record<string, string> = github ? { GITHUB_TOKEN: "${{ github.token }}" } : {};
  return [
    {
      jobName: "plan",
      command: ["chant", "components", "pr-plan", "--base", '"$BASE_SHA"', "--pr", '"$PR_NUMBER"', ...common].join(" "),
      env: github
        ? { BASE_SHA: "${{ github.event.pull_request.base.sha }}", PR_NUMBER: "${{ github.event.pull_request.number }}", ...token }
        : { BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA", PR_NUMBER: "$CI_MERGE_REQUEST_IID" },
    },
    {
      jobName: "apply",
      command: [
        "chant", "components", "pr-apply", "--base", '"$BASE_SHA"', ...common,
        ...(options.requireReview === false ? [] : ["--require-review"]),
        "--resume", PR_APPLY_RECORD,
      ].join(" "),
      env: github ? { BASE_SHA: "${{ github.event.before }}", ...token } : { BASE_SHA: "$CI_COMMIT_BEFORE_SHA" },
      ...(github ? {} : { setup: [gitlabBaseFallback(options.branch)] }),
    },
  ];
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
 * GitLab sets `CI_COMMIT_BEFORE_SHA` to forty zeros on a branch's first push.
 * The line replaces it with the merge request's diff base when the pipeline
 * has one, and otherwise with the merge base of the target branch and the
 * pushed commit, or the pushed commit's parent when that is the commit itself.
 */
export function gitlabBaseFallback(branch?: string): string {
  const target = branch ? JSON.stringify(branch) : "$CI_DEFAULT_BRANCH";
  return (
    'if [ -z "$BASE_SHA" ] || [ "$BASE_SHA" = "0000000000000000000000000000000000000000" ]; then ' +
    'BASE_SHA="${CI_MERGE_REQUEST_DIFF_BASE_SHA:-}"; ' +
    'if [ -z "$BASE_SHA" ]; then ' +
    `git fetch origin ${target} && BASE_SHA="$(git merge-base FETCH_HEAD "$CI_COMMIT_SHA")"; ` +
    'if [ "$BASE_SHA" = "$CI_COMMIT_SHA" ]; then BASE_SHA="$(git rev-parse "$CI_COMMIT_SHA^")"; fi; ' +
    "fi; fi; export BASE_SHA"
  );
}
