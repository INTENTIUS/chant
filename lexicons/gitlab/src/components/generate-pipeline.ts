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
import { hasPublishStep, promoteArchivePaths } from "@intentius/chant/components/promote";
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

  // Components that something else depends on must hand their resolved outputs
  // (stack outputs, published artifact refs) to their dependents, which run as
  // separate jobs/processes. Each such producer dumps its outputs to a file and
  // declares it a job artifact; each dependent seeds from that file (delivered
  // across the `needs:` edge by GitLab's artifact passing) so a `stackOutput()`
  // / `@<dep>.publish.*` reference resolves even though the producer ran in a
  // different job. Without this, a single-component job has no in-memory outputs
  // for its dependencies — see epic #551 / the adopt-alb-services example.
  const dependedUpon = new Set<string>();
  for (const c of components) for (const dep of c.dependsOn ?? []) dependedUpon.add(dep);
  const outputsFile = (name: string) => `${name}.outputs.json`;

  // A promote job (#2575) runs apart from the deploy jobs, and a promote
  // publishes from the build archive on disk, so each component job keeps the
  // files its build steps wrote as artifacts. GitLab hands them to the promote
  // job across its `needs:` edges. Each component job with a publish step
  // also keeps the digest its run recorded (`--digest-file`), and the promote
  // job passes it back as `--digest <component>=<digest>` (#2602), so it
  // promotes the release this run built rather than whatever is latest in the
  // source environment.
  const promoteTo = options.promoteTo;
  const archives = new Map<string, string[]>();
  const pinned = new Set<string>();
  const digestFile = (name: string) => `${name}.digest`;
  if (promoteTo !== undefined) {
    for (const c of components) {
      const paths = promoteArchivePaths(c);
      if (paths.length > 0) archives.set(c.name, paths);
      if (hasPublishStep(c)) pinned.add(c.name);
    }
    if (pinned.size === 0) {
      throw new Error("no component has a publish step, so no deploy records a release for the promote job to promote");
    }
  }

  const stages = waves.map((_, i) => `wave-${i + 1}`);
  const jobs: GeneratedJob[] = [];
  const jobNameByComponent = new Map<string, string>();
  for (const wave of waves) {
    for (const name of wave) jobNameByComponent.set(name, toJobName(name));
  }

  const doc: Record<string, unknown> = {};
  // `workflow:name` + a CHANT_ENV variable give the document a recoverable
  // environment identity (#2046): two pipelines generated for two
  // environments were previously identical except for one shell argument in
  // each job's `script:`. CHANT_ENV always reflects the environment baked
  // into the run lines, so a caller-supplied variable of the same name cannot
  // make the document lie about what its jobs deploy.
  doc.workflow = { name: `chant-components-${env}` };
  doc.stages = stages;
  doc.variables = { ...options.variables, CHANT_ENV: env };

  waves.forEach((wave, waveIndex) => {
    const stage = stages[waveIndex];
    for (const name of wave) {
      const component = byName.get(name)!;
      const jobName = jobNameByComponent.get(name)!;
      const needs = (component.dependsOn ?? []).map((dep) => jobNameByComponent.get(dep)!).sort();

      jobs.push({ jobName, component: name, stage, needs });

      // Build the run invocation, then append output-threading flags: seed from
      // each dependency's dumped outputs, and dump this component's own outputs
      // if a dependent will need them.
      const runParts = runCommand.map((part) => part.replace("{name}", name));
      for (const dep of component.dependsOn ?? []) runParts.push("--seed-outputs", outputsFile(dep));
      if (dependedUpon.has(name)) runParts.push("--dump-outputs", outputsFile(name));
      if (pinned.has(name)) runParts.push("--digest-file", digestFile(name));

      const script = [...beforeScript, runParts.join(" "), ...extraScript];

      const jobProps: Record<string, unknown> = {
        stage,
        image,
        script,
      };
      if (needs.length > 0) jobProps.needs = needs;
      // Publish this component's dumped outputs so dependent jobs receive it.
      const artifactPaths = [
        ...(dependedUpon.has(name) ? [outputsFile(name)] : []),
        ...(archives.get(name) ?? []),
        ...(pinned.has(name) ? [digestFile(name)] : []),
      ];
      if (artifactPaths.length > 0) jobProps.artifacts = { paths: artifactPaths };
      doc[jobName] = jobProps;
    }
  });

  let promoteJob: string | undefined;
  if (promoteTo !== undefined) {
    promoteJob = `promote-${toJobName(promoteTo)}`;
    if (promoteJob in doc) {
      throw new Error(`the promote job "${promoteJob}" has the same name as a component job; rename the component`);
    }
    const command = [...(options.promoteCommand ?? ["chant", "components", "promote", "--from", env, "--to", promoteTo])];
    // The file holds `<component>=<digest>`; a missing or empty one leaves
    // `<component>=`, which the promote refuses.
    for (const name of [...pinned].sort()) {
      command.push("--digest", `"${name}=$(cut -d= -f2- ${digestFile(name)})"`);
    }
    doc[promoteJob] = {
      stage: "promote",
      image,
      script: [...beforeScript, command.join(" "), ...extraScript],
      needs: [...jobNameByComponent.values()].sort(),
    };
  }

  const sections: string[] = [];
  // `emitYAML` returns a `\n`-led block for a non-empty sequence and an inline
  // `[]` for an empty one, so the header needs a space in the second case.
  // `stages:[]` is the plain scalar "stages:[]" — a colon opens a mapping only
  // when whitespace or the line's end follows it — which is how GitLab's own
  // reader takes it, and now how `parseYAML` does too (chant #2013).
  sections.push("workflow:" + emitYAML(doc.workflow, 1));
  // The promote stage is YAML only: `stages` in the result stays one entry
  // per graph wave.
  const yamlStages = promoteJob ? [...stages, "promote"] : stages;
  sections.push(yamlStages.length > 0 ? "stages:" + emitYAML(yamlStages, 1) : "stages: []");
  if (doc.variables) sections.push("variables:" + emitYAML(doc.variables, 1));
  for (const job of jobs) {
    const props = doc[job.jobName] as Record<string, unknown>;
    sections.push(`${job.jobName}:` + emitYAML(props, 1));
  }
  if (promoteJob) sections.push(`${promoteJob}:` + emitYAML(doc[promoteJob], 1));

  return { yaml: sections.join("\n\n") + "\n", stages, jobs, env };
}
