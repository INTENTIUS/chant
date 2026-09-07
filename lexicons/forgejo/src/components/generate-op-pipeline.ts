/**
 * Generate mode — scheduled Op → Forgejo Actions workflow YAML (#927).
 *
 * The forgejo counterpart to the github Op generator
 * (`@intentius/chant-lexicon-github/components/generate-op-pipeline`, #927),
 * exactly like `./generate-pipeline.ts` is the forgejo counterpart to
 * github's component generator (#969). Reuses github's
 * `buildGithubOpPipelineDocs` to build the same cron-trigger/concurrency/job
 * structure, then applies the Forgejo dialect ({@link transformWorkflowObject})
 * before emitting.
 *
 * One difference from the component generator: Forgejo Actions ignores
 * `permissions:` entirely (the dialect drops it wherever it appears, see
 * ../dialect.ts's `DROPPED_KEYS`), so this omits the section outright rather
 * than emitting a control the runner can't act on. The token a finding-mode
 * needs still rides the trigger step's `env:` (`GH_TOKEN`/`GITHUB_TOKEN`,
 * built by github's generator); actual write access on Forgejo is a property
 * of the runner/token configuration, not the workflow YAML.
 *
 * One finding-mode does not cross over: `comment` (#2231) posts onto the
 * triggering pull request by shelling to `gh` against the GitHub API and
 * reading the GitHub Actions event payload. Forgejo's API is
 * GitHub-compatible in shape, but chant has no Forgejo client and no host
 * configuration to point `gh` at a Forgejo instance, so this refuses the mode
 * by name rather than generating a job whose finding step fails on every run.
 */

import {
  buildGithubOpPipelineDocs,
  emitOpPipelineYAML,
  type GithubOpPipelineDoc,
} from "@intentius/chant-lexicon-github/components/generate-op-pipeline";
import type {
  ComponentPipelineOptions,
  OpPipelineResult,
  ScheduledOpSpec,
} from "@intentius/chant/lexicon";
import { transformWorkflowObject, type ForgejoDialectOptions } from "../dialect";

/** Apply the Forgejo dialect to one section of a pipeline doc. */
function forgejoize(value: Record<string, unknown>, dialect: ForgejoDialectOptions): Record<string, unknown> {
  return transformWorkflowObject(value, dialect).value as Record<string, unknown>;
}

/**
 * Synthesize one `.forgejo/workflows/*.yml` per scheduled Op. Reuses github's
 * trigger/job structure ({@link buildGithubOpPipelineDocs}), then applies the
 * Forgejo dialect and drops `permissions:` (ignored by the Forgejo runner).
 * Wired into core's Op generate mode via the forgejo lexicon plugin's
 * `generateOpPipeline` (../plugin.ts).
 */
export function generateForgejoOpPipeline(
  ops: ScheduledOpSpec[],
  options: ComponentPipelineOptions = {},
  dialectOptions: ForgejoDialectOptions = {},
): OpPipelineResult {
  for (const spec of ops) {
    if (spec.findingMode === "comment") {
      throw new Error(
        `Scheduled Op "${spec.name}" has findingMode "comment", which posts its finding on the pull request ` +
          `that triggered the run. That activity shells to \`gh\` against the GitHub API and reads the ` +
          `GitHub Actions event payload; chant carries no Forgejo API client to post the equivalent comment ` +
          `(#2231). Use findingMode "issue" here, or generate this Op for github.`,
      );
    }
  }

  const { files, jobs } = buildGithubOpPipelineDocs(ops, options);

  return {
    files: files.map(({ name, doc }) => {
      const forgejoDoc: GithubOpPipelineDoc = {
        on: forgejoize(doc.on, dialectOptions),
        ...(doc.env ? { env: forgejoize(doc.env, dialectOptions) } : {}),
        concurrency: forgejoize(doc.concurrency, dialectOptions),
        permissions: {},
        jobsDoc: forgejoize(doc.jobsDoc, dialectOptions),
      };
      return { name, yaml: emitOpPipelineYAML(forgejoDoc) };
    }),
    jobs,
  };
}
