/**
 * GHA068: Pull-Request Workflow Missing a Concurrency Group
 *
 * Flags a workflow triggered on `pull_request` with no top-level
 * `concurrency:` block. Without one, a superseded push keeps its old run
 * going instead of cancelling it, so every commit on a PR pays for the full
 * pipeline instead of just the latest. Deploy workflows are left to GHA024,
 * which already covers them (overlapping-deployment risk, not capacity).
 * Efficiency (#444), not a correctness or security issue.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseDoc, extractJobs, extractWorkflowName } from "./yaml-helpers";

function hasPullRequestTrigger(on: unknown): boolean {
  if (typeof on === "string") return on === "pull_request";
  if (Array.isArray(on)) return on.includes("pull_request");
  if (on && typeof on === "object") return "pull_request" in (on as Record<string, unknown>);
  return false;
}

export const gha068: PostSynthCheck = {
  id: "GHA068",
  description: "Pull-request workflow missing a concurrency group",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const doc = parseDoc(yaml);
      if (!doc || !hasPullRequestTrigger(doc.on)) continue;

      const workflowName = extractWorkflowName(yaml) ?? "";
      const jobNames = [...extractJobs(yaml).keys()];
      const isDeployWorkflow = /deploy/i.test(workflowName) || jobNames.some((n) => /deploy/i.test(n));
      if (isDeployWorkflow) continue; // GHA024 already covers deploy workflows

      if (!/^\s*concurrency:/m.test(yaml)) {
        diagnostics.push({
          checkId: "GHA068",
          severity: "info",
          message: `Workflow${workflowName ? ` "${workflowName}"` : ""} triggers on pull_request with no \`concurrency:\` group — a new push doesn't cancel the superseded run, so every commit on the PR consumes a full run's worth of runner capacity. Add a \`concurrency:\` group with \`cancel-in-progress: true\`.`,
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
