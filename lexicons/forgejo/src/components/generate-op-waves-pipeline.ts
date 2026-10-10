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
 */

import { buildGithubOpWavesDoc } from "@intentius/chant-lexicon-github/components/generate-op-waves-pipeline";
import { emitOpPipelineYAML, type GithubOpPipelineDoc } from "@intentius/chant-lexicon-github/components/generate-op-pipeline";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions, OpWavesPipelineResult } from "@intentius/chant/lexicon";
import { transformWorkflowObject, type ForgejoDialectOptions } from "../dialect";

function forgejoize(value: Record<string, unknown>, dialect: ForgejoDialectOptions): Record<string, unknown> {
  return transformWorkflowObject(value, dialect).value as Record<string, unknown>;
}

/** Render an Op waves spec as one Forgejo Actions workflow, `<name>.yml`. */
export function generateForgejoOpWavesPipeline(
  spec: OpWavesSpec,
  options: OpWavesPipelineOptions,
  dialectOptions: ForgejoDialectOptions = {},
): OpWavesPipelineResult {
  const { doc, jobs, resumeDoc } = buildGithubOpWavesDoc(spec, options);
  const jobsDoc = Object.fromEntries(
    Object.entries(doc.jobsDoc).map(([name, job]) => {
      const { environment: _dropped, ...rest } = job as Record<string, unknown>;
      return [name, rest];
    }),
  );
  const dropped = spec.waves.filter((w) => w.environment).map((w) => `${w.name} -> ${w.environment!.name}`);
  const forgejoDoc: GithubOpPipelineDoc = {
    ...(dropped.length > 0
      ? {
          header: [
            `# chant dropped the environment of each of these waves: ${dropped.join(", ")}.`,
            "# Forgejo Actions has no environments, so nothing on the forge holds these jobs.",
            "# Each wave's own chant gate does: it records a pending fact on chant/lifecycle",
            "# and the wave exits 3 until `chant approve` approves its set digest.",
          ],
        }
      : {}),
    name: doc.name,
    on: forgejoize(doc.on, dialectOptions),
    ...(doc.env ? { env: forgejoize(doc.env, dialectOptions) } : {}),
    concurrency: forgejoize(doc.concurrency, dialectOptions),
    permissions: {},
    jobsDoc: forgejoize(jobsDoc, dialectOptions),
  };
  const files = [{ name: `${spec.name}.yml`, yaml: emitOpPipelineYAML(forgejoDoc) }];
  if (resumeDoc) {
    const resumeJobs = forgejoize(resumeDoc.jobsDoc, dialectOptions) as Record<string, { steps: Array<Record<string, unknown>> }>;
    for (const job of Object.values(resumeJobs)) {
      for (const step of job.steps) if (step.env) step.env = { CHANT_FORGE_TOKEN: "${{ secrets.CHANT_FORGE_TOKEN }}" };
    }
    files.push({
      name: `${spec.name}-resume.yml`,
      yaml: emitOpPipelineYAML({
        name: resumeDoc.name!,
        on: forgejoize(resumeDoc.on, dialectOptions),
        concurrency: forgejoize(resumeDoc.concurrency, dialectOptions),
        permissions: {},
        jobsDoc: resumeJobs,
      }),
    });
  }
  return { files, jobs };
}
