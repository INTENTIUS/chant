/**
 * GHA040: Self-Hosted Runner on a Trigger That Can Run Untrusted Code
 *
 * Flags a job that runs on a self-hosted runner under a trigger reachable by a
 * fork or outside contributor (`pull_request`, `pull_request_target`,
 * `workflow_run`). Self-hosted runners are non-ephemeral by default and share a
 * host, so untrusted code can persist on the runner and compromise later jobs.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractTriggers, extractRunsOnByJob } from "./yaml-helpers";

const UNTRUSTED_TRIGGERS = ["pull_request", "pull_request_target", "workflow_run"];

export const gha040: PostSynthCheck = {
  id: "GHA040",
  description: "Self-hosted runner on a trigger that can run untrusted code",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const triggers = extractTriggers(yaml);
      const untrusted = UNTRUSTED_TRIGGERS.filter((t) => triggers[t]);
      if (untrusted.length === 0) continue;

      for (const [job, labels] of extractRunsOnByJob(yaml)) {
        if (labels.some((l) => l === "self-hosted")) {
          diagnostics.push({
            checkId: "GHA040",
            severity: "warning",
            message: `Job "${job}" runs on a self-hosted runner under the ${untrusted.join("/")} trigger, which a fork can reach. Use ephemeral GitHub-hosted runners for untrusted code, or require approval before the job runs.`,
            entity: job,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
