/**
 * GHA021: Checkout Action Without Pinned SHA
 *
 * Flags `actions/checkout` usage that references a tag (e.g. v4) instead of
 * a pinned commit SHA.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs } from "./yaml-helpers";

export const gha021: PostSynthCheck = {
  id: "GHA021",
  description: "actions/checkout used without pinned SHA",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const jobs = extractJobs(yaml);

      for (const [jobName, job] of jobs) {
        if (!job.steps) continue;

        for (const step of job.steps) {
          if (!step.uses) continue;

          const match = step.uses.match(/^actions\/checkout@(.+)$/);
          if (!match) continue;

          const ref = match[1];
          // A pinned SHA is 40 hex characters
          if (/^[0-9a-f]{40}$/.test(ref)) continue;

          diagnostics.push({
            checkId: "GHA021",
            severity: "warning",
            message: `Job "${jobName}" uses actions/checkout@${ref} — pin to a full commit SHA for supply-chain security.`,
            entity: jobName,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
