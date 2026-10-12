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
 * A `pr-review` wave (#3684) gets `<name>-plans.yml` on pull requests, as on
 * GitHub. Forgejo's job token reads reviews with no permission to ask for.
 *
 * `runner` and a wave's `jobs` (#3914) render as on GitHub, with two limits:
 * a runner is a label or a list of labels (a GitHub runner group is a spec
 * error), and a job group cannot name an `environment`, since Forgejo has
 * none to put in front of it. A job with id tokens keeps `permissions:
 * id-token: write`, the one scope the dialect leaves, and reads each audience
 * from `<NAME>_AUDIENCE` when it requests its token.
 */

import { buildGithubOpWavesDoc } from "@intentius/chant-lexicon-github/components/generate-op-waves-pipeline";
import { emitOpPipelineYAML } from "@intentius/chant-lexicon-github/components/generate-op-pipeline";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { assertRunnerLabels } from "@intentius/chant/ci-jobs";
import type { OpWavesPipelineOptions, OpWavesPipelineResult } from "@intentius/chant/lexicon";
import type { ForgejoDialectOptions } from "../dialect";
import { droppedWaveEnvironmentsHeader, FORGE_TOKEN_ENV, forgejoWorkflowDoc } from "./ci-jobs";

/** Render an Op waves spec as one Forgejo Actions workflow, `<name>.yml`. */
export function generateForgejoOpWavesPipeline(
  spec: OpWavesSpec,
  options: OpWavesPipelineOptions,
  dialectOptions: ForgejoDialectOptions = {},
): OpWavesPipelineResult {
  assertForgejoWaves(spec);
  const { doc, jobs, resumeDoc, plansDoc } = buildGithubOpWavesDoc(spec, options);
  const dropped = spec.waves.filter((w) => w.environment).map((w) => `${w.name} -> ${w.environment!.name}`);
  const header = dropped.length > 0 ? droppedWaveEnvironmentsHeader(dropped) : undefined;
  const files = [{ name: `${spec.name}.yml`, yaml: emitOpPipelineYAML(forgejoWorkflowDoc(doc, dialectOptions, header)) }];
  if (resumeDoc) {
    // Forgejo has no API to re-run a run, so resume dispatches the workflow
    // again, with a token that may.
    const resume = forgejoWorkflowDoc(resumeDoc, dialectOptions);
    for (const job of Object.values(resume.jobsDoc) as Array<{ steps: Array<Record<string, unknown>> }>) {
      for (const step of job.steps) if (step.env) step.env = { ...FORGE_TOKEN_ENV };
    }
    files.push({ name: `${spec.name}-resume.yml`, yaml: emitOpPipelineYAML(resume) });
  }
  if (plansDoc) files.push({ name: `${spec.name}-plans.yml`, yaml: emitOpPipelineYAML(forgejoWorkflowDoc(plansDoc, dialectOptions)) });
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
