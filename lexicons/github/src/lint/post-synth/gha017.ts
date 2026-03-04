/**
 * GHA017: Missing Permissions
 *
 * Flags workflows without an explicit `permissions:` block.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, hasPermissions } from "./yaml-helpers";

export const gha017: PostSynthCheck = {
  id: "GHA017",
  description: "Workflow without explicit permissions block",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);

      if (!hasPermissions(yaml)) {
        diagnostics.push({
          checkId: "GHA017",
          severity: "info",
          message: "Workflow does not specify permissions. Consider adding explicit permissions for least-privilege security.",
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
