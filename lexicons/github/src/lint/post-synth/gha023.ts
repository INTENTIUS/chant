/**
 * GHA023: Deprecated set-output Command
 *
 * Flags usage of `::set-output` in run steps, which has been deprecated
 * in favor of `$GITHUB_OUTPUT`.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs } from "./yaml-helpers";

export const gha023: PostSynthCheck = {
  id: "GHA023",
  description: "Deprecated ::set-output command usage",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const jobs = extractJobs(yaml);

      for (const [jobName, job] of jobs) {
        if (!job.steps) continue;

        for (const step of job.steps) {
          if (!step.run) continue;

          if (step.run.includes("::set-output")) {
            const stepLabel = step.name ?? "unnamed step";
            diagnostics.push({
              checkId: "GHA023",
              severity: "warning",
              message: `Job "${jobName}" step "${stepLabel}" uses deprecated ::set-output. Use $GITHUB_OUTPUT instead.`,
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
