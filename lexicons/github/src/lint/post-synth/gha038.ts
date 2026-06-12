/**
 * GHA038: Privileged `workflow_run` Trigger Checking Out Untrusted Code
 *
 * Generalizes GHA018 (pull_request_target + checkout) to the other privileged
 * trigger that runs in the base-repo context: `workflow_run`. A `workflow_run`
 * workflow has repo write scope and secrets, and checking out the artifact/head
 * of the triggering run pulls untrusted code into that privileged context.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractTriggers, extractJobs, hasCheckoutAction } from "./yaml-helpers";

export const gha038: PostSynthCheck = {
  id: "GHA038",
  description: "workflow_run trigger with checkout runs untrusted code in a privileged context",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const triggers = extractTriggers(yaml);
      if (!triggers["workflow_run"]) continue;

      const jobs = extractJobs(yaml);
      for (const [jobName, job] of jobs) {
        if (job.steps && hasCheckoutAction(job.steps)) {
          diagnostics.push({
            checkId: "GHA038",
            severity: "warning",
            message: `Job "${jobName}" checks out code under a workflow_run trigger, which runs with repo write scope and secrets. Treat the checked-out code as untrusted — avoid executing it, or move execution to an unprivileged workflow.`,
            entity: jobName,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
