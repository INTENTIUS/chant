/**
 * The check job, the check evidence job and the ref gate's status job for a
 * product's own pull request workflow on GitHub Actions (#4964), beside
 * jobs the product renders itself: a product that keeps its own workflow
 * (its lint and plan jobs) adds these to its `jobs:` instead of writing a
 * `chant ci check` line of its own. The jobs are the ones chant's pull
 * request loop and product plan workflow render (`./pr-check-jobs.ts`),
 * from `productPipelineJobs` with `checkJob` and `refGateStatus`; with
 * `checkJob: { services, env, before, dir }` the check job starts the
 * product's service containers, such as a throwaway server its hooks replay
 * into. Forgejo renders the same jobs through its dialect
 * (`forgejoProductCheckJobs` in the forgejo lexicon).
 *
 * The jobs are plain job mappings, as `GithubWorkflowDoc.jobsDoc` holds
 * them: the product merges them into its workflow's `jobs:` mapping (with
 * `emitWorkflowYAML`, or its own emitter). They run on `pull_request`, so the
 * workflow needs that trigger; the check evidence job asks for `contents:
 * write` and the ref gate's for `statuses: write`, each in its own
 * `permissions:`.
 */

import { CI_IMAGE } from "@intentius/chant/ci-jobs";
import { prLoopSetup } from "@intentius/chant/components/pr-pipeline";
import { productPipelineJobs, type ProductPipelineJobs, type ProductPipelineOptions } from "@intentius/chant/components/product-pipeline";
import { SAME_REPOSITORY_IF } from "@intentius/chant/components/product-plan";
import { githubCheckJobs } from "./pr-check-jobs";

export { PRODUCT_CHECK_JOBS_FLOOR } from "@intentius/chant/components/pr-checks";

/** What {@link productCheckJobs} takes: the product pipeline's options with `checkJob` or `refGateStatus`, and how the jobs are set up. */
export interface ProductCheckJobsOptions extends ProductPipelineOptions {
  /** The image every job runs in. Default chant's CI image, which gets the engine setup lines. */
  image?: string;
  /** Lines after the setup in every job, such as the product's install. In the check job they run without the forge tokens. */
  beforeScript?: string[];
  /**
   * The product's own jobs the ref gate's status job waits for besides the
   * check jobs: those that sign `plan` and `policy`, so the status is set
   * once their evidence is in. Default none.
   */
  refGateNeeds?: string[];
}

/** The jobs by name (check, check-evidence, ref-gate, those asked for), and the product pipeline's jobs they came from. */
export interface ProductCheckJobs {
  jobsDoc: Record<string, unknown>;
  jobs: ProductPipelineJobs;
}

/** The check jobs for a product's own workflow on GitHub (`forge` `forgejo`: before the Forgejo dialect) (#4964). */
export function productCheckJobs(forge: "github" | "forgejo", env: string, options: ProductCheckJobsOptions): ProductCheckJobs {
  const { image: given, beforeScript = [], refGateNeeds = [], ...pipeline } = options;
  if (!pipeline.checkJob && !pipeline.refGateStatus) throw new Error("productCheckJobs renders the check job and the ref gate's status job, so it needs checkJob or refGateStatus");
  const image = given ?? CI_IMAGE;
  const jobs = productPipelineJobs(forge, env, pipeline);
  const when = "github.event_name == 'pull_request'";
  const jobsDoc = githubCheckJobs({
    forge,
    image,
    setup: [...prLoopSetup(image, options.engineSetup), ...beforeScript],
    beforeScript,
    // The check job holds no credentials, so a fork's pull request runs it too; with productPlan.forks "skip" the others do not.
    when,
    ...(options.productPlan?.forks === "skip" ? { trustedWhen: `${when} && ${SAME_REPOSITORY_IF}` } : {}),
    ...(jobs.check ? { check: jobs.check } : {}),
    ...(jobs.refGate ? { refGate: jobs.refGate } : {}),
    refGateNeeds,
  });
  return { jobsDoc, jobs };
}
