/**
 * The product plan pipeline on GitLab CI (#4799): the merge request plan
 * jobs of a product whose plan step runs its own plan verb, written from
 * `ProductPipelineOptions` with no component graph. A product calls it in
 * process and writes the YAML, or adds its own jobs to the entries first.
 *
 * Each plan job (`plan`, or `<target>-plan`) runs in the merge request's
 * pipeline, drops the forge tokens before any of the change's code runs
 * (#4295), runs the target's write probe and the plan verb with the
 * target's variables, and keeps `.chant/pr` as its artifact. GitLab hands
 * every job the project's CI/CD variables, so a target's credentials stay
 * apart only by the variables' protection and environment scope, as the
 * pull request loop's do.
 *
 * The note job (`plan-note`, or `<target>-plan-note`) runs in a pipeline of
 * the target branch started with `CHANT_PLAN_NOTES=1` (#4328): `pr-post
 * --open --member <target>` asks GitLab for each open merge request's
 * `<target>-plan` job and posts the note and status from its artifact,
 * a `PrReport` or a product's plan note hand-off.
 *
 * With `forks: "skip"` the plan jobs run only for a merge request from the
 * project itself.
 *
 * With `evidence` (#4870) each plan job has `<plan job>-evidence`, which
 * signs its `plan` and `policy` checks with the runner key in the named
 * CI/CD variable, and pushes them to `refs/notes/chant/evidence`, where the
 * ref gate (#4867) reads them. It runs in the plan notes pipeline, before
 * the note jobs (#4914), for every open merge request's settled plan job,
 * from its artifact: a merge request pipeline is built from the change's
 * own files, so none of its jobs may hold the key. The job names the
 * `chant-evidence` environment, which the key's variable is scoped to, and
 * the note job ends each note with the checks it signed.
 *
 * With `replan` (#4899) the note-commands job (`noteCommands`) starts a
 * pipeline of the target branch for a plan comment, with the comment
 * preview's variables, and the re-plan jobs (`replan`, or
 * `<target>-replan`) whose target the comment names run in it: each drops
 * the forge tokens, checks out the merge request's head, and plans; the
 * job after it posts the note.
 *
 * With `productPlan.trade` (#4963) the plan and re-plan jobs' scripts
 * trade the job's OIDC token first, before the re-plan checks out the
 * head; with `replan: { notAffected }` the re-plan's note job reads the
 * comment's argument again and passes it to `pr-post --not-affected`.
 *
 * With `locks: "plan"` and `productPlan.reach` (#4979) the `lock` job runs
 * in the plan notes pipeline, at the target branch's commit: `chant lock
 * --reach --open` locks what each open merge request from the project
 * reaches, by the product's reach line, and releases the locks of one that
 * is no longer open. With `noteCommands`, `/<product> lock` and
 * `/<product> unlock` start a pipeline of the target branch whose
 * `comment-lock` or `comment-unlock` job keeps or releases them.
 */

import { assertGitlabBranch, CI_IMAGE, GITLAB_FULL_HISTORY, GITLAB_MERGE_REQUEST_SOURCE, gitlabTags } from "@intentius/chant/ci-jobs";
import { GITLAB_DROP_FORGE_TOKENS } from "@intentius/chant/ci-handover";
import { gitlabTradeLines, TRADE_SPEC_ENV } from "@intentius/chant/ci-identity";
import { GITLAB_NOTE_COMMANDS_VAR, GITLAB_PLAN_NOTES_VAR, PR_LOOP_REPORT_DIR, PR_NOTE_COMMANDS_JOB, PR_PLAN_NOTE_JOB, prLoopSetup, pullRequestCheckout } from "@intentius/chant/components/pr-pipeline";
import { productPipelineJobs, type ProductPipelineJobs, type ProductPipelineOptions } from "@intentius/chant/components/product-pipeline";
import {
  GITLAB_REPLAN_COMMENT_VAR,
  GITLAB_REPLAN_PR_VAR,
  GITLAB_SAME_PROJECT_IF,
  gitlabReplanArgumentLines,
  gitlabReplanCommentIf,
  planVerbLines,
  REPLAN_JOB,
  REPLAN_NOTE_JOB,
  type ProductPlanJob,
  type ProductPlanOptions,
} from "@intentius/chant/components/product-plan";
import { emitGitlabFile } from "./ci-jobs";
import { gitlabCheckJobs, gitlabOpenEvidenceJob, withCheckStages } from "./pr-check-jobs";

