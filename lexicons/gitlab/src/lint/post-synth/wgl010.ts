/**
 * WGL010: Undefined stage
 *
 * Detects jobs that reference a stage not declared in the `stages:` list.
 * This will cause a pipeline validation error in GitLab.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractStages, extractJobs } from "./yaml-helpers";

export const wgl010: PostSynthCheck = {
  id: "WGL010",
  description: "Job references a stage not in the stages list",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const stages = extractStages(yaml);
      if (stages.length === 0) continue; // No explicit stages — GitLab uses defaults

      const stageSet = new Set(stages);
      const jobs = extractJobs(yaml);

      for (const [jobName, job] of jobs) {
        if (job.stage && !stageSet.has(job.stage)) {
          diagnostics.push({
            checkId: "WGL010",
            severity: "error",
            message: `Job "${jobName}" references undefined stage "${job.stage}". Add it to the stages list.`,
            entity: jobName,
            lexicon: "gitlab",
          });
        }
      }
    }

    return diagnostics;
  },
};
