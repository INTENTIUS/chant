/**
 * Op waves → GitHub Actions workflow (#3679).
 *
 * One workflow for the whole spec, on a push to its branches (and by hand),
 * one run at a time. Each job is one of core's `opWaveJobs`: a wave, or a wide
 * wave's deciding job and share jobs, chained by `needs:` so a wave that waits
 * at its gate (exit 3) or fails stops every later wave. Re-running the failed
 * jobs after `chant approve` carries on from that wave.
 *
 * Every job checks out the full history, because the runner reads the gate
 * policy from the spec file at the base commit and records pending gates on
 * `chant/lifecycle`, which is why the workflow asks for `contents: write`. A
 * deciding job uploads its decision, even when it waits, and each share job
 * downloads it. The forgejo generator reuses {@link buildGithubOpWavesDoc}
 * and applies its dialect.
 *
 * With `resume` on the spec (#3683), a second workflow, `<name>-resume.yml`,
 * runs `chant run resume --op <name>` on that schedule: it re-runs the failed
 * jobs of a run whose waiting wave has been approved since, with the job's
 * token and `actions: write`.
 *
 * When a wave's approval is `pr-review` (#3684), the workflow also asks for
 * `pull-requests: read`, so a wave can read the merged pull request's
 * reviews, and a second workflow, `<name>-plans.yml`, runs `chant run wave
 * --record-plans` on each pull request to record the digests its head plans.
 *
 * With `notify` on the spec (#3761), the workflow maps each variable it names
 * from the repository secret of the same name, so a wave job can post to
 * Slack, Teams or a signed webhook. `options.variables` wins over the mapping.
 *
 * `runner` (on the spec, a wave or a job group, #3914) is the job's `runs-on`.
 * A wave's `jobs` renders its deciding job with the wave's own settings and a
 * job per group (per share of a group) with the group's: its runner,
 * environment, variables over the wave's, setup after the wave's, and id
 * tokens. A job with id tokens gets `permissions:` of its own, the
 * workflow's plus `id-token: write`, and each audience as `<NAME>_AUDIENCE`.
 */

import { notifyVariables, opWaveGroupOf, opWaveJobs, opWavesResumeCommand, type OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions, OpWavesPipelineResult } from "@intentius/chant/lexicon";
import {
  assertEnvironment,
  assertSetupSteps,
  CI_IMAGE,
  dirnameOf,
  environmentDoc,
  GITHUB_JOB_TOKEN,
  githubRunsOn,
  githubSecretEnv,
  idTokenAudienceEnv,
  nonEmpty,
  pushBranches,
  setupStepDoc,
} from "@intentius/chant/ci-jobs";
import { checkoutStep, concurrency, downloadArtifactStep, keepRecordStep, runSteps } from "./ci-jobs";
import { emitOpPipelineYAML, type GithubOpPipelineDoc } from "./generate-op-pipeline";

/** The default image: it carries git, which the runner needs to read the base commit. */
export const OP_WAVES_IMAGE = CI_IMAGE;

/** The artifact a wide wave's deciding job hands its share jobs. */
export function opWaveRecordArtifact(spec: Pick<OpWavesSpec, "name">, wave: number): string {
  return `${spec.name}-wave-${wave}-decision`;
}

/** The workflow document, before emission, and the jobs it holds. */
export function buildGithubOpWavesDoc(
  spec: OpWavesSpec,
  options: OpWavesPipelineOptions,
): { doc: GithubOpPipelineDoc; jobs: OpWavesPipelineResult["jobs"]; resumeDoc?: GithubOpPipelineDoc; plansDoc?: GithubOpPipelineDoc } {
  const jobs = opWaveJobs(spec, options.specFile);
  const image = options.image ?? OP_WAVES_IMAGE;
  const byReview = spec.waves.some((w) => w.approval === "pr-review");
  for (const wave of spec.waves) {
    assertSetupSteps(`${spec.name}/${wave.name}`, wave.setup ?? []);
    if (wave.environment) assertEnvironment(`${spec.name}/${wave.name}`, wave.environment);
    for (const group of wave.jobs ?? []) {
      assertSetupSteps(`${spec.name}/${wave.name}/${group.name}`, group.setup ?? []);
      if (group.environment) assertEnvironment(`${spec.name}/${wave.name}/${group.name}`, group.environment);
    }
  }
  const permissions = { contents: "write", ...(byReview ? { "pull-requests": "read" } : {}) };

  const jobsDoc: Record<string, unknown> = {};
  for (const job of jobs) {
    const wave = spec.waves[job.wave - 1]!;
    // #3914: a job group's job runs with the group's settings over the wave's.
    const group = opWaveGroupOf(spec, job);
    const steps: Array<Record<string, unknown>> = [checkoutStep(true)];
    if (job.kind === "share") {
      steps.push(downloadArtifactStep(`Download wave ${job.wave}'s decision`, opWaveRecordArtifact(spec, job.wave), dirnameOf(job.record!)));
    }
    steps.push(...[...(wave.setup ?? []), ...(group?.setup ?? [])].map(setupStepDoc), ...runSteps(options.beforeScript ?? []));
    steps.push({ name: describeJob(job.kind, job.wave, wave.name, job.share, job.group), run: job.command.join(" ") });
    steps.push(...runSteps(options.extraScript ?? []));
    if (job.kind === "decide") {
      steps.push(keepRecordStep(`Keep wave ${job.wave}'s decision`, opWaveRecordArtifact(spec, job.wave), job.record!));
    }
    const environment = group?.environment ?? wave.environment;
    const idTokens = group?.idTokens ?? wave.idTokens;
    jobsDoc[job.jobName] = {
      "runs-on": githubRunsOn(group?.runner ?? wave.runner ?? spec.runner),
      ...(job.needs.length > 0 ? { needs: job.needs } : {}),
      container: image,
      ...(environment ? { environment: environmentDoc(environment) } : {}),
      // #3914: a job's own permissions replace the workflow's, so they repeat them.
      ...(idTokens ? { permissions: { ...permissions, "id-token": "write" } } : {}),
      ...nonEmpty("env", group || idTokens ? { ...wave.variables, ...group?.variables, ...idTokenAudienceEnv(idTokens) } : wave.variables),
      steps,
    };
  }

  // #3761: the notify variables come from the secrets of the same name.
  const env = { ...githubSecretEnv(notifyVariables(spec.notify)), ...(options.variables ?? {}) };
  const doc: GithubOpPipelineDoc = {
    name: spec.name,
    on: { push: { branches: pushBranches(spec.branches) }, workflow_dispatch: {} },
    ...nonEmpty("env", env),
    concurrency: concurrency(spec.name),
    permissions,
    jobsDoc,
  };
  return {
    doc,
    jobs,
    ...(spec.resume ? { resumeDoc: buildResumeDoc(spec, options) } : {}),
    ...(byReview ? { plansDoc: buildPlansDoc(spec, options) } : {}),
  };
}

