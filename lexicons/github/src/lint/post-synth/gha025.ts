/**
 * GHA025: Using `pull_request_target` Without Restrictions
 *
 * Flags workflows that use `pull_request_target` without a `types:` filter,
 * which can expose secrets to untrusted fork PRs.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractTriggers } from "./yaml-helpers";

export const gha025: PostSynthCheck = {
  id: "GHA025",
  description: "Using pull_request_target without restrictions",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const triggers = extractTriggers(yaml);

      if (!triggers["pull_request_target"]) continue;

      // Check if pull_request_target section has a types: filter
      const prtSection = yaml.match(/^\s{2}pull_request_target:\s*\n((?:\s{4,}.+\n)*)/m);
      const hasTypes = prtSection?.[1]?.match(/^\s+types:/m);

      if (!hasTypes) {
        diagnostics.push({
          checkId: "GHA025",
          severity: "warning",
          message:
            "Workflow uses `pull_request_target` without a `types:` filter. This exposes secrets to all fork PRs. Add a `types:` restriction (e.g., [labeled, opened]) to limit exposure.",
          entity: "pull_request_target",
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
