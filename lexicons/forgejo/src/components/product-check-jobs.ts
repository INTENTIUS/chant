/**
 * The check job, the check evidence job and the ref gate's status job for a
 * product's own pull request workflow on Forgejo Actions (#4964): the
 * GitHub jobs (`productCheckJobs` in the github lexicon), with their
 * commands naming Forgejo, through the Forgejo dialect: runner labels,
 * `uses:` refs Forgejo resolves, the `permissions` Forgejo ignores dropped,
 * and `enable-openid-connect` on a job that signs keyless.
 */

import { productCheckJobs, type ProductCheckJobs, type ProductCheckJobsOptions } from "@intentius/chant-lexicon-github/components/product-check-jobs";
import type { ForgejoDialectOptions } from "../dialect";
import { forgejoize, withOpenIdConnect } from "./ci-jobs";

export type { ProductCheckJobs, ProductCheckJobsOptions };
export { PRODUCT_CHECK_JOBS_FLOOR } from "@intentius/chant/components/pr-checks";

/** The check jobs for a product's own workflow on Forgejo (#4964). */
export function forgejoProductCheckJobs(env: string, options: ProductCheckJobsOptions, dialectOptions: ForgejoDialectOptions = {}): ProductCheckJobs {
  const { jobsDoc, jobs } = productCheckJobs("forgejo", env, options);
  return { jobsDoc: withOpenIdConnect(forgejoize(jobsDoc, dialectOptions), undefined), jobs };
}