/** The scheduled resume workflow (#3683). */
function buildResumeDoc(spec: OpWavesSpec, options: OpWavesPipelineOptions): GithubOpPipelineDoc {
  const steps: Array<Record<string, unknown>> = [checkoutStep(), ...runSteps(options.beforeScript ?? [])];
  steps.push({
    name: `Resume the waves of ${spec.name} whose approval arrived`,
    run: opWavesResumeCommand(spec).join(" "),
    env: { GITHUB_TOKEN: GITHUB_JOB_TOKEN },
  });
  return {
    name: `${spec.name}-resume`,
    on: { schedule: [{ cron: spec.resume!.schedule }], workflow_dispatch: {} },
    concurrency: concurrency(`${spec.name}-resume`, true),
    // contents: read fetches chant/lifecycle; actions: write re-runs a waiting run.
    permissions: { contents: "read", actions: "write" },
    jobsDoc: { resume: { "runs-on": githubRunsOn(spec.runner), container: options.image ?? OP_WAVES_IMAGE, steps } },
  };
}

/** The pull request workflow a `pr-review` wave needs (#3684): record the digests each head plans. */
function buildPlansDoc(spec: OpWavesSpec, options: OpWavesPipelineOptions): GithubOpPipelineDoc {
  const steps: Array<Record<string, unknown>> = [checkoutStep(true), ...(spec.waves[0]?.setup ?? []).map(setupStepDoc), ...runSteps(options.beforeScript ?? [])];
  steps.push({ name: "Plan every wave at the head and record its digests", run: ["chant", "run", "wave", "--spec", options.specFile, "--record-plans"].join(" ") });
  return {
    name: `${spec.name}-plans`,
    on: { pull_request: { branches: pushBranches(spec.branches) } },
    ...nonEmpty("env", options.variables),
    concurrency: concurrency(spec.name + "-plans-${{ github.event.number }}", true),
    // contents: write pushes the record to chant/lifecycle.
    permissions: { contents: "write" },
    jobsDoc: { "record-plans": { "runs-on": githubRunsOn(spec.runner), container: options.image ?? OP_WAVES_IMAGE, steps } },
  };
}

function describeJob(kind: "wave" | "decide" | "share", wave: number, name: string, share?: number, group?: string): string {
  if (kind === "decide") return `Plan wave ${wave} (${name}) and decide its gate`;
  if (group !== undefined) return `Apply ${share !== undefined ? `share ${share} of ` : ""}job group ${group} of wave ${wave} (${name})`;
  if (kind === "share") return `Apply share ${share} of wave ${wave} (${name})`;
  return `Plan, gate and apply wave ${wave} (${name})`;
}

/** Render an Op waves spec as one GitHub Actions workflow, `<name>.yml`. */
export function generateGithubOpWavesPipeline(spec: OpWavesSpec, options: OpWavesPipelineOptions): OpWavesPipelineResult {
  const { doc, jobs, resumeDoc, plansDoc } = buildGithubOpWavesDoc(spec, options);
  const files = [{ name: `${spec.name}.yml`, yaml: emitOpPipelineYAML(doc) }];
  if (resumeDoc) files.push({ name: `${spec.name}-resume.yml`, yaml: emitOpPipelineYAML(resumeDoc) });
  if (plansDoc) files.push({ name: `${spec.name}-plans.yml`, yaml: emitOpPipelineYAML(plansDoc) });
  return { files, jobs };
}
