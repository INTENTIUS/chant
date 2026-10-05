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

import { emitYAMLEntry } from "@intentius/chant/yaml";
import { resolveComponentGraph, type DriverComponent } from "@intentius/chant/components/driver";
import { hasPublishStep, promoteArchivePaths } from "@intentius/chant/components/promote";
import { GATED_WAVE_RECORD, gatedWaveJobs } from "@intentius/chant/components/gated-wave-pipeline";
import { PR_APPLY_RECORD, PR_LOOP_IMAGE, PR_LOOP_REPORT_DIR, prApplyGroup, prApplyRecordKey, prLoopJobs, prLoopSetup } from "@intentius/chant/components/pr-pipeline";
import { memberGitlabChanges, memberRepoPath, memberShellDir } from "@intentius/chant/lexicon";
import type {
  ComponentPipelineJob as GeneratedJob,
  ComponentPipelineOptions as GenerateGitlabOptions,
  ComponentPipelineResult as GenerateGitlabResult,
  PipelineMember,
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
  const image = options.image ?? (options.prLoop || options.gatedWaves ? PR_LOOP_IMAGE : DEFAULT_IMAGE);
  const runCommand = options.runCommand ?? ["chant", "run", "--components", "{name}", "--env", env];
  const beforeScript = options.beforeScript ?? [];
  const extraScript = options.extraScript ?? [];

  const { waves } = resolveComponentGraph(components);
  const byName = new Map(components.map((c) => [c.name, c]));

  if (options.prLoop) {
    if (options.gatedWaves || options.promoteTo !== undefined) {
      throw new Error("a pull-request pipeline has no wave or promote jobs; drop --wave-gate and --promote-to, or --pr-loop");
    }
    return prLoopGitlabPipeline(env, image, beforeScript, extraScript, options);
  }

  if (options.gatedWaves) {
    if (options.promoteTo !== undefined) throw new Error("a gated-wave pipeline has no promote job; drop --promote-to or --wave-gate");
    return gatedWaveGitlabPipeline(components, env, image, beforeScript, extraScript, options);
  }

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

  if (options.member) {
    promoteJob = scopeToMember(doc, jobs, promoteJob, options.member, env);
  }

  const sections: string[] = [];
  sections.push(emitYAMLEntry("workflow", doc.workflow));
  // The promote stage is YAML only: `stages` in the result stays one entry
  // per graph wave.
  const yamlStages = promoteJob ? [...stages, "promote"] : stages;
  sections.push(emitYAMLEntry("stages", yamlStages));
  if (doc.variables) sections.push(emitYAMLEntry("variables", doc.variables));
  for (const job of jobs) {
    const props = doc[job.jobName] as Record<string, unknown>;
    sections.push(emitYAMLEntry(job.jobName, props));
  }
  if (promoteJob) sections.push(emitYAMLEntry(promoteJob, doc[promoteJob]));

  return { yaml: sections.join("\n\n") + "\n", stages, jobs, env };
}

/**
 * The gated-wave pipeline (#3049): one job per wave, each running one wave of
 * `chant components fan-out --wave-gate`, in order through `needs:`. The
 * attempt record is the artifact GitLab hands from job to job, kept even when
 * a job stops at a gate (exit 3) so the re-run after `chant approve` reads it.
 * `GIT_DEPTH: "0"` gives the job the history `--base` diffs against.
 */
function gatedWaveGitlabPipeline(
  components: DriverComponent[],
  env: string,
  image: string,
  beforeScript: string[],
  extraScript: string[],
  options: GenerateGitlabOptions,
): GenerateGitlabResult {
  const waveJobs = gatedWaveJobs(components, env, options.gatedWaves!);
  const stages = waveJobs.map((j) => j.jobName);
  const doc: Record<string, unknown> = {
    workflow: { name: `chant-components-${env}` },
    stages,
    variables: { ...options.variables, CHANT_ENV: env },
  };
  const jobs: GeneratedJob[] = [];
  for (const job of waveJobs) {
    jobs.push({ jobName: job.jobName, component: `wave ${job.wave}`, stage: job.jobName, needs: job.needs });
    doc[job.jobName] = {
      stage: job.jobName,
      image,
      variables: { GIT_DEPTH: "0" },
      script: [...prLoopSetup(image), ...beforeScript, job.command.join(" "), ...extraScript],
      ...(job.needs.length > 0 ? { needs: job.needs } : {}),
      artifacts: { when: "always", paths: [GATED_WAVE_RECORD] },
    };
  }
  if (options.member) scopeToMember(doc, jobs, undefined, options.member, env);
  const sections = [
    emitYAMLEntry("workflow", doc.workflow),
    emitYAMLEntry("stages", stages),
    emitYAMLEntry("variables", doc.variables),
    ...jobs.map((job) => emitYAMLEntry(job.jobName, doc[job.jobName])),
  ];
  return { yaml: sections.join("\n\n") + "\n", stages, jobs, env };
}

/**
 * The merge-request pipeline (#3183): `plan` in each merge request pipeline,
 * `apply` on each push to the target branch, one apply at a time per
 * environment (`resource_group`). `GIT_DEPTH: "0"` gives both the history
 * they measure the change with. The jobs talk to GitLab with
 * `CHANT_FORGE_TOKEN`, a project or group access token with the `api` scope
 * set as a masked CI/CD variable, since a job token cannot write notes.
 *
 * For a workspace member (#3465) the file is one the root `.gitlab-ci.yml`
 * includes, so the jobs are `<member>-plan` and `<member>-apply`, each
 * script starts with a `cd` into the member's directory and the report
 * artifact is kept from there. The jobs take no `changes:` rule, since a
 * change outside the member can reach it; the plan selects from the whole
 * change and passes `--member`, which keeps the member's gate, note and
 * statuses apart from the other members'. The apply's resource group is the
 * member's own.
 *
 * The apply job keeps its attempt record in the job cache under the pushed
 * commit, uploaded whether the job passed or failed, so a retry of a failed
 * apply passes it to `pr-apply --resume` (#3543). GitLab keeps protected
 * branches' caches apart from other branches' by default, so a merge request
 * pipeline cannot write the record the target branch's apply reads.
 */
