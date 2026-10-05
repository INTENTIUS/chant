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
 *  - With `options.promoteTo` (#2575), one more job needs every component
 *    job and runs `chant components promote`. A promote publishes from the
 *    build archive on disk, so each component job uploads the files its
 *    build steps wrote and the promote job downloads them to the same paths.
 *    Each component job with a publish step also writes the digest its run
 *    recorded (`--digest-file`) to a job output, and the promote job passes
 *    it back as `--digest <component>=<digest>` (#2602), so it promotes the
 *    release this run built rather than whatever is latest in the source
 *    environment.
 *  - For a workspace member (`options.member`, #2542) the workflow keeps its
 *    triggers, and its `run:` steps start in the member's directory. See
 *    `scopeToMember`.
 *
 * Cross-cutting changes (e.g. "sign every image before deploy") are made by
 * editing `GenerateGithubOptions.extraScript`/`beforeScript` (or the
 * component's own composition) ONCE here — never per generated job. See
 * `generate-pipeline.test.ts`'s "cross-cutting change" cases for a
 * demonstration: one generator-option edit reflects in every job without
 * touching the component declarations.
 */

import { emitYAML, emitYAMLEntry } from "@intentius/chant/yaml";
import { resolveComponentGraph, type DriverComponent } from "@intentius/chant/components/driver";
import { hasPublishStep, promoteArchivePaths } from "@intentius/chant/components/promote";
import { GATED_WAVE_RECORD, gatedWaveJobs } from "@intentius/chant/components/gated-wave-pipeline";
import { PR_APPLY_RECORD, PR_LOOP_IMAGE, PR_LOOP_REPORT_DIR, prApplyGroup, prApplyRecordKey, prLoopJobs, prLoopSetup } from "@intentius/chant/components/pr-pipeline";
import { memberRepoPath } from "@intentius/chant/lexicon";
import type {
  ComponentPipelineJob as GeneratedJob,
  ComponentPipelineOptions as GenerateGithubOptions,
  ComponentPipelineResult as GenerateGithubResult,
  PipelineMember,
} from "@intentius/chant/lexicon";
import { actionRef } from "../action-pins";

export type { GeneratedJob, GenerateGithubOptions, GenerateGithubResult };

/**
 * The structured pipeline document behind {@link generateGithubPipeline}: the
 * `on`/`env`/`jobs` mappings plus the machine-readable `stages`/`jobs` views,
 * before YAML emission. Exposed so a GitHub-Actions dialect (the forgejo
 * lexicon, #969) can reuse the exact job/`needs:`/artifact structure and only
 * apply its dialect transform + emit, rather than re-deriving the graph.
 */
export interface GithubPipelineDoc {
  /**
   * The workflow's `name:` — `chant-components-<env>` (#2046), so two
   * pipelines generated for two environments are tellable apart in the
   * committed file, the Actions UI, and the API without lexing a job's
   * `run:` line.
   */
  name: string;
  /** The environment the pipeline deploys — `options.env` with the default applied (#2046). */
  environment: string;
  /** The `on:` trigger mapping (a bare `workflow_dispatch`). */
  on: Record<string, unknown>;
  /** The workflow's `defaults:`, set only for a workspace member: its jobs' `run:` steps start in the member's directory (#2542). */
  defaults?: Record<string, unknown>;
  /**
   * The `env:` mapping: the caller's `variables`, plus `CHANT_ENV` naming the
   * deployed environment (#2046) — the machine-readable identity on the
   * document itself. `CHANT_ENV` always reflects the environment baked into
   * the run lines, so a caller-supplied variable of the same name cannot make
   * the document lie about what its jobs deploy.
   */
  env?: Record<string, unknown>;
  /** The `jobs:` mapping — one entry per component. */
  jobsDoc: Record<string, unknown>;
  /** Wave-ordered stage names (parity with gitlab's `--format json`). */
  stages: string[];
  /** Every generated job, for the machine-readable view. */
  jobs: GeneratedJob[];
}

/** The workflow artifact the gated-wave jobs hand their attempt record through, one per wave. */
function waveRecordArtifact(wave: number): string {
  return `fan-out-record-wave-${wave}`;
}

/**
 * The gated-wave workflow (#3049): one job per wave, each running one wave of
 * `chant components fan-out --wave-gate`, chained by `needs:`. Each job
 * downloads the record the job before it uploaded and uploads its own, even
 * when it stops at a gate (exit 3), so re-running it after `chant approve`
 * reads the record. The checkout fetches full history for `--base`.
 */
function gatedWaveGithubDoc(
  components: DriverComponent[],
  env: string,
  image: string,
  beforeScript: string[],
  extraScript: string[],
  options: GenerateGithubOptions,
): GithubPipelineDoc {
  const waveJobs = gatedWaveJobs(components, env, options.gatedWaves!);
  const jobsDoc: Record<string, unknown> = {};
  const jobs: GeneratedJob[] = [];
  for (const job of waveJobs) {
    jobs.push({ jobName: job.jobName, component: `wave ${job.wave}`, stage: job.jobName, needs: job.needs });
    const steps: Array<Record<string, unknown>> = [{ uses: actionRef("actions/checkout"), with: { "fetch-depth": 0 } }];
    if (job.wave > 1) {
      steps.push({
        name: `Download the record wave ${job.wave - 1} left`,
        uses: "actions/download-artifact@v4",
        with: { name: waveRecordArtifact(job.wave - 1), path: dirnameOf(GATED_WAVE_RECORD) },
      });
    }
    for (const line of prLoopSetup(image)) steps.push({ run: line });
    for (const line of beforeScript) steps.push({ run: line });
    steps.push({ run: job.command.join(" ") });
    for (const line of extraScript) steps.push({ run: line });
    steps.push({
      name: `Upload the record for wave ${job.wave}`,
      if: "always()",
      uses: "actions/upload-artifact@v4",
      with: {
        name: waveRecordArtifact(job.wave),
        path: GATED_WAVE_RECORD,
        "if-no-files-found": "ignore",
        "include-hidden-files": true,
        overwrite: true,
      },
    });
    jobsDoc[job.jobName] = {
      "runs-on": "ubuntu-latest",
      ...(job.needs.length > 0 ? { needs: job.needs } : {}),
      container: image,
      steps,
    };
  }
  const doc: GithubPipelineDoc = {
    name: `chant-components-${env}`,
    environment: env,
    on: { workflow_dispatch: {} },
    env: { ...options.variables, CHANT_ENV: env },
    jobsDoc,
    stages: waveJobs.map((j) => j.jobName),
    jobs,
  };
  return options.member ? scopeToMember(doc, options.member) : doc;
}

/**
 * The pull-request workflow (#3183): `plan` on each pull request into the
 * target branch, `apply` on each push to it. The plan job can comment and set
 * statuses but cannot push, since it runs the pull request's code; the apply
 * job can push, to record a pending fact on `chant/lifecycle`, and runs one
 * at a time per environment. Both keep their report as an artifact, and both
 * check out the full history, since each measures the change with git.
 * The apply job restores its attempt record from the cache before it runs
 * and saves it afterwards, failed or not, so a re-run of a failed apply
 * finishes it under the same approval (#3543).
 *
 * For a workspace member (#3465) the run steps start in the member's
 * directory and the report artifact is kept from there. The triggers take no
 * path filter, since a change outside the member can reach it; the plan
 * selects from the whole change and passes `--member`, which keeps the
 * member's gate, note and statuses apart from the other members'.
 */
function prLoopGithubDoc(
  env: string,
  image: string,
  beforeScript: string[],
  extraScript: string[],
  options: GenerateGithubOptions,
): GithubPipelineDoc {
  const loop = options.prLoop!;
  const branch = loop.branch ?? "main";
  const member = options.member;
  const rooted = !member || member.dir === "." || member.dir === "";
  const [plan, apply] = prLoopJobs(loop.forge ?? "github", env, loop, member?.name);
  const reportPath = member ? memberRepoPath(member, PR_LOOP_REPORT_DIR) : PR_LOOP_REPORT_DIR;
  // The apply's attempt record (#3543) lives in the cache under the pushed
  // commit. Cache keys cannot be overwritten, so each attempt saves under
  // its run and attempt, and a re-run restores the newest for the commit.
  const recordPath = member ? memberRepoPath(member, PR_APPLY_RECORD) : PR_APPLY_RECORD;
  const recordPrefix = `${prApplyRecordKey(env, "${{ github.sha }}", member?.name)}-`;
  const recordKey = `${recordPrefix}\${{ github.run_id }}-\${{ github.run_attempt }}`;
  const restoreRecord = {
    name: "Restore the record of an earlier attempt at this commit",
    uses: "actions/cache/restore@v4",
    with: { path: recordPath, key: recordKey, "restore-keys": recordPrefix },
  };
  const saveRecord = {
    name: "Keep the record for a re-run",
    if: "always()",
    uses: "actions/cache/save@v4",
    with: { path: recordPath, key: recordKey },
  };
  const steps = (job: typeof plan, name: string): Array<Record<string, unknown>> => [
    { uses: actionRef("actions/checkout"), with: { "fetch-depth": 0 } },
    ...prLoopSetup(image).map((line) => ({ run: line })),
    ...beforeScript.map((line) => ({ run: line })),
    ...(job.jobName === "apply" ? [restoreRecord] : []),
    { name, env: job.env, run: job.command },
    ...extraScript.map((line) => ({ run: line })),
    ...(job.jobName === "apply" ? [saveRecord] : []),
    {
      name: `Keep the ${job.jobName} report`,
      if: "always()",
      uses: "actions/upload-artifact@v4",
      with: { name: `chant-pr-${job.jobName}`, path: reportPath, "if-no-files-found": "ignore", "include-hidden-files": true },
    },
  ];
  const jobsDoc: Record<string, unknown> = {
    plan: {
      if: "github.event_name == 'pull_request'",
      "runs-on": "ubuntu-latest",
      container: image,
      permissions: { contents: "read", "pull-requests": "write", statuses: "write" },
      steps: steps(plan, "Plan the members this pull request reaches"),
    },
    apply: {
      if: "github.event_name == 'push'",
      "runs-on": "ubuntu-latest",
      container: image,
      concurrency: { group: prApplyGroup(env, member?.name), "cancel-in-progress": false },
      permissions: { contents: "write", "pull-requests": "write", statuses: "write" },
      steps: steps(apply, "Apply the plan a reviewer approved"),
    },
  };
  return {
    name: member ? `chant-pr-${member.name}-${env}` : `chant-pr-${env}`,
    environment: env,
    on: { pull_request: { branches: [branch] }, push: { branches: [branch] } },
    ...(rooted ? {} : { defaults: { run: { "working-directory": member!.dir } } }),
    env: { ...options.variables, CHANT_ENV: env },
    jobsDoc,
    stages: ["plan", "apply"],
    jobs: [
      { jobName: "plan", component: "pull request plan", stage: "plan", needs: [] },
      { jobName: "apply", component: "pull request apply", stage: "apply", needs: [] },
    ],
  };
}

/** The directory part of a relative path, `.` when there is none. */
function dirnameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "." : path.slice(0, i);
}

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

/** The file a component job writes the digest its run recorded to, for the promote job (#2602). */
function digestFile(name: string): string {
  return `${name}.digest`;
}

/** The workflow artifact name a component's build archive is uploaded under, for the promote job (#2575). */
function archiveArtifactName(name: string): string {
  return `${name}-archive`;
}

/**
 * The directory `actions/upload-artifact` roots a set of files at: the
 * deepest directory that holds all of them. Downloading into it puts each
 * file back at the path it was uploaded from.
 */
export function artifactRoot(paths: string[]): string {
  const dirs = paths.map((p) => {
    const parts = p.replace(/\/+$/, "").split("/");
    parts.pop();
    return parts.filter((part) => part !== "" && part !== ".");
  });
  const common: string[] = [];
  for (let i = 0; dirs.every((d) => i < d.length && d[i] === dirs[0][i]); i++) common.push(dirs[0][i]);
  const absolute = paths.every((p) => p.startsWith("/"));
  if (common.length === 0) return absolute ? "/" : ".";
  return (absolute ? "/" : "") + common.join("/");
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
export function buildGithubPipelineDoc(
  components: DriverComponent[],
  options: GenerateGithubOptions = {},
): GithubPipelineDoc {
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
    return prLoopGithubDoc(env, image, beforeScript, extraScript, options);
  }

  if (options.gatedWaves) {
    if (options.promoteTo !== undefined) throw new Error("a gated-wave pipeline has no promote job; drop --promote-to or --wave-gate");
    return gatedWaveGithubDoc(components, env, image, beforeScript, extraScript, options);
  }

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

  // A promote job (#2575) runs on its own runner, and a promote publishes from
  // the build archive on disk, so each component job uploads the files its
  // build steps wrote and the promote job downloads them.
  const promoteTo = options.promoteTo;
  const archives = new Map<string, string[]>();
  // The components the promote job pins to this run's digest (#2602): those
  // with a publish step, the only ones whose deploy records a release.
  const pinned = new Set<string>();
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
      if (pinned.has(name)) runParts.push("--digest-file", digestFile(name));

      // One step per script line — mirrors gitlab's `script:` array of
      // discrete shell lines, rather than a single multi-line `run:` block, so
      // each line is independently inspectable (and machine-parseable).
      const steps: Array<Record<string, unknown>> = [{ uses: actionRef("actions/checkout") }];

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

      // The file holds `<component>=<digest>`; the job output holds the digest.
      if (pinned.has(name)) {
        steps.push({
          name: `Record ${name} digest`,
          id: "digest",
          run: `echo "digest=$(cut -d= -f2- ${digestFile(name)})" >> "$GITHUB_OUTPUT"`,
        });
      }

      if (dependedUpon.has(name)) {
        steps.push({
          name: `Upload ${name} outputs`,
          uses: "actions/upload-artifact@v4",
          with: { name: artifactName(name), path: outputsFile(name) },
        });
      }

      const archive = archives.get(name);
      if (archive) {
        steps.push({
          name: `Upload ${name} build archive`,
          uses: "actions/upload-artifact@v4",
          with: {
            name: archiveArtifactName(name),
            path: archive.join("\n"),
            "if-no-files-found": "error",
            "include-hidden-files": true,
          },
        });
      }

      const jobProps: Record<string, unknown> = {
        "runs-on": "ubuntu-latest",
        ...(needs.length > 0 ? { needs } : {}),
        container: image,
        ...(pinned.has(name) ? { outputs: { digest: "${{ steps.digest.outputs.digest }}" } } : {}),
        steps,
      };
      jobsDoc[jobName] = jobProps;
    }
  });

  if (promoteTo !== undefined) {
    const promoteJob = `promote-${toJobName(promoteTo)}`;
    if (promoteJob in jobsDoc) {
      throw new Error(`the promote job "${promoteJob}" has the same name as a component job; rename the component`);
    }
    const command = [...(options.promoteCommand ?? ["chant", "components", "promote", "--from", env, "--to", promoteTo])];
    for (const name of [...pinned].sort()) {
      command.push("--digest", `"${name}=\${{ needs.${jobNameByComponent.get(name)!}.outputs.digest }}"`);
    }
    const steps: Array<Record<string, unknown>> = [{ uses: actionRef("actions/checkout") }];
    for (const [name, paths] of archives) {
      steps.push({
        name: `Download ${name} build archive`,
        uses: "actions/download-artifact@v4",
        with: { name: archiveArtifactName(name), path: artifactRoot(paths) },
      });
    }
    for (const line of beforeScript) steps.push({ run: line });
    steps.push({ run: command.join(" ") });
    for (const line of extraScript) steps.push({ run: line });
    jobsDoc[promoteJob] = {
      "runs-on": "ubuntu-latest",
      needs: [...jobNameByComponent.values()].sort(),
      container: image,
      steps,
    };
  }

  const doc: GithubPipelineDoc = {
    name: `chant-components-${env}`,
    environment: env,
    on: { workflow_dispatch: {} },
    env: { ...options.variables, CHANT_ENV: env },
    jobsDoc,
    stages,
    jobs,
  };
  return options.member ? scopeToMember(doc, options.member) : doc;
}

