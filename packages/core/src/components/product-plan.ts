/**
 * The product plan (#4799): the pull request plan jobs of a product whose
 * plan step runs its own plan verb, in place of `chant components pr-plan`.
 *
 * #4550 ruling A put the plan side of a product's pipeline on the pull
 * request loop. The 2026-11-09 amendment (#4799) reads it as "pr-plan or the
 * product's plan verb": sql-yodeler plans an environment with `yodel plan`
 * and terragucci its roots with `terragucci plan`, and neither has a
 * component graph for `pr-plan` to plan. Each keeps its plan verb, and chant
 * writes the jobs around it, as it does for `pr-plan`:
 *
 * - the plan job checks the change out with the token given to its fetches
 *   alone, starts every later step without the forge tokens (#4295), and
 *   runs the plan verb last, which writes a `PrReport` (`pr-plan.json`) or
 *   a product's plan note hand-off (`pr-plan-note.json`, ../pr-plan-note.ts)
 *   into {@link PR_LOOP_REPORT_DIR}. The job hands the directory on.
 * - the plan-note job checks out the target branch's commit, takes the
 *   directory back, keeps it as the run's artifact, and posts the note and
 *   the plan status with `chant components pr-post` (../pr-post.ts), which
 *   renders either file. On GitLab it is the target-branch job `pr-post
 *   --open`, as for `pr-plan` (#4328).
 *
 * With `targets`, one plan job and one plan-note job per target (an
 * environment, for sql-yodeler) in the one workflow, each with only that
 * target's own variables and secrets, and an optional write probe before the
 * plan. A target is the note's and the status's member: `pr-post --member
 * <target>`, so each target has its note and its `<product>/plan/<target>`.
 *
 * The forge lexicons render these descriptors
 * (`generateProductPlanPipeline` in each): the products call them in
 * process, with no component graph.
 */

import type { ForgeKind } from "../pr-forge";
import type { CiRunner } from "../ci-jobs";
import type { CiProductWords } from "../ci-product-words";
import type { PrPlanNoteWords } from "../pr-plan-note";
import { gitlabPlanJobName, PR_LOOP_REPORT_DIR, PR_PLAN_NOTE_JOB, prLoopPassedEnv, prLoopPostJob, prLoopRunner, type PrLoopPipelineOptions } from "./pr-pipeline";

/** The variable the plan-note job reads the product's note words from (#4799), as JSON. Set from the pipeline, never from the report. */
export const PR_PLAN_NOTE_WORDS_ENV = "CHANT_PLAN_NOTE_WORDS";

/** One target the product plans in a job of its own (#4799): an environment, for sql-yodeler. */
export interface ProductPlanTarget {
  /** The target's name: `{target}` in the command, the job names, and the note's member. Letters, digits, `-` and `_`. */
  name: string;
  /** Variables for this target's plan job alone, as the forge reads them. A forge token's name is refused. */
  variables?: Record<string, string>;
  /** Secrets for this target's plan job alone, as `{ <variable>: <secret> }`, mapped as the pull request loop's `secrets` are. */
  secrets?: Record<string, string>;
  /**
   * A shell line run before the plan that fails the job when the target's
   * credentials can write, such as sql-yodeler's `yodel config check <env>
   * --write-probe`. It runs with the target's variables, after the forge
   * tokens are dropped.
   */
  writeProbe?: string;
}

