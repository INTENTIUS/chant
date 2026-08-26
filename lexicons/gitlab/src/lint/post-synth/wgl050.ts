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
import { getPrimaryOutput, isMergeRequestReachable } from "./yaml-helpers";

const RESERVED_TOP_LEVEL_KEYS = new Set(["stages", "default", "workflow", "variables", "include", "cache"]);

export const wgl050: PostSynthCheck = {
  id: "WGL050",
  description: "Merge-request-reachable job is not interruptible",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);

      for (const section of yaml.split("\n\n")) {
        const top = section.split("\n")[0]?.match(/^(\.?[a-z][a-z0-9_.-]*):/i);
        if (!top) continue;
        const jobName = top[1];
        if (jobName.startsWith(".") || RESERVED_TOP_LEVEL_KEYS.has(jobName)) continue;
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
