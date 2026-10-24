/**
 * The Forgejo dialect of the three generated pipelines (#3765). Each forgejo
 * generator builds github's document and hands it here: action refs and
 * runner labels rewritten ({@link transformWorkflowObject}), `permissions:`
 * dropped (the runner reads none), and a job's `environment:` dropped with a
 * header note naming it, since Forgejo Actions has no environments.
 */

import { githubSecret } from "@intentius/chant/ci-jobs";
import type { GithubOpPipelineDoc } from "@intentius/chant-lexicon-github/components/generate-op-pipeline";
import { transformWorkflowObject, type ForgejoDialectOptions } from "../dialect";

/** Apply the Forgejo dialect to one section of a pipeline doc. */
export function forgejoize(value: Record<string, unknown>, dialect: ForgejoDialectOptions): Record<string, unknown> {
  return transformWorkflowObject(value, dialect).value as Record<string, unknown>;
}

/**
 * Strip each job's `environment:` (#2257). Forgejo Actions has no
 * environments, so the key would read as a deployment gate and hold nothing
 * back. Dropped here rather than in the dialect's own `DROPPED_KEYS`, so it
 * touches the generated pipelines alone and leaves every other document the
 * dialect transforms as it is.
 */
export function withoutEnvironment(jobsDoc: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(jobsDoc).map(([jobName, job]) => {
      if (typeof job !== "object" || job === null || !("environment" in job)) return [jobName, job];
      const { environment: _dropped, ...rest } = job as Record<string, unknown>;
      return [jobName, rest];
    }),
  );
}

/** The header of an Op's workflow whose environment gate did not survive the crossing. */
export function droppedEnvironmentHeader(environmentName: string): string[] {
  return [
    `# chant dropped \`environment: ${environmentName}\` from this workflow: Forgejo Actions has no`,
    "# environments, so there is no protection rule, required reviewer or wait timer for the key to",
    "# name. This job is not held back by anything on the forge. What still stops the apply is chant's",
    "# own gate: the run records a pending fact on the chant/lifecycle branch and ends, and `chant",
    "# approve <op> <gate>` is what lets the next run through.",
  ];
}

/** The header of an Op waves workflow, naming each wave whose environment was dropped as `wave -> environment`. */
export function droppedWaveEnvironmentsHeader(dropped: readonly string[]): string[] {
  return [
    `# chant dropped the environment of each of these waves: ${dropped.join(", ")}.`,
    "# Forgejo Actions has no environments, so nothing on the forge holds these jobs.",
    "# Each wave's own chant gate does: it records a pending fact on chant/lifecycle",
    "# and the wave exits 3 until `chant approve` approves its set digest.",
  ];
}

/**
 * The token a Forgejo job uses for what the job token cannot do, such as
 * dispatching a workflow: the `CHANT_FORGE_TOKEN` secret, a token with the
 * `write:repository` scope.
 */
export const FORGE_TOKEN_ENV = { CHANT_FORGE_TOKEN: githubSecret("CHANT_FORGE_TOKEN") };

/**
 * A github workflow document under the Forgejo dialect: every section
 * transformed, each job's `environment:` dropped, `permissions:` emptied, and
 * `header` above it when given.
 */
export function forgejoWorkflowDoc(doc: GithubOpPipelineDoc, dialect: ForgejoDialectOptions, header?: string[]): GithubOpPipelineDoc {
  return {
    ...(header ? { header } : {}),
    // Forgejo Actions reads `name:` as GitHub does (#2601).
    ...(doc.name ? { name: doc.name } : {}),
    on: forgejoize(doc.on, dialect),
    ...(doc.env ? { env: forgejoize(doc.env, dialect) } : {}),
    concurrency: forgejoize(doc.concurrency, dialect),
    permissions: {},
    jobsDoc: forgejoize(withoutEnvironment(doc.jobsDoc), dialect),
    ...(doc.gatedNoticeDoc ? { gatedNoticeDoc: forgejoize(doc.gatedNoticeDoc, dialect) } : {}),
    ...(doc.reviewNoteDoc ? { reviewNoteDoc: forgejoize(doc.reviewNoteDoc, dialect) } : {}),
  };
}
