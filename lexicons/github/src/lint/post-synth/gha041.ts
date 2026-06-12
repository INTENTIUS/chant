/**
 * GHA041: Blanket `secrets: inherit` into a Reusable Workflow
 *
 * Flags a reusable-workflow call that passes `secrets: inherit`. Inheritance
 * hands the called workflow every secret the caller can see, regardless of what
 * it needs. Pass through only the specific secrets the reusable workflow uses.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, jobLines } from "./yaml-helpers";

export const gha041: PostSynthCheck = {
  id: "GHA041",
  description: "Blanket secrets: inherit into a reusable workflow",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const seen = new Set<string>();
      for (const { job, line } of jobLines(yaml)) {
        if (/^\s+secrets:\s*inherit\s*$/.test(line) && !seen.has(job)) {
          seen.add(job);
          diagnostics.push({
            checkId: "GHA041",
            severity: "warning",
            message: `Job "${job}" calls a reusable workflow with secrets: inherit, passing every caller secret. Pass through only the specific secrets it needs.`,
            entity: job,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
