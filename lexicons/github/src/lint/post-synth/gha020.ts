/**
 * GHA020: Missing Job-Level Permissions for Sensitive Triggers
 *
 * Flags jobs without explicit `permissions:` when the workflow uses
 * `pull_request_target` or `workflow_dispatch` triggers.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs, extractTriggers } from "./yaml-helpers";

export const gha020: PostSynthCheck = {
  id: "GHA020",
  description: "Missing job-level permissions for sensitive triggers",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const triggers = extractTriggers(yaml);

      if (!triggers["pull_request_target"] && !triggers["workflow_dispatch"]) continue;

      const jobs = extractJobs(yaml);
      for (const [jobName, job] of jobs) {
        if (!job.permissions) {
          diagnostics.push({
            checkId: "GHA020",
            severity: "warning",
            message: `Job "${jobName}" lacks explicit permissions but workflow uses a sensitive trigger. Add job-level permissions for least-privilege security.`,
            entity: jobName,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
