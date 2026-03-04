/**
 * GHA018: Pull Request Target + Checkout Security Risk
 *
 * Flags workflows using `pull_request_target` trigger with a checkout action
 * in steps — this is a known security anti-pattern.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs, extractTriggers, hasCheckoutAction } from "./yaml-helpers";

export const gha018: PostSynthCheck = {
  id: "GHA018",
  description: "pull_request_target with checkout action is a security risk",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const triggers = extractTriggers(yaml);

      if (!triggers["pull_request_target"]) continue;

      const jobs = extractJobs(yaml);
      for (const [jobName, job] of jobs) {
        if (job.steps && hasCheckoutAction(job.steps)) {
          diagnostics.push({
            checkId: "GHA018",
            severity: "warning",
            message: `Job "${jobName}" uses checkout with pull_request_target trigger. This runs untrusted PR code with write permissions — a security risk.`,
            entity: jobName,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