/**
 * Scope a pipeline to one workspace member (#2542, #2524 D19). Its name
 * carries the member's name, and every `run:` step starts in the member's
 * directory through `defaults.run.working-directory`.
 *
 * The triggers stay exactly the plain pipeline's. A deploy pipeline gains no
 * `push` or `pull_request` trigger for a member, and its only trigger,
 * `workflow_dispatch`, takes no `paths:` filter.
 *
 * `working-directory` applies to `run:` steps only. The artifact actions
 * resolve `path` against the repository root, so each upload and download
 * path moves under the member's directory, where the `run:` steps read and
 * write the files.
 */
function scopeToMember(doc: GithubPipelineDoc, member: PipelineMember): GithubPipelineDoc {
  const rooted = member.dir === "." || member.dir === "";
  const jobsDoc: Record<string, unknown> = {};
  for (const [name, job] of Object.entries(doc.jobsDoc)) {
    const props = job as { steps?: Array<Record<string, unknown>> };
    jobsDoc[name] = rooted || !props.steps ? job : { ...props, steps: props.steps.map((step) => memberArtifactStep(step, member)) };
  }
  return {
    ...doc,
    name: `chant-components-${member.name}-${doc.environment}`,
    ...(rooted ? {} : { defaults: { run: { "working-directory": member.dir } } }),
    jobsDoc,
  };
}

