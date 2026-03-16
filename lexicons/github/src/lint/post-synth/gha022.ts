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

      const afterJobs = yaml.slice(jobsIdx + yaml.slice(jobsIdx).indexOf("\n") + 1);
      const endMatch = afterJobs.search(/^[a-z]/m);
      const jobsContent = endMatch === -1 ? afterJobs : afterJobs.slice(0, endMatch);

      for (const [jobName] of jobs) {
        // Find this job's section in the raw YAML
        const jobPattern = new RegExp(`^  ${jobName}:\\n([\\s\\S]*?)(?=\\n  [a-z]|$)`, "m");
        const jobSection = jobsContent.match(jobPattern);
        const section = jobSection ? jobSection[0] : "";

        if (!/timeout-minutes:/m.test(section)) {
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
