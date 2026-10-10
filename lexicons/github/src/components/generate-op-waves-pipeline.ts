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
 */

import { opWaveJobs, type OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions, OpWavesPipelineResult } from "@intentius/chant/lexicon";
import { actionRef } from "../action-pins";
import {
  assertEnvironment,
  assertSetupSteps,
  emitOpPipelineYAML,
  type GithubOpPipelineDoc,
} from "./generate-op-pipeline";

/** The default image: it carries git, which the runner needs to read the base commit. */
export const OP_WAVES_IMAGE = "node:22";

/** The artifact a wide wave's deciding job hands its share jobs. */
export function opWaveRecordArtifact(spec: Pick<OpWavesSpec, "name">, wave: number): string {
  return `${spec.name}-wave-${wave}-decision`;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "." : path.slice(0, i);
}

/** The workflow document, before emission, and the jobs it holds. */
export function buildGithubOpWavesDoc(
  spec: OpWavesSpec,
  options: OpWavesPipelineOptions,
): { doc: GithubOpPipelineDoc; jobs: OpWavesPipelineResult["jobs"] } {
  const jobs = opWaveJobs(spec, options.specFile);
  const image = options.image ?? OP_WAVES_IMAGE;
  for (const wave of spec.waves) {
    assertSetupSteps(`${spec.name}/${wave.name}`, wave.setup ?? []);
    if (wave.environment) assertEnvironment(`${spec.name}/${wave.name}`, wave.environment);
  }

  const jobsDoc: Record<string, unknown> = {};
  for (const job of jobs) {
    const wave = spec.waves[job.wave - 1]!;
    const steps: Array<Record<string, unknown>> = [{ uses: actionRef("actions/checkout"), with: { "fetch-depth": 0 } }];
    if (job.kind === "share") {
      steps.push({
        name: `Download wave ${job.wave}'s decision`,
        uses: "actions/download-artifact@v4",
        with: { name: opWaveRecordArtifact(spec, job.wave), path: dirOf(job.record!) },
      });
    }
    for (const step of wave.setup ?? []) steps.push({ ...step });
    for (const line of options.beforeScript ?? []) steps.push({ run: line });
    steps.push({ name: describeJob(job.kind, job.wave, wave.name, job.share), run: job.command.join(" ") });
    for (const line of options.extraScript ?? []) steps.push({ run: line });
    if (job.kind === "decide") {
      steps.push({
        name: `Keep wave ${job.wave}'s decision`,
        if: "always()",
        uses: "actions/upload-artifact@v4",
        with: {
          name: opWaveRecordArtifact(spec, job.wave),
          path: job.record!,
          "if-no-files-found": "ignore",
          "include-hidden-files": true,
          overwrite: true,
        },
      });
    }
    jobsDoc[job.jobName] = {
      "runs-on": "ubuntu-latest",
      ...(job.needs.length > 0 ? { needs: job.needs } : {}),
      container: image,
      ...(wave.environment
        ? { environment: { name: wave.environment.name, ...(wave.environment.url ? { url: wave.environment.url } : {}) } }
        : {}),
      ...(wave.variables && Object.keys(wave.variables).length > 0 ? { env: wave.variables } : {}),
      steps,
    };
  }

  const doc: GithubOpPipelineDoc = {
    name: spec.name,
    on: { push: { branches: spec.branches?.length ? spec.branches : ["main"] }, workflow_dispatch: {} },
    ...(options.variables && Object.keys(options.variables).length > 0 ? { env: options.variables } : {}),
    concurrency: { group: spec.name, "cancel-in-progress": false },
    permissions: { contents: "write" },
    jobsDoc,
  };
  return { doc, jobs };
}

function describeJob(kind: "wave" | "decide" | "share", wave: number, name: string, share?: number): string {
  if (kind === "decide") return `Plan wave ${wave} (${name}) and decide its gate`;
  if (kind === "share") return `Apply share ${share} of wave ${wave} (${name})`;
  return `Plan, gate and apply wave ${wave} (${name})`;
}

/** Render an Op waves spec as one GitHub Actions workflow, `<name>.yml`. */
export function generateGithubOpWavesPipeline(spec: OpWavesSpec, options: OpWavesPipelineOptions): OpWavesPipelineResult {
  const { doc, jobs } = buildGithubOpWavesDoc(spec, options);
  return { files: [{ name: `${spec.name}.yml`, yaml: emitOpPipelineYAML(doc) }], jobs };
}
