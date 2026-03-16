/**
 * WGL013: Invalid `needs:` Target
 *
 * Detects two cases in the serialized YAML:
 * - Dangling reference: `needs:` names a job not defined in the pipeline
 * - Self-reference: job lists itself in `needs:`
 *
 * Both cause GitLab pipeline validation failures.
 *
 * Caveat: when `include:` is present, referenced jobs may come from
 * included files, so the check is skipped.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs, hasInclude } from "./yaml-helpers";

export function checkInvalidNeeds(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [, output] of ctx.outputs) {
    const yaml = getPrimaryOutput(output);
    if (hasInclude(yaml)) continue;

    const jobs = extractJobs(yaml);
    const jobNames = new Set(jobs.keys());

    for (const [jobName, job] of jobs) {
      if (!job.needs) continue;

      for (const need of job.needs) {
        if (need === jobName) {
          diagnostics.push({
            checkId: "WGL013",
            severity: "error",
            message: `Job "${jobName}" lists itself in needs: — self-references are invalid`,
            entity: jobName,
            lexicon: "gitlab",
          });
        } else if (!jobNames.has(need)) {
          diagnostics.push({
            checkId: "WGL013",
            severity: "error",
            message: `Job "${jobName}" needs "${need}" which is not defined in the pipeline`,
            entity: jobName,
            lexicon: "gitlab",
          });
        }
      }
    }
  }

  return diagnostics;
}

export const wgl013: PostSynthCheck = {
  id: "WGL013",
  description: "Invalid needs: target — dangling reference or self-reference",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkInvalidNeeds(ctx);
  },
};
