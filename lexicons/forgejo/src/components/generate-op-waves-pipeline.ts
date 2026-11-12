/**
 * Op waves → Forgejo Actions workflow (#3679).
 *
 * The github workflow ({@link buildGithubOpWavesDoc}) under the Forgejo
 * dialect: action refs rewritten, `permissions:` dropped (the runner reads
 * none), and each wave's `environment:` dropped with a header line saying so,
 * since Forgejo Actions has no environments. The wave's chant gate is what
 * holds it there.
 *
 * With `resume` on the spec (#3683), `<name>-resume.yml` runs `chant run
 * resume --op <name>` on that schedule. Forgejo has no API to re-run a run,
 * so it dispatches the waves workflow again on its branch, with the
 * `CHANT_FORGE_TOKEN` secret (a token with the `write:repository` scope).
 *
 * A `pr-review` wave (#3684), or a `pull-request` wave (#4630), gets
 * `<name>-plans.yml` on pull requests, as on GitHub. Forgejo's job token reads reviews with no permission to ask for.
 *
 * `runner` and a wave's `jobs` (#3914) render as on GitHub, with two limits:
 * a runner is a label or a list of labels (a GitHub runner group is a spec
 * error), and a job group cannot name an `environment`, since Forgejo has
 * none to put in front of it. A job with id tokens keeps `permissions:
 * id-token: write`, the one scope the dialect leaves, and reads each audience
 * from `<NAME>_AUDIENCE` when it requests its token.
 *
 * The apply-job guard (#4624) starts each wave job as on GitHub, with the
 * forge set to Forgejo: it checks the ref and, for a `self-hosted` label,
 * the runner, and no forge environment, since Forgejo has none.
 *
 * With `runGroup` (#4771) each workflow gets a workflow-level run group,
 * since Forgejo otherwise cancels the run in progress when a push starts
 * another ({@link withRunGroup}). Without it, like GitHub's, the workflow
 * carries no concurrency group (ruling for
 * ci-products 2026-10-28, "Ledger lock"; Forgejo 16.0.5 has no job-level
 * concurrency either). Two pushes run their waves side by side: a stock
 * Pulumi stack or a Terraform root waits for its row on chant's ledger,
 * oldest commit first, up to the job's `timeout-minutes`, and a plunge stack
 * on the resource grain leases its resource rows and never waits on another
 * stack.
 */

import { buildGithubOpWavesDoc } from "@intentius/chant-lexicon-github/components/generate-op-waves-pipeline";
import { emitOpPipelineYAML } from "@intentius/chant-lexicon-github/components/generate-op-pipeline";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { opWavesResumeWorkflowFile, opWavesWorkflowFile } from "@intentius/chant/op/op-waves-names";
import { assertRunnerLabels } from "@intentius/chant/ci-jobs";
import type { OpWavesPipelineOptions, OpWavesPipelineResult } from "@intentius/chant/lexicon";
import type { ForgejoDialectOptions } from "../dialect";
import { droppedWaveEnvironmentsHeader, FORGE_TOKEN_ENV, forgejoWorkflowDoc, withRunGroup } from "./ci-jobs";

/**
 * The Forgejo workflow document, before emission, and the jobs it holds
 * (#5022): {@link buildGithubOpWavesDoc} under the Forgejo dialect, for a
 * product that renders the jobs into its own workflow (`runIf`).
 */
export function buildForgejoOpWavesDoc(spec: OpWavesSpec, options: OpWavesPipelineOptions, dialectOptions: ForgejoDialectOptions = {}): ReturnType<typeof buildGithubOpWavesDoc> & { header?: string[] } {
  assertForgejoWaves(spec);
  const built = buildGithubOpWavesDoc(spec, options, { forge: "forgejo" });
  const dropped = spec.waves.filter((w) => w.environment).map((w) => `${w.name} -> ${w.environment!.name}`);
  const header = dropped.length > 0 ? droppedWaveEnvironmentsHeader(dropped) : undefined;
  return { ...built, doc: forgejoWorkflowDoc(built.doc, dialectOptions, header), ...(header ? { header } : {}) };
}

/** Render an Op waves spec as one Forgejo Actions workflow, `<name>.yml` (#5022: or `workflowFile`). */
export function generateForgejoOpWavesPipeline(
  spec: OpWavesSpec,
  options: OpWavesPipelineOptions,
  dialectOptions: ForgejoDialectOptions = {},
): OpWavesPipelineResult {
  const { doc, jobs, resumeDoc, plansDoc } = buildForgejoOpWavesDoc(spec, options, dialectOptions);
  // #4771: the run group a product asks for, on each of the spec's workflows.
  const grouped = (d: ReturnType<typeof forgejoWorkflowDoc>) => withRunGroup(d, options.runGroup, spec.name);
  const files = [{ name: opWavesWorkflowFile(spec, options.workflowFile), yaml: emitOpPipelineYAML(grouped(doc)) }];
  if (resumeDoc) {
    // Forgejo has no API to re-run a run, so resume dispatches the workflow
    // again, with a token that may.
    const resume = forgejoWorkflowDoc(resumeDoc, dialectOptions);
    for (const job of Object.values(resume.jobsDoc) as Array<{ steps: Array<Record<string, unknown>> }>) {
      for (const step of job.steps) if (step.env) step.env = { ...FORGE_TOKEN_ENV };
    }
    // #5034: in the product's file.
    files.push({ name: opWavesResumeWorkflowFile(spec, options.resumeWorkflowFile, files[0]!.name), yaml: emitOpPipelineYAML(grouped(resume)) });
  }
  if (plansDoc) files.push({ name: `${spec.name}-plans.yml`, yaml: emitOpPipelineYAML(grouped(forgejoWorkflowDoc(plansDoc, dialectOptions))) });
  return { files, jobs };
}

/** Refuse what Forgejo cannot carry (#3914): a runner group, and a job group's environment. */
function assertForgejoWaves(spec: OpWavesSpec): void {
  const subject = `Op waves "${spec.name}"`;
  assertRunnerLabels(subject, "runner", spec.runner, "Forgejo");
  for (const wave of spec.waves) {
    assertRunnerLabels(subject, `wave "${wave.name}" runner`, wave.runner, "Forgejo");
    for (const group of wave.jobs ?? []) {
      const field = `wave "${wave.name}" job group "${group.name}"`;
      assertRunnerLabels(subject, `${field} runner`, group.runner, "Forgejo");
      if (group.environment) {
        throw new Error(
          `${subject}: ${field} names the environment "${group.environment.name}", but Forgejo Actions has no environments, ` +
            "so nothing on the forge would hold the job or scope its secrets. Drop it; the group still renders as its own job with its own runner and variables.",
        );
      }
    }
  }
}
