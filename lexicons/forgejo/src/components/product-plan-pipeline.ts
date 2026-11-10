/**
 * The product plan workflow on Forgejo Actions (#4799): the GitHub
 * document (`buildProductPlanGithubDoc`), with its commands naming Forgejo,
 * through the Forgejo dialect: runner labels, `uses:` refs Forgejo resolves,
 * and the `permissions` Forgejo ignores dropped.
 */

import { buildProductPlanGithubDoc, type ProductPlanPipeline, type ProductPlanPipelineOptions } from "@intentius/chant-lexicon-github/components/product-plan-pipeline";
import { emitWorkflowYAML, type GithubWorkflowDoc } from "@intentius/chant-lexicon-github/components/ci-jobs";
import type { ForgejoDialectOptions } from "../dialect";
import { forgejoize, withOpenIdConnect } from "./ci-jobs";

export type { ProductPlanPipeline, ProductPlanPipelineOptions };

/** The product plan workflow on Forgejo Actions (#4799). */
export function generateForgejoProductPlanPipeline(env: string, options: ProductPlanPipelineOptions, dialectOptions: ForgejoDialectOptions = {}): ProductPlanPipeline {
  const { doc: github, jobs } = buildProductPlanGithubDoc("forgejo", env, options);
  const doc: GithubWorkflowDoc = {
    ...github,
    on: forgejoize(github.on, dialectOptions),
    ...(github.env ? { env: forgejoize(github.env, dialectOptions) } : {}),
    // #4869: a job that asks for `id-token: write` (the note job signing keyless) gets enable-openid-connect.
    jobsDoc: withOpenIdConnect(forgejoize(github.jobsDoc, dialectOptions), (github as { permissions?: unknown }).permissions),
  };
  return { yaml: emitWorkflowYAML(doc), doc, jobs };
}
