/**
 * The check job, the check evidence job and the ref gate's status job for a
 * product's own GitLab pipeline (#4964), beside jobs the product renders
 * itself: the ones chant's merge request loop and product plan pipeline
 * render (`./pr-check-jobs.ts`), from `productPipelineJobs` with `checkJob`
 * and `refGateStatus`. With `checkJob: { services, env, before, dir }` the
 * check job starts the product's service containers; GitLab does not wait
 * for a service, so `before` holds the wait.
 *
 * The check job runs in the merge request pipeline. The signing job and the
 * ref gate's job run in the target branch's plan notes pipeline (#4914,
 * #4328), started by a schedule with `CHANT_PLAN_NOTES=1`, so the product's
 * `workflow: rules:` must let both pipelines run: {@link GitlabProductCheckJobs.rules}
 * gives the two conditions. The signing job names the `chant-evidence`
 * environment, which the runner key's CI/CD variable is scoped to,
 * protected.
 */

import { CI_IMAGE, GITLAB_MERGE_REQUEST_SOURCE } from "@intentius/chant/ci-jobs";
import { GITLAB_PLAN_NOTES_VAR, prLoopSetup } from "@intentius/chant/components/pr-pipeline";
import { productPipelineJobs, type ProductPipelineJobs, type ProductPipelineOptions } from "@intentius/chant/components/product-pipeline";
import { GITLAB_CHECK_STAGES, gitlabCheckJobs } from "./pr-check-jobs";

export { PRODUCT_CHECK_JOBS_FLOOR } from "@intentius/chant/components/pr-checks";

/** What {@link gitlabProductCheckJobs} takes: the product pipeline's options with `checkJob` or `refGateStatus`, and how the jobs are set up. */
export interface GitlabProductCheckJobsOptions extends ProductPipelineOptions {
  /** The image every job runs in. Default chant's CI image, which gets the engine setup lines. */
  image?: string;
  /** Lines after the setup in every job, such as the product's install. In the check job they run after the tokens are dropped. */
  beforeScript?: string[];
}

/** The jobs as GitLab entries, the stages they use, and the pipelines they run in. */
export interface GitlabProductCheckJobs {
  entries: Array<[string, Record<string, unknown>]>;
  /** The stages the entries name, in order: the check's (`plan`), the evidence's, the ref gate's. Add each the pipeline lacks. */
  stages: string[];
  /** The `if:` of the merge request pipeline and of the target branch's plan notes pipeline, for the product's `workflow: rules:`. */
  rules: { mergeRequest: string; planNotes: string };
  jobs: ProductPipelineJobs;
}

/** The check jobs for a product's own GitLab pipeline (#4964). */
export function gitlabProductCheckJobs(env: string, options: GitlabProductCheckJobsOptions): GitlabProductCheckJobs {
  const { image: given, beforeScript = [], ...pipeline } = options;
  if (!pipeline.checkJob && !pipeline.refGateStatus) throw new Error("gitlabProductCheckJobs renders the check job and the ref gate's status job, so it needs checkJob or refGateStatus");
  const image = given ?? CI_IMAGE;
  const jobs = productPipelineJobs("gitlab", env, pipeline);
  const target = options.branch ? JSON.stringify(options.branch) : "$CI_DEFAULT_BRANCH";
  const planNotes = `$CI_PIPELINE_SOURCE =~ /^(schedule|web|api|trigger)$/ && $${GITLAB_PLAN_NOTES_VAR} == "1" && $CI_COMMIT_BRANCH == ${target}`;
  const entries = gitlabCheckJobs({
    image,
    setup: [...prLoopSetup(image, options.engineSetup), ...beforeScript],
    beforeScript,
    onMergeRequest: GITLAB_MERGE_REQUEST_SOURCE,
    onPlanNotes: planNotes,
    ...(options.evidence?.runnerKeySecret ? { unset: [options.evidence.runnerKeySecret] } : {}),
    ...(jobs.check ? { check: jobs.check } : {}),
    ...(jobs.refGate ? { refGate: jobs.refGate } : {}),
  });
  const used = new Set(entries.map(([, j]) => j.stage as string));
  const stages = [GITLAB_CHECK_STAGES.check, GITLAB_CHECK_STAGES.evidence, GITLAB_CHECK_STAGES.refGate].filter((s) => used.has(s));
  return { entries, stages, rules: { mergeRequest: GITLAB_MERGE_REQUEST_SOURCE, planNotes }, jobs };
}