/** The product plan (#4799): {@link ProductPipelineOptions.plan}. */
export interface ProductPlanOptions {
  /**
   * The product's plan verb, as one shell line: `{target}` is the target's
   * name and `{output}` the directory the plan-note job takes back
   * ({@link PR_LOOP_REPORT_DIR}). It reads `$BASE_SHA` and `$PR_NUMBER`, and
   * writes `pr-plan.json` or `pr-plan-note.json` there. It runs as given,
   * not through the words' `bin`: it is the product's command, not chant's.
   */
  command: string;
  /** One plan job per target. Absent: one plan job, named as the pull request loop's. */
  targets?: ProductPlanTarget[];
  /**
   * `skip`: a pull request from a fork runs no plan and no note job (on
   * GitHub and Forgejo it carries no token and no OIDC; on GitLab, a fork's
   * merge request pipeline runs in the fork). The product's check job,
   * which holds no credentials, still runs for it. Default: every pull
   * request plans.
   */
  forks?: "skip";
  /** The artifact the plan-note job keeps the directory as. Default `chant-pr-plan`, or `chant-pr-plan-<target>`. */
  artifact?: string;
  /** The words a plan note hand-off renders with (`renderPlanNote`'s `note`), passed to the note job as {@link PR_PLAN_NOTE_WORDS_ENV}. */
  noteWords?: PrPlanNoteWords;
  /** The workflow's name (GitHub and Forgejo) or the pipeline's (GitLab). Default `chant-pr-<env>`. */
  workflow?: string;
}

/** One plan job and its note job, for one target or for the whole pipeline (#4799). */
export interface ProductPlanJob {
  /** The target, when the plan has targets. Also the note's and the status's member. */
  target?: string;
  /** The plan job: `plan` or `plan-<target>` on GitHub and Forgejo, `plan` or `<target>-plan` on GitLab, where `pr-post --open` finds it by that name. */
  jobName: string;
  /** The note job: `plan-note` or `plan-note-<target>`, `<target>-plan-note` on GitLab. */
  noteJobName: string;
  /** The plan verb's line, `{target}` and `{output}` filled. */
  command: string;
  /** The plan step's variables: `BASE_SHA`, `PR_NUMBER`, the pipeline's passed variables and secrets, then the target's. No forge token. */
  env: Record<string, string>;
  /** The target's write probe. */
  writeProbe?: string;
  /** The note job's command and variables. */
  post: { command: string; env: Record<string, string> };
  /** The artifact the note job (GitHub, Forgejo) or the plan job (GitLab) keeps the directory as. */
  artifact: string;
  /** Where the plan job runs: the loop's `plan` runner. */
  runner?: CiRunner;
  /** Where the note job runs: the loop's `default` runner. */
  noteRunner?: CiRunner;
}

