/**
 * Op waves → GitLab CI (#3679).
 *
 * One file, one stage per wave, on a push to the spec's branches. Each job is
 * one of core's `opWaveJobs`, and `needs:` chains them so a wave that waits at
 * its gate (exit 3) or fails stops every later wave; retrying the failed job
 * after `chant approve` carries on. `GIT_DEPTH: "0"` gives the runner the base
 * commit it reads the gate policy at. A wide wave's deciding job keeps its
 * decision as an artifact, which GitLab hands each share job through `needs:`.
 * A wave's `environment` is the job's own `environment:`; protect it in the
 * project settings to put a reviewer in front of the job as well.
 */

import { emitYAMLEntry } from "@intentius/chant/yaml";
import { opWaveJobs, type OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions, OpWavesPipelineResult } from "@intentius/chant/lexicon";

/** The default image: it carries git, which the runner needs to read the base commit. */
const OP_WAVES_IMAGE = "node:22";

/** Render an Op waves spec as one GitLab CI file, `<name>.gitlab-ci.yml` unless `opsFileName` names another. */
export function generateGitlabOpWavesPipeline(spec: OpWavesSpec, options: OpWavesPipelineOptions): OpWavesPipelineResult {
  const jobs = opWaveJobs(spec, options.specFile);
  const image = options.image ?? OP_WAVES_IMAGE;
  const branches = spec.branches?.length ? spec.branches : ["main"];
  for (const branch of branches) {
    if (/["$\\]/.test(branch) || branch.trim() === "") {
      throw new Error(`Op waves "${spec.name}" filters on branch "${branch}", which cannot go in a GitLab rules: expression.`);
    }
  }
  const rules = branches.map((branch) => ({ if: `$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "${branch}"` }));

  const stages = spec.waves.map((wave, i) => `wave-${i + 1}-${wave.name}`);
  const sections: string[] = [emitYAMLEntry("stages", stages)];
  if (options.variables && Object.keys(options.variables).length > 0) sections.push(emitYAMLEntry("variables", options.variables));
  for (const job of jobs) {
    const wave = spec.waves[job.wave - 1]!;
    const setup = (wave.setup ?? []).map((step, index) => {
      if ("uses" in step) {
        throw new Error(
          `Op waves "${spec.name}" wave "${wave.name}" setup step ${index + 1} is \`uses: "${step.uses}"\`, a GitHub ` +
            `Actions marketplace action. GitLab CI runs script lines only; express it as a { run } entry.`,
        );
      }
      return step.run;
    });
    sections.push(
      emitYAMLEntry(job.jobName, {
        stage: stages[job.wave - 1],
        image,
        resource_group: `${spec.name}-${wave.name}`,
        ...(wave.environment
          ? { environment: { name: wave.environment.name, ...(wave.environment.url ? { url: wave.environment.url } : {}) } }
          : {}),
        variables: { GIT_DEPTH: "0", ...(wave.variables ?? {}) },
        rules,
        ...(job.needs.length > 0 ? { needs: job.needs } : {}),
        script: [...setup, ...(options.beforeScript ?? []), job.command.join(" "), ...(options.extraScript ?? [])],
        ...(job.kind === "decide" ? { artifacts: { when: "always", paths: [job.record!], expire_in: "30 days" } } : {}),
      }),
    );
  }
  const header = [
    `# chant Op waves "${spec.name}" (#3679): one stage per wave, each needing the one before.`,
    "# A wave that waits at its gate exits 3 and stops the waves after it; approve the",
    "# digest it prints, then retry the job.",
  ];
  const name = options.opsFileName ?? `${spec.name}.gitlab-ci.yml`;
  return { files: [{ name, yaml: header.join("\n") + "\n\n" + sections.join("\n\n") + "\n" }], jobs };
}
