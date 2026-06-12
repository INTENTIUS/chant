/**
 * GHA043: Secret Consumed in a Job Without an Environment Gate
 *
 * Extends GHA026 (which fires only when a workflow uses secrets and defines no
 * environment at all). When a workflow *does* gate some jobs with an
 * `environment:`, this flags the specific jobs that consume secrets without one
 * — the inconsistent-gating case, where a secret-using job skips the approval
 * and scoping the author applied elsewhere.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, jobsReferencingSecrets, extractJobEnvironments } from "./yaml-helpers";

export const gha043: PostSynthCheck = {
  id: "GHA043",
  description: "Secret consumed in a job without an environment gate",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const gated = extractJobEnvironments(yaml);
      if (gated.size === 0) continue; // no environments used anywhere — GHA026 territory

      for (const job of jobsReferencingSecrets(yaml)) {
        if (!gated.has(job)) {
          diagnostics.push({
            checkId: "GHA043",
            severity: "warning",
            message: `Job "${job}" consumes a secret but declares no environment:, while other jobs in this workflow are environment-gated. Gate this job too, or confirm it should bypass the approval/scoping the others use.`,
            entity: job,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