const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The pull request loop's options the product plan's jobs do not carry, and what each needs. Each is refused with `plan` (#4799). */
const NOT_WITH_PLAN: ReadonlyArray<[keyof PrLoopPipelineOptions, string]> = [
  ["applyBeforeMerge", "the apply before merge runs pr-apply on pr-plan's report"],
  ["applyOnMerge", "the apply on merge runs on op waves, from the waves spec"],
  ["waveGate", "the apply on merge runs on op waves, from the waves spec"],
  ["locks", "the lock job reads pr-plan's report"],
  ["previewComment", "the comment preview re-runs pr-plan"],
  ["staleNotes", "the stale marking names one note per pipeline"],
  ["identity", "a target's cloud login is the product's, through its variables"],
  ["build", "the plan verb builds what it plans"],
  ["buildCommand", "the plan verb builds what it plans"],
  ["refresh", "--refresh is a pr-plan flag"],
  ["parallelism", "--parallelism is a pr-plan flag"],
  ["commentTargets", "--comment-targets is a pr-plan flag"],
  ["events", "--events-json is a pr-plan flag"],
  ["reportUrl", "--report-url is a pr-plan flag"],
  ["prEnvironment", "the pull request environment jobs run pr-env"],
  ["noteCommands", "the note-commands job starts pr-plan's comment jobs"],
  ["actionJob", "the action job is in chant build --pr-loop's workflow"],
  ["control", "the control read is the pr-plan report's cross-stack edges"],
  ["decide", "the description check reads pr-plan's report"],
];

/**
 * The product plan's jobs for `forge` (#4799). `words` are the pipeline's,
 * already checked. Throws on a target name that is not one, a name given
 * twice, a target variable that is a forge token, and a pull request loop
 * option the product plan does not carry.
 */
export function productPlanJobs(forge: ForgeKind, env: string, loop: PrLoopPipelineOptions & { plan: ProductPlanOptions }, words: CiProductWords): ProductPlanJob[] {
  const plan = loop.plan;
  for (const [key, why] of NOT_WITH_PLAN) {
    const value = loop[key];
    if (value !== undefined && value !== false) throw new Error(`the product plan (plan) takes no ${key}: ${why}`);
  }
  if (!plan.command.trim()) throw new Error("the product plan's command is empty; give the product's plan verb");
  const targets = plan.targets;
  if (targets !== undefined && targets.length === 0) throw new Error("the product plan's targets are empty; leave targets out for one plan job");
  const seen = new Set<string>();
  for (const t of targets ?? []) {
    if (!TARGET_NAME.test(t.name)) throw new Error(`the product plan's target ${JSON.stringify(t.name)} is not a name of letters, digits, - and _`);
    if (seen.has(t.name)) throw new Error(`the product plan names target ${t.name} twice`);
    seen.add(t.name);
  }
  const github = forge !== "gitlab";
  const shared = prLoopPassedEnv(forge, loop);
  const planRunner = prLoopRunner(loop, "plan");
  const noteRunner = prLoopRunner(loop, "default");
  const base = github
    ? { BASE_SHA: "${{ github.event.pull_request.base.sha }}", PR_NUMBER: "${{ github.event.pull_request.number }}" }
    : { BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA", PR_NUMBER: "$CI_MERGE_REQUEST_IID" };
  const noteWords: Record<string, string> = plan.noteWords ? { [PR_PLAN_NOTE_WORDS_ENV]: JSON.stringify(plan.noteWords) } : {};
  const one = (target?: ProductPlanTarget): ProductPlanJob => {
    const name = target?.name;
    const jobName = github ? (name ? `plan-${name}` : "plan") : gitlabPlanJobName(name);
    const noteJobName = github ? (name ? `${PR_PLAN_NOTE_JOB}-${name}` : PR_PLAN_NOTE_JOB) : name ? `${name}-${PR_PLAN_NOTE_JOB}` : PR_PLAN_NOTE_JOB;
    const own = target ? prLoopPassedEnv(forge, { ...(target.variables ? { variables: target.variables } : {}), ...(target.secrets ? { secrets: target.secrets } : {}) }) : {};
    for (const key of Object.keys(own)) {
      if (key in shared) throw new Error(`target ${name}'s ${key} is the pipeline's too; give it on the target or on the pipeline`);
    }
    const post = prLoopPostJob(forge, env, name, words);
    // The note job reads its own plan job's result, by that job's name.
    const postEnv: Record<string, string> = github ? { ...post.env, PLAN_RESULT: `\${{ needs.${jobName}.result }}`, ...noteWords } : { ...post.env, ...noteWords };
    return {
      ...(name ? { target: name } : {}),
      jobName,
      noteJobName,
      command: plan.command.replaceAll("{target}", name ?? env).replaceAll("{output}", PR_LOOP_REPORT_DIR),
      env: { ...base, ...shared, ...own },
      ...(target?.writeProbe ? { writeProbe: target.writeProbe } : {}),
      post: { command: post.command, env: postEnv },
      artifact: plan.artifact ? (name ? `${plan.artifact}-${name}` : plan.artifact) : name ? `chant-pr-plan-${name}` : "chant-pr-plan",
      ...(planRunner !== undefined ? { runner: planRunner } : {}),
      ...(noteRunner !== undefined ? { noteRunner } : {}),
    };
  };
  return targets ? targets.map(one) : [one()];
}

/** The GitHub and Forgejo condition that a pull request is from this repository, not a fork (#4799). */
export const SAME_REPOSITORY_IF = "github.event.pull_request.head.repo.full_name == github.repository";

/** The GitLab rule condition that a merge request's source project is the project itself (#4799). */
export const GITLAB_SAME_PROJECT_IF = "$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_MERGE_REQUEST_PROJECT_ID";
