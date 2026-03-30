/**
 * GHA024: Missing Concurrency for Deploy Workflows
 *
 * Flags deploy workflows that lack a `concurrency:` block, which risks
 * overlapping deployments.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs, extractWorkflowName } from "./yaml-helpers";

export const gha024: PostSynthCheck = {
  id: "GHA024",
  description: "Missing concurrency block for deploy workflow",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);

      const workflowName = extractWorkflowName(yaml) ?? "";
      const jobs = extractJobs(yaml);
      const jobNames = [...jobs.keys()];

      const isDeployWorkflow =
        /deploy/i.test(workflowName) || jobNames.some((name) => /deploy/i.test(name));

      if (!isDeployWorkflow) continue;

      if (!/^\s*concurrency:/m.test(yaml)) {
        diagnostics.push({
          checkId: "GHA024",
          severity: "info",
          message: "Deploy workflow does not specify concurrency. Add a concurrency block to prevent overlapping deployments.",
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
