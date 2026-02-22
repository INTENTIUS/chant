/**
 * WGL014: Invalid `extends:` Target
 *
 * Detects jobs that `extends:` a template not defined in the pipeline YAML.
 * GitLab rejects pipelines with unresolved extends references.
 *
 * Caveat: when `include:` is present, templates may come from
 * included files, so the check is skipped.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs, hasInclude } from "./yaml-helpers";

export function checkInvalidExtends(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [, output] of ctx.outputs) {
    const yaml = getPrimaryOutput(output);
    if (hasInclude(yaml)) continue;

    const jobs = extractJobs(yaml);
    const jobNames = new Set(jobs.keys());

    for (const [jobName, job] of jobs) {
      if (!job.extends) continue;

      for (const target of job.extends) {
        if (!jobNames.has(target)) {
          diagnostics.push({
            checkId: "WGL014",
            severity: "error",
            message: `Job "${jobName}" extends "${target}" which is not defined in the pipeline`,
            entity: jobName,
            lexicon: "gitlab",
          });
        }
      }
    }
  }

  return diagnostics;
}

export const wgl014: PostSynthCheck = {
  id: "WGL014",
  description: "Invalid extends: target — references a template not in the pipeline",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkInvalidExtends(ctx);
  },
};
