/**
 * Generate mode — component → GitLab CI YAML (#563, epic #551, Phase 3).
 *
 * The other half of "two modes, both anti-sprawl" (see
 * docs/src/content/docs/components/orchestration.mdx#generate-mode and epic
 * #551 §"5. Orchestrator → generate mode"): interpret mode (`../driver.ts`,
 * #556) runs components directly; generate mode synthesizes a **thin**
 * `.gitlab-ci.yml` from the same declarations for teams who want plain CI as
 * the trigger/runner.
 *
 * The generated pipeline is a trigger, not the deploy logic:
 *  - Ordering + parallel-safe waves are resolved once, generically, by
 *    `resolveComponentGraph` (../driver.ts) — the exact function the local
 *    interpret driver uses. Generate mode does not re-derive or duplicate
 *    that graph logic.
 *  - Each wave becomes one GitLab CI `stage`; every component in a wave
 *    becomes one job in that stage, so independent components run in
 *    parallel and dependents wait for their dependencies via natural stage
 *    ordering (mirrored explicitly with `needs:` for direct edges, so GitLab
 *    can still parallelize across non-adjacent stages when safe).
 *  - Each job's `script` is exactly one invocation that hands off to the
 *    component's own composition (`chant run --components <name> ...` by
 *    default) — never inlined build/publish/apply steps. The deploy logic
 *    lives in the component's `deploy` phases and the capabilities they
 *    reference, not in this YAML.
 *
 * Cross-cutting changes (e.g. "sign every image before deploy") are made by
 * editing `GenerateGitlabOptions.extraScript`/`beforeScript` (or the
 * component's own composition) ONCE here — never per generated job. See
 * `generate-gitlab.test.ts`'s "cross-cutting change" case for a
 * demonstration: one generator-option edit reflects in every job without
 * touching the component declarations.
 */

import { emitYAML } from "@intentius/chant/yaml";
import { resolveComponentGraph, type DriverComponent } from "@intentius/chant/components/driver";
import type {
  ComponentPipelineJob as GeneratedJob,
  ComponentPipelineOptions as GenerateGitlabOptions,
  ComponentPipelineResult as GenerateGitlabResult,
} from "@intentius/chant/lexicon";

export type { GeneratedJob, GenerateGitlabOptions, GenerateGitlabResult };

/** GitLab CI job names must be safe YAML keys; component names are already kebab-case in every fixture, but normalize defensively. */
function toJobName(componentName: string): string {
  return componentName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

const DEFAULT_IMAGE = "node:22-slim";

/**
 * Synthesize a `.gitlab-ci.yml` pipeline from a set of components: one stage
 * per parallel-safe wave (`resolveComponentGraph`), one thin trigger job per
 * component. Throws `DependencyCycleError`/`UnknownDependencyError` (from
 * core's driver) exactly like the interpret driver does, since both consume
 * the same graph resolution. Wired into core's generate mode via the gitlab
 * lexicon plugin's `generateComponentPipeline` (../plugin.ts).
 */
export function generateGitlabPipeline(
  components: DriverComponent[],
  options: GenerateGitlabOptions = {},
): GenerateGitlabResult {
  const env = options.env ?? "production";
  const image = options.image ?? DEFAULT_IMAGE;
  const runCommand = options.runCommand ?? ["chant", "run", "--components", "{name}", "--env", env];
  const beforeScript = options.beforeScript ?? [];
  const extraScript = options.extraScript ?? [];

  const { waves } = resolveComponentGraph(components);
  const byName = new Map(components.map((c) => [c.name, c]));

  const stages = waves.map((_, i) => `wave-${i + 1}`);
  const jobs: GeneratedJob[] = [];
  const jobNameByComponent = new Map<string, string>();
  for (const wave of waves) {
    for (const name of wave) jobNameByComponent.set(name, toJobName(name));
  }

  const doc: Record<string, unknown> = {};
  doc.stages = stages;
  if (options.variables && Object.keys(options.variables).length > 0) {
    doc.variables = options.variables;
  }

  waves.forEach((wave, waveIndex) => {
    const stage = stages[waveIndex];
    for (const name of wave) {
      const component = byName.get(name)!;
      const jobName = jobNameByComponent.get(name)!;
      const needs = (component.dependsOn ?? []).map((dep) => jobNameByComponent.get(dep)!).sort();

      jobs.push({ jobName, component: name, stage, needs });

      const script = [
        ...beforeScript,
        runCommand.map((part) => part.replace("{name}", name)).join(" "),
        ...extraScript,
      ];

      const jobProps: Record<string, unknown> = {
        stage,
        image,
        script,
      };
      if (needs.length > 0) jobProps.needs = needs;
      doc[jobName] = jobProps;
    }
  });

  const sections: string[] = [];
  sections.push("stages:" + emitYAML(stages, 1));
  if (doc.variables) sections.push("variables:" + emitYAML(doc.variables, 1));
  for (const job of jobs) {
    const props = doc[job.jobName] as Record<string, unknown>;
    sections.push(`${job.jobName}:` + emitYAML(props, 1));
  }

  return { yaml: sections.join("\n\n") + "\n", stages, jobs };
}
