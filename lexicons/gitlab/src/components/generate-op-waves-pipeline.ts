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
 *
 * `runner` (on the spec, a wave or a job group, #3914) is the job's `tags:`; a
 * GitHub runner group is a spec error here. A wave's `jobs` renders its
 * deciding job with the wave's own settings and a job per group (per share of
 * a group) with the group's: its tags, environment, variables over the
 * wave's, setup after the wave's, and `id_tokens:` from its `idTokens`.
 */

import {
  assertGitlabBranch,
  assertGitlabEnvironment,
  assertRunnerLabels,
  CI_IMAGE,
  environmentDoc,
  GITLAB_FULL_HISTORY,
  GITLAB_MERGE_REQUEST_SOURCE,
  GITLAB_SCHEDULE_SOURCE,
  gitlabIdTokensDoc,
  gitlabPushRule,
  gitlabSetupScript,
  gitlabTags,
  nonEmpty,
  pushBranches,
} from "@intentius/chant/ci-jobs";
import { opWaveGroupOf, opWaveJobs, opWavesResumeCommand, type OpWavesSpec } from "@intentius/chant/op/op-waves";
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
  // #3914: GitLab picks a runner by tags, and each job group carries its own setup and environment.
  assertRunnerLabels(subject, "runner", spec.runner, "GitLab");
  const groupSetup = new Map<string, string[]>();
  for (const wave of spec.waves) {
    assertRunnerLabels(subject, `wave "${wave.name}" runner`, wave.runner, "GitLab");
    for (const group of wave.jobs ?? []) {
      assertRunnerLabels(subject, `wave "${wave.name}" job group "${group.name}" runner`, group.runner, "GitLab");
      if (group.environment) assertGitlabEnvironment(`${spec.name}/${wave.name}/${group.name}`, group.environment);
      groupSetup.set(`${wave.name}/${group.name}`, gitlabSetupScript(`${subject} wave "${wave.name}" job group "${group.name}"`, group.setup));
    }
  }
  const specTags = gitlabTags(spec.runner);

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
        ...(specTags ? { tags: specTags } : {}),
        variables: { ...GITLAB_FULL_HISTORY },
        rules: [{ if: GITLAB_MERGE_REQUEST_SOURCE }],
        script: [...(options.beforeScript ?? []), ["chant", "run", "wave", "--spec", options.specFile, "--record-plans"].join(" ")],
      },
    ]);
  }
  for (const job of jobs) {
    const wave = spec.waves[job.wave - 1]!;
    const group = opWaveGroupOf(spec, job);
    const setup = [...setupOf[job.wave - 1]!, ...(group ? groupSetup.get(`${wave.name}/${group.name}`)! : [])];
    const tags = gitlabTags(group?.runner ?? wave.runner ?? spec.runner);
    const environment = group?.environment ?? wave.environment;
    const idTokens = gitlabIdTokensDoc(group?.idTokens ?? wave.idTokens);
    entries.push([
      job.jobName,
      {
        stage: stages[job.wave - 1 + (byReview ? 1 : 0)],
        image,
        ...(tags ? { tags } : {}),
        resource_group: `${spec.name}-${wave.name}`,
        ...(environment ? { environment: environmentDoc(environment) } : {}),
        ...(idTokens ? { id_tokens: idTokens } : {}),
        variables: { ...GITLAB_FULL_HISTORY, ...(wave.variables ?? {}), ...(group?.variables ?? {}) },
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
        ...(specTags ? { tags: specTags } : {}),
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
