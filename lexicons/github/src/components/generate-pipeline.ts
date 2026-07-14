/**
 * Generate mode — component → GitHub Actions workflow YAML (#891, epic #885).
 *
 * The github counterpart to the gitlab generator (`../../gitlab/src/components/generate-pipeline.ts`,
 * #563/#688): the same `chant build --components --generate <lexicon>` seam,
 * synthesizing a **thin** `.github/workflows/*.yml` from the discovered
 * component graph instead of interpreting it directly.
 *
 * The generated workflow is a trigger, not the deploy logic:
 *  - Ordering + parallel-safe waves are resolved once, generically, by
 *    `resolveComponentGraph` (core's driver) — the exact function the local
 *    interpret driver and the gitlab generator both use. This module does not
 *    re-derive or duplicate that graph logic.
 *  - GitHub Actions has no `stage` concept, so wave ordering is expressed
 *    entirely through `needs:` edges between jobs: one job per component,
 *    with `needs:` pointing at the jobs for its direct `dependsOn` entries.
 *    Independent components therefore run in parallel, and dependents wait
 *    on their dependencies via GitHub's own `needs:` scheduling.
 *    `ComponentPipelineResult.stages` is still populated with the wave-ordered
 *    names (one per wave) purely for parity with gitlab's machine-readable
 *    `--format json` view — GitHub's YAML itself has no `stages:` section.
 *  - Each job's trigger step is exactly one invocation that hands off to the
 *    component's own composition (`chant run --components <name> ...` by
 *    default) — never inlined build/publish/apply steps. The deploy logic
 *    lives in the component's `deploy` phases and the capabilities they
 *    reference, not in this YAML.
 *  - A component that something else depends on can't hand its resolved
 *    stack outputs to a dependent in-memory, since each job is a separate
 *    GitHub Actions runner. It dumps its outputs to a file and uploads that
 *    file as a workflow artifact (`actions/upload-artifact`); each direct
 *    dependent downloads it (`actions/download-artifact`) and seeds from it,
 *    so a `stackOutput()` / `@<dep>.publish.*` reference still resolves even
 *    though the producer ran in a different job. This mirrors the dump/seed
 *    model `cli-support.ts` (`runComponents`'s `componentOutputs`) already
 *    uses, and matches gitlab's artifact-passing 1:1 in intent — only the
 *    transport differs (explicit upload/download steps vs. GitLab's implicit
 *    `needs:` artifact passing).
 *
 * Cross-cutting changes (e.g. "sign every image before deploy") are made by
 * editing `GenerateGithubOptions.extraScript`/`beforeScript` (or the
 * component's own composition) ONCE here — never per generated job. See
 * `generate-pipeline.test.ts`'s "cross-cutting change" cases for a
 * demonstration: one generator-option edit reflects in every job without
 * touching the component declarations.
 */

import { emitYAML } from "@intentius/chant/yaml";
import { resolveComponentGraph, type DriverComponent } from "@intentius/chant/components/driver";
import type {
  ComponentPipelineJob as GeneratedJob,
  ComponentPipelineOptions as GenerateGithubOptions,
  ComponentPipelineResult as GenerateGithubResult,
} from "@intentius/chant/lexicon";

export type { GeneratedJob, GenerateGithubOptions, GenerateGithubResult };