/** An `actions/upload-artifact` or `download-artifact` step with its `path` moved under the member's directory. */
function memberArtifactStep(step: Record<string, unknown>, member: PipelineMember): Record<string, unknown> {
  const uses = typeof step.uses === "string" ? step.uses : "";
  if (!/^actions\/(upload|download)-artifact@/.test(uses)) return step;
  const withProps = step.with as Record<string, unknown> | undefined;
  if (!withProps || typeof withProps.path !== "string") return step;
  const path = withProps.path
    .split("\n")
    .map((line) => memberRepoPath(member, line))
    .join("\n");
  return { ...step, with: { ...withProps, path } };
}

/**
 * Emit a `GithubPipelineDoc`'s `on`/`env`/`jobs` mappings as workflow YAML.
 * Shared with the forgejo dialect (#969), which transforms the doc first.
 */
export function emitPipelineYAML(doc: GithubPipelineDoc): string {
  const sections: string[] = [];
  sections.push("name: " + emitYAML(doc.name, 0));
  sections.push(emitYAMLEntry("on", doc.on));
  if (doc.env && Object.keys(doc.env).length > 0) {
    sections.push(emitYAMLEntry("env", doc.env));
  }
  if (doc.defaults) sections.push(emitYAMLEntry("defaults", doc.defaults));
  sections.push(emitYAMLEntry("jobs", doc.jobsDoc));
  return sections.join("\n\n") + "\n";
}

/**
 * Synthesize a `.github/workflows/*.yml` pipeline from a set of components:
 * one job per component, `needs:` expressing the wave-ordered dependency DAG
 * from `resolveComponentGraph`. Thin wrapper over {@link buildGithubPipelineDoc}
 * + {@link emitPipelineYAML}.
 */
export function generateGithubPipeline(
  components: DriverComponent[],
  options: GenerateGithubOptions = {},
): GenerateGithubResult {
  const doc = buildGithubPipelineDoc(components, options);
  return { yaml: emitPipelineYAML(doc), stages: doc.stages, jobs: doc.jobs, env: doc.environment };
}
