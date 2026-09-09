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
 * That covers a spec's additive `permissions` too (#2242): an `id-token:
 * write` added for OIDC is dropped here along with the mode's own scopes,
 * because the Forgejo runner reads none of them and issues no OIDC token off
 * a workflow permission. A Forgejo job authenticates to a cloud provider
 * through whatever the runner already holds. A spec's `setup` steps do cross
 * over unchanged: Forgejo runs `uses:` steps, so they are emitted in the
 * position github puts them (after the checkout, ahead of the `beforeScript`
 * lines) with the dialect's own action-ref rewrite applied — an action with
 * no mapping in ../actions.ts passes through verbatim and resolves only if
 * the runner can fetch it.
 *
 * One finding-mode does not cross over: `comment` (#2231) posts onto the
 * triggering pull request by shelling to `gh` against the GitHub API and
 * reading the GitHub Actions event payload. Forgejo's API is
 * GitHub-compatible in shape, but chant has no Forgejo client and no host
 * configuration to point `gh` at a Forgejo instance, so this refuses the mode
 * by name rather than generating a job whose finding step fails on every run.
 *
 * A spec's `environment` (#2257) is dropped on the same terms as
 * `permissions:`, and for a stronger reason: Forgejo Actions has no
 * environments at all — no protection rules, no required reviewers, no
 * per-environment secrets — so the key names an object that does not exist on
 * the instance. Dropping it silently would be the worst outcome available,
 * because the whole point of the option is a human holding an apply, so this
 * also writes a comment into the generated file's header saying which
 * environment was asked for and that nothing on Forgejo enforces it. What
 * still holds the apply here is chant's own gate (#2119), which is a fact on
 * the `chant/lifecycle` branch and needs nothing from the forge.
 *
 * The gated-apply notice job (#2243) does not cross over either, for the same
 * reason and by the same mechanism as `permissions:`: it shells to `gh`, which
 * a Forgejo `act_runner` neither ships nor can point at its own instance, and
 * it runs outside the Op's container image, where a hosted GitHub runner's
 * preinstalled tools would be. So the doc rebuilt below simply does not carry
 * `gatedNoticeDoc`, and the job is dropped. What does cross over is the half
 * that needs no forge API: a `push` job still runs with `--gated-exit 0`, so a
 * Forgejo apply that stops at its gate is a green run rather than a red one,
 * and `chant run` still writes the gate and the approve command to
 * `GITHUB_STEP_SUMMARY`, which Forgejo Actions sets like GitHub does.
 *
 * The gate-notice job's own reason for being — `outputs: { gated, op, gate,
 * approve }` on the Op's job, and the `node -e` step that writes them to
 * `$GITHUB_OUTPUT` — does not survive it either (#2294). Both existed only for
 * that job to read via `needs.<job>.outputs`; with the job gone, so is every
 * reader, and `buildGithubOpPipelineDocs` is asked for neither
 * (`emitGatedOutputs: false` below) rather than emitting them here and
 * stripping them back out. Should the Forgejo posting work in #2291 grow a
 * notice job of its own, this is the one flag that brings both back.
 *
 * A spec's own `variables` (#2290) crosses over unchanged: forgejo reuses the
 * same job-level `env:` github's builder emits, and the dialect transform
 * touches only `permissions:`/`environment:`/action refs, never a job's `env:`
 * mapping. That is what makes a per-Op credential expressible here at all —
 * `ComponentPipelineOptions.variables` is workflow-scoped and, on Forgejo,
 * Actions mints no OIDC token to put in `setup` instead, so a job-level
 * `variables` entry is the only way one Op's job can hold a credential no
 * sibling Op's job receives.
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
 * Strip the job-level `environment:` github emitted (#2257). Forgejo Actions
 * has no environments, so the key would read as a deployment gate and hold
 * nothing back. Dropped from the rebuilt doc rather than from the dialect's
 * own `DROPPED_KEYS`, so this touches the Op generator alone and leaves every
 * other document the dialect transforms exactly as it emits today.
 */
function withoutEnvironment(jobsDoc: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(jobsDoc).map(([jobName, job]) => {
      if (typeof job !== "object" || job === null || !("environment" in job)) return [jobName, job];
      const { environment: _dropped, ...rest } = job as Record<string, unknown>;
      return [jobName, rest];
    }),
  );
}

/** Say in the generated file which environment gate did not survive the crossing. */
function droppedEnvironmentHeader(environmentName: string): string[] {
  return [
    `# chant dropped \`environment: ${environmentName}\` from this workflow: Forgejo Actions has no`,
    "# environments, so there is no protection rule, required reviewer or wait timer for the key to",
    "# name. This job is not held back by anything on the forge. What still stops the apply is chant's",
    "# own gate: the run records a pending fact on the chant/lifecycle branch and ends, and `chant",
    "# approve <op> <gate>` is what lets the next run through.",
  ];
}

/**
 * Synthesize one `.forgejo/workflows/*.yml` per scheduled Op. Reuses github's
 * trigger/job structure ({@link buildGithubOpPipelineDocs}) — its `setup`-step
 * and additive-permission validation included, so an unpinned action ref is
 * refused here on the same terms — then applies the Forgejo dialect and drops
 * `permissions:` (ignored by the Forgejo runner).
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

  // `emitGatedOutputs: false` (#2294): forgejo never carries a gate-notice job
  // (`gatedNoticeDoc` never crosses the dialect, below), so the job outputs
  // and the `node -e` step that populate them would have no reader.
  const { files, jobs } = buildGithubOpPipelineDocs(ops, options, { emitGatedOutputs: false });

  return {
    // One file per spec, in spec order, which is what lets the header below
    // read its Op's own `environment` off the input by position.
    files: files.map(({ name, doc }, index) => {
      const environment = ops[index].environment;
      const forgejoDoc: GithubOpPipelineDoc = {
        ...(environment ? { header: droppedEnvironmentHeader(environment.name) } : {}),
        on: forgejoize(doc.on, dialectOptions),
        ...(doc.env ? { env: forgejoize(doc.env, dialectOptions) } : {}),
        concurrency: forgejoize(doc.concurrency, dialectOptions),
        permissions: {},
        jobsDoc: forgejoize(withoutEnvironment(doc.jobsDoc), dialectOptions),
      };
      return { name, yaml: emitOpPipelineYAML(forgejoDoc) };
    }),
    jobs,
  };
}
