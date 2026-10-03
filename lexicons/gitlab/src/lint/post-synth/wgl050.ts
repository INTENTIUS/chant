/**
 * WGL050: Merge-Request Job Missing interruptible
 *
 * Flags a job reachable from merge-request pipelines that doesn't set
 * `interruptible: true`. Without it, GitLab's auto-cancel-redundant-pipelines
 * setting can't cancel the job when a new push supersedes it, so the runner
 * keeps spending capacity on a pipeline nobody wants anymore. Deploy jobs are
 * left alone — cancelling mid-deploy is its own hazard, not an efficiency
 * win. Efficiency (#444), not a correctness or security issue.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, isMergeRequestReachable, extractJobs, extractJobSection } from "./yaml-helpers";

export const wgl050: PostSynthCheck = {
  id: "WGL050",
  description: "Merge-request-reachable job is not interruptible",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);

      for (const [jobName] of extractJobs(yaml)) {
        if (jobName.startsWith(".")) continue;
        const section = extractJobSection(yaml, jobName);
        if (!section) continue;
        if (/deploy/i.test(jobName)) continue; // cancelling mid-deploy is a hazard, not a win

        if (!isMergeRequestReachable(section)) continue;
        if (/^\s+interruptible:\s*true\s*$/m.test(section)) continue;

        diagnostics.push({
          checkId: "WGL050",
          severity: "info",
          message: `Job "${jobName}" runs on merge-request pipelines but is not interruptible: true — when a new commit supersedes this pipeline, this job keeps running instead of being cancelled. Add interruptible: true.`,
          entity: jobName,
          lexicon: "gitlab",
        });
      }
    }

    return diagnostics;
  },
};
