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
 *
 * With `resume` on the spec (#3683), a `<name>-resume` job runs `chant run
 * resume --op <name>` in scheduled pipelines only: create a pipeline schedule
 * with the spec's cron. It retries a waiting wave's job once its approval
 * arrived, with `CHANT_FORGE_TOKEN` (a project access token with the `api`
 * scope and the Developer role; the job token cannot retry jobs).
 *
 * A `pr-review` wave (#3684) adds `<name>-record-plans`, run in merge request
 * pipelines only, which records the digests the merge request's head plans.
 */

import {
  assertGitlabBranch,
  assertGitlabEnvironment,
  CI_IMAGE,
  environmentDoc,
  GITLAB_FULL_HISTORY,
  GITLAB_MERGE_REQUEST_SOURCE,
  GITLAB_SCHEDULE_SOURCE,
  gitlabPushRule,
  gitlabSetupScript,
  nonEmpty,
  pushBranches,
} from "@intentius/chant/ci-jobs";
import { opWaveJobs, opWavesResumeCommand, type OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { OpWavesPipelineOptions, OpWavesPipelineResult } from "@intentius/chant/lexicon";
import { emitGitlabFile } from "./ci-jobs";

/** Render an Op waves spec as one GitLab CI file, `<name>.gitlab-ci.yml` unless `opsFileName` names another. */
export function generateGitlabOpWavesPipeline(spec: OpWavesSpec, options: OpWavesPipelineOptions): OpWavesPipelineResult {
  const jobs = opWaveJobs(spec, options.specFile);
  const image = options.image ?? CI_IMAGE;
  const subject = `Op waves "${spec.name}"`;
  const rules = pushBranches(spec.branches).map((branch) => {
    assertGitlabBranch(subject, branch);
    return { if: gitlabPushRule(JSON.stringify(branch)) };
  });
  // The setup and environment each wave's jobs carry, checked as an Op's are.
  const setupOf = spec.waves.map((wave) => gitlabSetupScript(`${subject} wave "${wave.name}"`, wave.setup));
  for (const wave of spec.waves) if (wave.environment) assertGitlabEnvironment(`${spec.name}/${wave.name}`, wave.environment);

  const byReview = spec.waves.some((w) => w.approval === "pr-review");
  const stages = [...(byReview ? ["plans"] : []), ...spec.waves.map((wave, i) => `wave-${i + 1}-${wave.name}`)];
  if (spec.resume) stages.push("resume");
  const entries: Array<readonly [string, unknown]> = [["stages", stages]];
  const variables = nonEmpty("variables", options.variables).variables;
  if (variables) entries.push(["variables", variables]);
  if (byReview) {
    entries.push([
      `${spec.name}-record-plans`,
      {
        stage: "plans",
        image,
        variables: { ...GITLAB_FULL_HISTORY },
        rules: [{ if: GITLAB_MERGE_REQUEST_SOURCE }],
        script: [...(options.beforeScript ?? []), ["chant", "run", "wave", "--spec", options.specFile, "--record-plans"].join(" ")],
      },
    ]);
  }
  for (const job of jobs) {
    const wave = spec.waves[job.wave - 1]!;
    const setup = setupOf[job.wave - 1]!;
    entries.push([
      job.jobName,
      {
        stage: stages[job.wave - 1 + (byReview ? 1 : 0)],
        image,
        resource_group: `${spec.name}-${wave.name}`,
        ...(wave.environment ? { environment: environmentDoc(wave.environment) } : {}),
        variables: { ...GITLAB_FULL_HISTORY, ...(wave.variables ?? {}) },
        rules,
        ...(job.needs.length > 0 ? { needs: job.needs } : {}),
        script: [...setup, ...(options.beforeScript ?? []), job.command.join(" "), ...(options.extraScript ?? [])],
        ...(job.kind === "decide" ? { artifacts: { when: "always", paths: [job.record!], expire_in: "30 days" } } : {}),
      },
    ]);
  }
  if (spec.resume) {
    entries.push([
      `${spec.name}-resume`,
      {
        stage: "resume",
        image,
        rules: [{ if: GITLAB_SCHEDULE_SOURCE }],
        script: [...(options.beforeScript ?? []), opWavesResumeCommand(spec).join(" ")],
      },
    ]);
  }
  const header = [
    `# chant Op waves "${spec.name}": one stage per wave, each needing the one before.`,
    "# A wave that waits at its gate exits 3 and stops the waves after it; approve the",
    "# digest it prints, then retry the job.",
    ...(spec.resume
      ? [`# The ${spec.name}-resume job retries it for you in a pipeline schedule; give the schedule the cron "${spec.resume.schedule}".`]
      : []),
  ];
  const name = options.opsFileName ?? `${spec.name}.gitlab-ci.yml`;
  return { files: [{ name, yaml: emitGitlabFile(entries, header) }], jobs };
}
