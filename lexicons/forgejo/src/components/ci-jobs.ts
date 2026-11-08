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
import type { RunGroupKey } from "@intentius/chant/lexicon";

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

/**
 * Forgejo 15 and later serves a job an OIDC token only when the job sets
 * `enable-openid-connect: true` (#4753); it does not read `id-token: write`.
 * Each job that asks for the token, by its own `permissions` or, with none of
 * its own, by the workflow's, gets the key.
 */
export function withOpenIdConnect(jobsDoc: Record<string, unknown>, workflowPermissions: unknown): Record<string, unknown> {
  const wants = (p: unknown): boolean => typeof p === "object" && p !== null && (p as Record<string, unknown>)["id-token"] === "write";
  const workflow = wants(workflowPermissions);
  return Object.fromEntries(
    Object.entries(jobsDoc).map(([jobName, job]) => {
      if (typeof job !== "object" || job === null) return [jobName, job];
      const own = (job as Record<string, unknown>).permissions;
      return wants(own) || (own === undefined && workflow) ? [jobName, { ...(job as Record<string, unknown>), "enable-openid-connect": true }] : [jobName, job];
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
    ...(doc.concurrency ? { concurrency: forgejoize(doc.concurrency, dialect) } : {}),
    permissions: {},
    jobsDoc: withOpenIdConnect(forgejoize(withoutEnvironment(doc.jobsDoc), dialect), doc.permissions),
    ...(doc.gatedNoticeDoc ? { gatedNoticeDoc: forgejoize(doc.gatedNoticeDoc, dialect) } : {}),
    ...(doc.reviewNoteDoc ? { reviewNoteDoc: forgejoize(doc.reviewNoteDoc, dialect) } : {}),
    ...(doc.agentDoc ? { agentDoc: forgejoize(doc.agentDoc, dialect) } : {}),
    ...(doc.commitDoc ? { commitDoc: forgejoize(doc.commitDoc, dialect) } : {}),
  };
}

/**
 * A workflow-level run group (#4771). Forgejo gives a run of a workflow with
 * no workflow-level `concurrency:` a group of its own per ref, workflow and
 * event, and cancels the run in progress when a push or a pull request update
 * starts another (with no `cancel-in-progress` set, a push or a pull request
 * sync cancels). A job-level `concurrency:` does not count. So two merges a
 * few seconds apart cancel the first merge's wave jobs while they run, which
 * can leave a stack half updated with nothing recorded.
 *
 * A group with `cancel-in-progress: false` only queues the runs that share it:
 *   - `commit`: one group per event and commit, so a merge's run is never
 *     cancelled by another commit's, and runs of other commits overlap as
 *     chant's ledger allows.
 *   - `pull-request`: one group per run, except that a pull request's runs
 *     share a group and cancel each other, as Forgejo already does for a new
 *     push to the pull request. A push to the target branch and a comment
 *     never cancel anything.
 *
 * `name` is the workflow's `name:`, which keeps two workflows' groups apart.
 */
export function runGroupConcurrency(name: string, key: RunGroupKey): Record<string, unknown> {
  return key === "commit"
    ? { group: `${name}-\${{ github.event_name }}-\${{ github.sha }}`, "cancel-in-progress": false }
    : { group: `${name}-\${{ github.event_name == 'pull_request' && github.ref || github.run_id }}`, "cancel-in-progress": "${{ github.event_name == 'pull_request' }}" };
}

/** `doc` with the run group `key` asks for, unless it has a workflow-level `concurrency:` already or no key is given. */
export function withRunGroup<T extends { name?: string; concurrency?: Record<string, unknown> }>(doc: T, key: RunGroupKey | undefined, fallbackName: string): T {
  if (!key || doc.concurrency) return doc;
  return { ...doc, concurrency: runGroupConcurrency(doc.name ?? fallbackName, key) };
}