/** GitHub Actions job ids must match `[a-zA-Z_][a-zA-Z0-9_-]*`; component names are already kebab-case in every fixture, but normalize defensively (mirrors gitlab's `toJobName`). */
function toJobName(componentName: string): string {
  return componentName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

const DEFAULT_IMAGE = "node:22-slim";

/** The file a producer dumps its resolved outputs to, and a dependent seeds from — one per component, matching gitlab's naming so both generators produce interchangeable artifacts. */
function outputsFile(name: string): string {
  return `${name}.outputs.json`;
}

/** The workflow artifact name a producer's dumped outputs are uploaded under. */
function artifactName(name: string): string {
  return `${name}-outputs`;
}

/**
 * Synthesize a `.github/workflows/*.yml` pipeline from a set of components:
 * one job per component, `needs:` expressing the wave-ordered dependency DAG
 * from `resolveComponentGraph`. Throws `DependencyCycleError`/
 * `UnknownDependencyError` (from core's driver) exactly like the interpret
 * driver and the gitlab generator do, since all three consume the same graph
 * resolution. Wired into core's generate mode via the github lexicon plugin's
 * `generateComponentPipeline` (../plugin.ts).
 */
export function generateGithubPipeline(
  components: DriverComponent[],
  options: GenerateGithubOptions = {},
): GenerateGithubResult {
  const env = options.env ?? "production";
  const image = options.image ?? DEFAULT_IMAGE;
  const runCommand = options.runCommand ?? ["chant", "run", "--components", "{name}", "--env", env];
  const beforeScript = options.beforeScript ?? [];
  const extraScript = options.extraScript ?? [];

  const { waves } = resolveComponentGraph(components);
  const byName = new Map(components.map((c) => [c.name, c]));

  // Components that something else depends on must hand their resolved outputs
  // (stack outputs, published artifact refs) to their dependents, which run as
  // separate jobs on separate runners. Each such producer dumps its outputs to
  // a file and uploads it as a workflow artifact; each dependent downloads that
  // artifact and seeds from it, so a `stackOutput()` / `@<dep>.publish.*`
  // reference resolves even though the producer ran in a different job.
  // Without this, a single-component job has no in-memory outputs for its
  // dependencies — see epic #551 / the adopt-alb-services example.
  const dependedUpon = new Set<string>();
  for (const c of components) for (const dep of c.dependsOn ?? []) dependedUpon.add(dep);

  const stages = waves.map((_, i) => `wave-${i + 1}`);
  const jobs: GeneratedJob[] = [];
  const jobNameByComponent = new Map<string, string>();
  for (const wave of waves) {
    for (const name of wave) jobNameByComponent.set(name, toJobName(name));
  }

  const jobsDoc: Record<string, unknown> = {};

  waves.forEach((wave, waveIndex) => {
    const stage = stages[waveIndex];
    for (const name of wave) {
      const component = byName.get(name)!;
      const jobName = jobNameByComponent.get(name)!;
      const needs = (component.dependsOn ?? []).map((dep) => jobNameByComponent.get(dep)!).sort();

      jobs.push({ jobName, component: name, stage, needs });

      // Build the run invocation, then append output-threading flags: seed from
      // each dependency's dumped outputs (downloaded as an artifact below), and
      // dump this component's own outputs if a dependent will need them.
      const runParts = runCommand.map((part) => part.replace("{name}", name));
      for (const dep of component.dependsOn ?? []) runParts.push("--seed-outputs", outputsFile(dep));
      if (dependedUpon.has(name)) runParts.push("--dump-outputs", outputsFile(name));

      // One step per script line — mirrors gitlab's `script:` array of
      // discrete shell lines, rather than a single multi-line `run:` block, so
      // each line is independently inspectable (and machine-parseable).
      const steps: Array<Record<string, unknown>> = [{ uses: "actions/checkout@v4" }];

      for (const dep of component.dependsOn ?? []) {
        steps.push({
          name: `Download ${dep} outputs`,
          uses: "actions/download-artifact@v4",
          with: { name: artifactName(dep), path: "." },
        });
      }

      for (const line of beforeScript) steps.push({ run: line });
      steps.push({ run: runParts.join(" ") });
      for (const line of extraScript) steps.push({ run: line });

      if (dependedUpon.has(name)) {
        steps.push({
          name: `Upload ${name} outputs`,
          uses: "actions/upload-artifact@v4",
          with: { name: artifactName(name), path: outputsFile(name) },
        });
      }

      const jobProps: Record<string, unknown> = {
        "runs-on": "ubuntu-latest",
        ...(needs.length > 0 ? { needs } : {}),
        container: image,
        steps,
      };
      jobsDoc[jobName] = jobProps;
    }
  });

  const sections: string[] = [];
  sections.push("on:" + emitYAML({ workflow_dispatch: {} }, 1));
  if (options.variables && Object.keys(options.variables).length > 0) {
    sections.push("env:" + emitYAML(options.variables, 1));
  }
  sections.push("jobs:" + emitYAML(jobsDoc, 1));

  return { yaml: sections.join("\n\n") + "\n", stages, jobs };
}
