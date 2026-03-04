/**
 * GHA011: Invalid Needs Reference
 *
 * Detects `needs:` references to non-existent job IDs.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs } from "./yaml-helpers";

export const gha011: PostSynthCheck = {
  id: "GHA011",
  description: "Job needs: references non-existent job",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const jobs = extractJobs(yaml);
      const jobNames = new Set(jobs.keys());

      for (const [jobName, job] of jobs) {
        if (!job.needs) continue;
        for (const need of job.needs) {
          if (!jobNames.has(need)) {
            diagnostics.push({
              checkId: "GHA011",
              severity: "error",
              message: `Job "${jobName}" needs "${need}", but no such job exists.`,
              entity: jobName,
              lexicon: "github",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