function prLoopGitlabPipeline(
  env: string,
  image: string,
  beforeScript: string[],
  extraScript: string[],
  options: GenerateGitlabOptions,
): GenerateGitlabResult {
  const loop = options.prLoop!;
  const member = options.member;
  const rooted = !member || member.dir === "." || member.dir === "";
  const [plan, apply] = prLoopJobs("gitlab", env, loop, member?.name);
  const reportPath = member ? memberRepoPath(member, PR_LOOP_REPORT_DIR) : PR_LOOP_REPORT_DIR;
  const planJob = member ? `${member.name}-plan` : "plan";
  const applyJob = member ? `${member.name}-apply` : "apply";
  const onMergeRequest = '$CI_PIPELINE_SOURCE == "merge_request_event"';
  const target = loop.branch ? JSON.stringify(loop.branch) : "$CI_DEFAULT_BRANCH";
  const onMerge = `$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == ${target}`;
  // A member's jobs start in its directory, after the image's install lines.
  const enter = rooted ? [] : [`cd ${memberShellDir(member!)}`];
  const script = (job: typeof plan): string[] => [...prLoopSetup(image), ...enter, ...beforeScript, ...(job.setup ?? []), job.command, ...extraScript];
  const stages = ["plan", "apply"];
  const doc: Record<string, unknown> = {
    workflow: { name: member ? `chant-pr-${member.name}-${env}` : `chant-pr-${env}`, rules: [{ if: onMergeRequest }, { if: onMerge }] },
    stages,
    variables: { ...options.variables, CHANT_ENV: env, GIT_DEPTH: "0" },
    [planJob]: {
      stage: "plan",
      image,
      rules: [{ if: onMergeRequest }],
      variables: plan.env,
      script: script(plan),
      artifacts: { when: "always", paths: [reportPath] },
    },
    [applyJob]: {
      stage: "apply",
      image,
      resource_group: prApplyGroup(env, member?.name),
      rules: [{ if: onMerge }],
      variables: apply.env,
      script: script(apply),
      // The attempt record (#3543), kept under the pushed commit even when
      // the job fails, so a retry finishes the apply under the same approval.
      cache: {
        key: prApplyRecordKey(env, "$CI_COMMIT_SHA", member?.name),
        paths: [member ? memberRepoPath(member, PR_APPLY_RECORD) : PR_APPLY_RECORD],
        when: "always",
      },
      artifacts: { when: "always", paths: [reportPath] },
    },
  };
  const jobs: GeneratedJob[] = [
    { jobName: planJob, component: "merge request plan", stage: "plan", needs: [] },
    { jobName: applyJob, component: "merge request apply", stage: "apply", needs: [] },
  ];
  const sections = ["workflow", "stages", "variables", planJob, applyJob].map((key) => emitYAMLEntry(key, doc[key]));
  return { yaml: sections.join("\n\n") + "\n", stages, jobs, env };
}

/**
 * Scope a pipeline to one workspace member (#2542, #2524 D19), in place on
 * `doc` and `jobs`. Returns the promote job's new name.
 *
 * GitLab reads one `.gitlab-ci.yml`, so a member's pipeline is a file that
 * the root file includes, and job names share one namespace across every
 * included file. Each job therefore takes the member's name as a prefix. A
 * `rules: changes:` entry limits each job to changes under the member's
 * directory or to the pipeline file; for a member at `"."` there is no such
 * rule, since `changes` has no exclusions. Each job's script starts with a
 * `cd` into the member's directory, and artifact paths, which GitLab resolves
 * against the repository root, move under it.
 */
function scopeToMember(
  doc: Record<string, unknown>,
  jobs: GeneratedJob[],
  promoteJob: string | undefined,
  member: PipelineMember,
  env: string,
): string | undefined {
  const rooted = member.dir === "." || member.dir === "";
  const changes = memberGitlabChanges(member);
  const renamed = new Map<string, string>();
  for (const job of jobs) renamed.set(job.jobName, `${member.name}-${job.jobName}`);
  if (promoteJob) renamed.set(promoteJob, `${member.name}-${promoteJob}`);

  for (const [from, to] of renamed) {
    const props = doc[from] as Record<string, unknown>;
    delete doc[from];
    const next: Record<string, unknown> = { ...props };
    if (!rooted) next.script = [`cd ${memberShellDir(member)}`, ...(props.script as string[])];
    if (Array.isArray(props.needs)) next.needs = (props.needs as string[]).map((n) => renamed.get(n) ?? n);
    const artifacts = props.artifacts as { paths?: string[] } | undefined;
    if (artifacts?.paths) next.artifacts = { ...artifacts, paths: artifacts.paths.map((p) => memberRepoPath(member, p)) };
    if (changes) next.rules = [{ changes }];
    doc[to] = next;
  }
  for (const job of jobs) {
    job.jobName = renamed.get(job.jobName)!;
    job.needs = job.needs.map((n) => renamed.get(n) ?? n);
  }
  doc.workflow = { name: `chant-components-${member.name}-${env}` };
  return promoteJob ? renamed.get(promoteJob) : undefined;
}
