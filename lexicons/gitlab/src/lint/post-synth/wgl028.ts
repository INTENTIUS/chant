/**
 * WGL028: Redundant Needs
 *
 * Detects `needs:` entries that list jobs already implied by stage ordering.
 * While not incorrect, redundant needs add noise and make the pipeline
 * harder to maintain. This is informational only.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractStages, extractJobs } from "./yaml-helpers";

export function checkRedundantNeeds(yaml: string): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  const stages = extractStages(yaml);
  if (stages.length === 0) return diagnostics;

  const stageIndex = new Map<string, number>();
  for (let i = 0; i < stages.length; i++) {
    stageIndex.set(stages[i], i);
  }

  const jobs = extractJobs(yaml);

  for (const [jobName, job] of jobs) {
    if (!job.needs || !job.stage) continue;

    const jobStageIdx = stageIndex.get(job.stage);
    if (jobStageIdx === undefined) continue;

    for (const need of job.needs) {
      const neededJob = jobs.get(need);
      if (!neededJob?.stage) continue;

      const needStageIdx = stageIndex.get(neededJob.stage);
      if (needStageIdx === undefined) continue;

      // If the needed job is in an earlier stage, it's already implied
      // by GitLab's default stage-based ordering
      if (needStageIdx < jobStageIdx) {
        diagnostics.push({
          checkId: "WGL028",
          severity: "info",
          message: `Job "${jobName}" lists "${need}" in needs: but it's already in an earlier stage (${neededJob.stage} → ${job.stage})`,
          entity: jobName,
          lexicon: "gitlab",
        });
      }
    }
  }

  return diagnostics;
}

export const wgl028: PostSynthCheck = {
  id: "WGL028",
  description: "Redundant needs — needs listing jobs already implied by stage ordering",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      diagnostics.push(...checkRedundantNeeds(yaml));
    }
    return diagnostics;
  },
};
