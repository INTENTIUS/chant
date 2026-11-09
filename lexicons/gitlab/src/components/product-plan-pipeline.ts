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
 * With `evidence` (#4870) each plan job is followed, once it succeeded, by
 * `<plan job>-evidence`, which signs its `plan` and `policy` checks from the
 * plan job's artifact with the runner key in the named CI/CD variable, and
 * pushes them to `refs/notes/chant/evidence`, where the ref gate (#4867) reads them.
 */

import { assertGitlabBranch, CI_IMAGE, GITLAB_FULL_HISTORY, GITLAB_MERGE_REQUEST_SOURCE, gitlabTags } from "@intentius/chant/ci-jobs";
import { GITLAB_DROP_FORGE_TOKENS } from "@intentius/chant/ci-handover";
import { GITLAB_PLAN_NOTES_VAR, PR_LOOP_REPORT_DIR, PR_PLAN_NOTE_JOB, prLoopSetup } from "@intentius/chant/components/pr-pipeline";
import { productPipelineJobs, type ProductPipelineJobs, type ProductPipelineOptions } from "@intentius/chant/components/product-pipeline";
import { GITLAB_SAME_PROJECT_IF, type ProductPlanOptions } from "@intentius/chant/components/product-plan";
import { emitGitlabFile } from "./ci-jobs";

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
}

/** The product plan pipeline: its YAML, its top-level entries in order, and the product pipeline's jobs. */
export interface GitlabProductPlanPipeline {
  yaml: string;
  entries: Array<[string, unknown]>;
  jobs: ProductPipelineJobs;
}

/** The product plan pipeline on GitLab CI (#4799): a plan job and a plan-note job per target. */
export function generateGitlabProductPlanPipeline(env: string, options: GitlabProductPlanPipelineOptions): GitlabProductPlanPipeline {
  const { image: given, beforeScript = [], extraScript = [], header = [], ...pipeline } = options;
  const image = given ?? CI_IMAGE;
  if (options.branch !== undefined) assertGitlabBranch("The merge-request pipeline", options.branch);
  const jobs = productPipelineJobs("gitlab", env, pipeline);
  const plans = jobs.productPlan!;
  const target = options.branch ? JSON.stringify(options.branch) : "$CI_DEFAULT_BRANCH";
  const onMergeRequest = options.productPlan.forks === "skip" ? `${GITLAB_MERGE_REQUEST_SOURCE} && ${GITLAB_SAME_PROJECT_IF}` : GITLAB_MERGE_REQUEST_SOURCE;
  // #4328: the notes are posted from a pipeline of the target branch, never from the merge request's own.
  const onPlanNotes = `$CI_PIPELINE_SOURCE =~ /^(schedule|web|api|trigger)$/ && $${GITLAB_PLAN_NOTES_VAR} == "1" && $CI_COMMIT_BRANCH == ${target}`;
  const tags = (runner: (typeof plans)[number]["runner"]): Record<string, unknown> => {
    const t = gitlabTags(runner);
    return t ? { tags: t } : {};
  };
  const entries: Array<[string, unknown]> = [
    ["workflow", { name: options.productPlan.workflow ?? `chant-pr-${env}`, rules: [{ if: onMergeRequest }, { if: onPlanNotes }] }],
    // #4870: the evidence jobs sign each plan job's checks, in a stage of their own after the plans.
    ["stages", plans.some((p) => p.evidence) ? ["plan", "evidence", PR_PLAN_NOTE_JOB] : ["plan", PR_PLAN_NOTE_JOB]],
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
        variables: p.env,
        // #4295: the merge request's code runs in this job, so its shell drops the forge tokens first.
        script: [GITLAB_DROP_FORGE_TOKENS, ...prLoopSetup(image, options.engineSetup), ...beforeScript, ...(p.writeProbe ? [p.writeProbe] : []), p.command, ...extraScript],
        artifacts: { name: p.artifact, when: "always", paths: [PR_LOOP_REPORT_DIR] },
      },
    ]);
  }
  for (const p of plans) {
    if (!p.evidence) continue;
    entries.push([
      p.evidence.jobName!,
      {
        stage: "evidence",
        image,
        ...tags(p.noteRunner),
        rules: [{ if: onMergeRequest }],
        needs: [{ job: p.jobName, artifacts: true }],
        variables: p.evidence.env,
        script: [...beforeScript, ...p.evidence.lines],
      },
    ]);
  }
  for (const p of plans) {
    entries.push([
      p.noteJobName,
      {
        stage: PR_PLAN_NOTE_JOB,
        image,
        ...tags(p.noteRunner),
        rules: [{ if: onPlanNotes }],
        ...(Object.keys(p.post.env).length > 0 ? { variables: p.post.env } : {}),
        script: [...beforeScript, p.post.command],
      },
    ]);
  }
  return { yaml: emitGitlabFile(entries, header), entries, jobs };
}
