/**
 * Generate mode — component → Forgejo Actions workflow YAML (#969, epic #885).
 *
 * The forgejo counterpart to the github generator
 * (`@intentius/chant-lexicon-github/components/generate-pipeline`, #891). Forgejo
 * Actions is a GitHub-Actions dialect, and this lexicon is already a thin
 * github-dialect serializer, so the pipeline SHAPE is identical: one job per
 * component, `needs:` mirroring `dependsOn`, cross-stack outputs threaded as
 * workflow artifacts, thin trigger jobs. Rather than re-derive the component
 * graph, this reuses github's `buildGithubPipelineDoc` to build the exact same
 * `on`/`env`/`jobs` structure, then applies the Forgejo dialect
 * ({@link transformWorkflowObject}) before emitting — the same transform the
 * forgejo serializer applies to authored workflows:
 *
 *  - runner labels: `runs-on: ubuntu-latest` → the project's Forgejo label
 *    (default `docker`, the label a fresh `act_runner` exposes);
 *  - `uses:` refs (`actions/checkout@v4`, `actions/upload-artifact@v4`, …)
 *    rewritten to a Forgejo-resolvable form;
 *  - keys the Forgejo runner ignores (`permissions`, `continue-on-error`)
 *    dropped — the github generator emits none today, but the transform keeps
 *    the two dialects in lock-step if that changes.
 *
 * The output path convention is `.forgejo/workflows/` (vs github's
 * `.github/workflows/`), set by the caller's `-o` flag — this module emits the
 * workflow content, not its location, exactly like the github generator.
 */

import {
  buildGithubPipelineDoc,
  emitPipelineYAML,
  type GithubPipelineDoc,
} from "@intentius/chant-lexicon-github/components/generate-pipeline";
import type { DriverComponent } from "@intentius/chant/components/driver";
import type {
  ComponentPipelineOptions,
  ComponentPipelineResult,
} from "@intentius/chant/lexicon";
import { transformWorkflowObject, type ForgejoDialectOptions } from "../dialect";

/** Apply the Forgejo dialect to one section of the pipeline doc. */
function forgejoize(value: Record<string, unknown>, dialect: ForgejoDialectOptions): Record<string, unknown> {
  return transformWorkflowObject(value, dialect).value as Record<string, unknown>;
}

/**
 * Synthesize a `.forgejo/workflows/*.yml` pipeline from a set of components.
 * Reuses github's job/`needs:`/artifact structure ({@link buildGithubPipelineDoc}),
 * then applies the Forgejo dialect. Wired into core's generate mode via the
 * forgejo lexicon plugin's `generateComponentPipeline` (../plugin.ts).
 */
export function generateForgejoPipeline(
  components: DriverComponent[],
  options: ComponentPipelineOptions = {},
  dialectOptions: ForgejoDialectOptions = {},
): ComponentPipelineResult {
  const doc = buildGithubPipelineDoc(components, options);

  const forgejoDoc: GithubPipelineDoc = {
    // The environment identity (#2046) is dialect-neutral: name, environment,
    // and the env-map's CHANT_ENV entry pass through untransformed.
    name: doc.name,
    environment: doc.environment,
    on: forgejoize(doc.on, dialectOptions),
    ...(doc.env ? { env: forgejoize(doc.env, dialectOptions) } : {}),
    jobsDoc: forgejoize(doc.jobsDoc, dialectOptions),
    stages: doc.stages,
    jobs: doc.jobs,
  };

  return { yaml: emitPipelineYAML(forgejoDoc), stages: doc.stages, jobs: doc.jobs, env: doc.environment };
}
