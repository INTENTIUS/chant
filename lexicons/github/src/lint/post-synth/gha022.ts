/**
 * GHA022: Job Without timeout-minutes
 *
 * Flags jobs that do not specify `timeout-minutes`, which can lead to
 * hung workflows consuming runner minutes.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs } from "./yaml-helpers";

export const gha022: PostSynthCheck = {
  id: "GHA022",
  description: "Job without timeout-minutes",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const jobs = extractJobs(yaml);

      // Find job sections in the raw YAML to check for timeout-minutes
      const jobsIdx = yaml.search(/^jobs:\s*$/m);
      if (jobsIdx === -1) continue;

      const jobsContent = yaml.slice(jobsIdx + yaml.slice(jobsIdx).indexOf("\n") + 1);

      for (const [jobName] of jobs) {
        const jobHeader = `  ${jobName}:\n`;
        const start = jobsContent.indexOf(jobHeader);
        if (start === -1) continue;

        // Slice from after the job header to find its content.
        // Use literal \n  \w (no m flag) to locate the next sibling job at 2-space indent.
        const rest = jobsContent.slice(start + jobHeader.length);
        const nextJobMatch = rest.search(/\n  \w/);
        const section = nextJobMatch === -1 ? rest : rest.slice(0, nextJobMatch);

        if (!/timeout-minutes:/.test(section)) {
          diagnostics.push({
            checkId: "GHA022",
            severity: "info",
            message: `Job "${jobName}" does not specify timeout-minutes. Consider adding a timeout to prevent hung workflows.`,
            entity: jobName,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