/** What {@link generateGitlabProductPlanPipeline} takes: the product pipeline's options with `productPlan`, and how the jobs are set up. */
export interface GitlabProductPlanPipelineOptions extends ProductPipelineOptions {
  productPlan: ProductPlanOptions;
  /** The image every job runs in. Default chant's CI image, which gets the engine setup lines. */
  image?: string;
  /** Lines after the setup in every job, such as the product's install. */
  beforeScript?: string[];
  /** Lines after the plan verb. */
  extraScript?: string[];
  /** Comment lines above the document, `#` included. */
  header?: string[];
  /** The plan jobs' `cache:` (#4899): GitLab's own for what a GitHub plan job restores with a `uses` setup step. */
  cache?: unknown;
}

/** The product plan pipeline: its YAML, its top-level entries in order, and the product pipeline's jobs. */
export interface GitlabProductPlanPipeline {
  yaml: string;
  entries: Array<[string, unknown]>;
  jobs: ProductPipelineJobs;
}

/** The runner's clone keeps the job token in origin's URL; a re-plan drops it before the merge request's code runs (#4899). */
const GITLAB_SCRUB_ORIGIN = `git remote set-url origin "$(git remote get-url origin | sed -E 's#//[^@/]*@#//#')"`;

/** The product plan pipeline on GitLab CI (#4799): a plan job and a plan-note job per target. */
export function generateGitlabProductPlanPipeline(env: string, options: GitlabProductPlanPipelineOptions): GitlabProductPlanPipeline {
  const { image: given, beforeScript = [], extraScript = [], header = [], cache, ...pipeline } = options;
  const image = given ?? CI_IMAGE;
  if (options.branch !== undefined) assertGitlabBranch("The merge-request pipeline", options.branch);
  const jobs = productPipelineJobs("gitlab", env, pipeline);
  const plans = jobs.productPlan!;
  const plan = options.productPlan;
  const target = options.branch ? JSON.stringify(options.branch) : "$CI_DEFAULT_BRANCH";
  const onMergeRequest = plan.forks === "skip" ? `${GITLAB_MERGE_REQUEST_SOURCE} && ${GITLAB_SAME_PROJECT_IF}` : GITLAB_MERGE_REQUEST_SOURCE;
  // #4328: the notes are posted from a pipeline of the target branch, never from the merge request's own.
  const onPlanNotes = `$CI_PIPELINE_SOURCE =~ /^(schedule|web|api|trigger)$/ && $${GITLAB_PLAN_NOTES_VAR} == "1" && $CI_COMMIT_BRANCH == ${target}`;
  // #4899: the note-commands job starts a pipeline of the target branch for a re-plan comment, as for the comment preview.
  const replans = plans.filter((p) => p.replan);
  const onReplan = replans.length > 0 ? `$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $${GITLAB_REPLAN_PR_VAR} =~ /^[0-9]+$/ && $CI_COMMIT_BRANCH == ${target}` : undefined;
  const notes = jobs.noteCommands;
  const onNotes = notes ? `$CI_PIPELINE_SOURCE =~ /^(schedule|web|api|trigger)$/ && $${GITLAB_NOTE_COMMANDS_VAR} == "1" && $CI_COMMIT_BRANCH == ${target}` : undefined;
  const tags = (runner: (typeof plans)[number]["runner"]): Record<string, unknown> => {
    const t = gitlabTags(runner);
    return t ? { tags: t } : {};
  };
  // #4931: the OIDC tokens the login and the product's command read.
  const idTokens = (p: ProductPlanJob): Record<string, unknown> => (p.idTokens ? { id_tokens: Object.fromEntries(Object.entries(p.idTokens).map(([v, aud]) => [v, { aud }])) } : {});
  // #4963: the trade, the script's first lines after the control read; GitLab's id_tokens come with p.idTokens.
  const tradeVars = (p: ProductPlanJob): Record<string, string> => (p.trade ? { [TRADE_SPEC_ENV]: JSON.stringify(p.trade) } : {});
  const tradeLines = (p: ProductPlanJob): string[] => (p.trade ? gitlabTradeLines() : []);
  // #4899: the control read, before any of the change's code runs; its token goes with it.
  const controlLines = (p: ProductPlanJob): string[] => (p.control ? [p.control.script, "unset CHANT_CONTROL_READ_TOKEN"] : []);
  // The lines after the checkout and before the plan verb (#4899, #4931): the product's run steps, the setup lines, the login and the probe.
  // GitLab has no actions, so a uses step is left out; the generator's cache is GitLab's.
  const middle = (p: ProductPlanJob): string[] => [
    ...(p.setup ?? []).flatMap((st) => (st.run !== undefined ? [st.run] : [])),
    ...prLoopSetup(image, options.engineSetup),
    ...beforeScript,
    ...(p.login ?? []).flatMap((st) => st.run),
    ...(p.writeProbe ? [p.writeProbe] : []),
  ];
  const interruptible = plan.concurrency?.cancelInProgress ? { interruptible: true } : {};
  // #4935: the check job beside the plans, its evidence job after them, and the ref gate's status after the notes.
  const checkEntries = gitlabCheckJobs({
    image,
    setup: [...prLoopSetup(image, options.engineSetup), ...beforeScript],
    beforeScript,
    // The check job holds no credentials, so a fork's merge request runs it too; with forks: "skip" its hooks are not signed for (#4914).
    onMergeRequest: GITLAB_MERGE_REQUEST_SOURCE,
    onPlanNotes,
    ...(options.evidence?.runnerKeySecret ? { unset: [options.evidence.runnerKeySecret] } : {}),
    ...(jobs.check ? { check: jobs.check } : {}),
    ...(jobs.refGate ? { refGate: jobs.refGate } : {}),
  });
  // #4979: with reach, the lock job in the plan notes pipeline, and the comment lock and unlock jobs in a pipeline of the target branch each starts.
  const reach = jobs.reachLock;
  const commentLocks = reach ? (jobs.locks ?? []).map((job) => ({ job, rule: `$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $${job.gitlabVar} =~ /^[0-9]+$/ && $CI_COMMIT_BRANCH == ${target}` })) : [];
  const stagesBefore = [
    ...(plans.some((p) => p.evidence) ? ["plan", "evidence", PR_PLAN_NOTE_JOB] : ["plan", PR_PLAN_NOTE_JOB]),
    ...(reach ? [reach.jobName] : []),
    ...(notes ? [PR_NOTE_COMMANDS_JOB] : []),
    ...commentLocks.map((c) => c.job.jobName),
    ...(replans.length > 0 ? [REPLAN_JOB, REPLAN_NOTE_JOB] : []),
  ];
  const entries: Array<[string, unknown]> = [
    ["workflow", { name: plan.workflow ?? `chant-pr-${env}`, rules: [{ if: onMergeRequest }, { if: onPlanNotes }, ...(onReplan ? [{ if: onReplan }] : []), ...(onNotes ? [{ if: onNotes }] : []), ...commentLocks.map((c) => ({ if: c.rule }))] }],
    // #4870: the evidence jobs sign each plan job's checks, in a stage of their own after the plans.
    ["stages", withCheckStages(stagesBefore, checkEntries, PR_PLAN_NOTE_JOB)],
    ["variables", { CHANT_ENV: env, ...GITLAB_FULL_HISTORY }],
  ];
  for (const p of plans) {
    entries.push([
      p.jobName,
      {
        stage: "plan",
        image,
        ...tags(p.runner),
        rules: [{ if: onMergeRequest }],
        ...interruptible,
        // #4899: with record, the record line reads its op, environment and labels.
        variables: { ...(p.jobEnv ?? {}), ...p.env, ...(p.record?.env ?? {}), ...tradeVars(p) },
        ...idTokens(p),
        ...(cache !== undefined ? { cache } : {}),
        // #4295: the merge request's code runs in this job, so its shell drops the forge tokens first.
        script: [...controlLines(p), ...tradeLines(p), GITLAB_DROP_FORGE_TOKENS, ...middle(p), ...planVerbLines(p), ...extraScript],
        artifacts: { name: p.artifact, when: "always", paths: [PR_LOOP_REPORT_DIR] },
      },
    ]);
  }
  // #4914: the evidence jobs run in the plan notes pipeline, before the note jobs, for every open merge request.
  for (const p of plans) {
    if (!p.evidence) continue;
    entries.push(gitlabOpenEvidenceJob(p.evidence, { image, runner: p.noteRunner, beforeScript, onPlanNotes }));
  }
  for (const p of plans) {
    entries.push([
      p.noteJobName,
      {
        stage: PR_PLAN_NOTE_JOB,
        image,
        ...tags(p.noteRunner),
        // #4914: a signing job that failed leaves the notes to post, without the checks line.
        rules: [p.evidence ? { if: onPlanNotes, when: "always" } : { if: onPlanNotes }],
        ...(Object.keys(p.post.env).length > 0 ? { variables: p.post.env } : {}),
        script: [...beforeScript, p.post.command],
      },
    ]);
  }
  if (reach) {
    // The target branch's commit: the reach line reads each merge request's change as data from git, and runs none of its code. One at a time.
    entries.push([reach.jobName, { stage: reach.jobName, image, ...tags(reach.runner), resource_group: reach.jobName, rules: [{ if: onPlanNotes }], variables: reach.env, script: [...beforeScript, reach.command] }]);
  }
  entries.push(...checkEntries);
  if (notes && onNotes) {
    // The target branch's commit: the job reads the notes as data through the API and runs none of a merge request's code. One poll at a time.
    // #4984: with waves, the poll is told their op and count (a wave stop on a retry) and the waves before merge, in CHANT_COMMENT_JOBS.
    entries.push([PR_NOTE_COMMANDS_JOB, { stage: PR_NOTE_COMMANDS_JOB, image, ...tags(notes.runner), resource_group: PR_NOTE_COMMANDS_JOB, ...(notes.env ? { variables: { ...notes.env } } : {}), rules: [{ if: onNotes }], script: [...beforeScript, notes.command] }]);
  }
  // #4979: `/<product> lock` keeps the locks the lock job took, `/<product> unlock` releases them, each at the target branch's commit.
  for (const { job, rule } of commentLocks) {
    entries.push([job.jobName, { stage: job.jobName, image, ...tags(job.runner), rules: [{ if: rule }], variables: job.env, script: [...beforeScript, job.line] }]);
  }
  for (const p of replans) {
    const r = p.replan!;
    // The comment's one word after the command, which the rule already held to plain characters.
    const argument = gitlabReplanArgumentLines(r);
    entries.push([
      r.jobName,
      {
        stage: REPLAN_JOB,
        image,
        ...tags(p.runner),
        rules: [{ if: `${onReplan} && (${gitlabReplanCommentIf(r, p.target)})` }],
        variables: { ...(p.jobEnv ?? {}), ...p.env, ...(p.record?.env ?? {}), BASE_SHA: "$CI_COMMIT_SHA", PR_NUMBER: `$${GITLAB_REPLAN_PR_VAR}`, ...tradeVars(p) },
        ...idTokens(p),
        ...(cache !== undefined ? { cache } : {}),
        // A pipeline of the target branch holds the protected tokens, so the job drops them before it checks out the merge request's head.
        // #4963: the trade first, before the head is checked out.
        script: [
          ...controlLines(p),
          ...tradeLines(p),
          GITLAB_DROP_FORGE_TOKENS,
          "unset CHANT_RUNNER_KEY",
          pullRequestCheckout("gitlab"),
          // The ledger while the clone can still fetch it: a plan reads the gate ledger from the local branch.
          "git fetch -q --no-tags origin '+refs/heads/chant/lifecycle:refs/heads/chant/lifecycle' 2>/dev/null || true",
          GITLAB_SCRUB_ORIGIN,
          ...argument,
          ...middle(p),
          ...planVerbLines(p),
          ...extraScript,
        ],
        artifacts: { name: r.artifact, when: "always", paths: [PR_LOOP_REPORT_DIR] },
      },
    ]);
  }
  for (const p of replans) {
    const r = p.replan!;
    entries.push([
      r.noteJobName,
      {
        stage: REPLAN_NOTE_JOB,
        image,
        ...tags(p.noteRunner),
        needs: [{ job: r.jobName, artifacts: true }],
        rules: [{ if: `${onReplan} && (${gitlabReplanCommentIf(r, p.target)})`, when: "always" }],
        variables: r.post.env,
        // The target branch's commit: the job's own clone, where none of the merge request's code runs.
        // #4963: with notAffected, the argument the re-plan was narrowed to, read again from the comment.
        script: [...beforeScript, ...(r.post.setup ?? []), ...(r.notAffected ? gitlabReplanArgumentLines(r) : []), r.post.command],
      },
    ]);
  }
  return { yaml: emitGitlabFile(entries, header), entries, jobs };
}
