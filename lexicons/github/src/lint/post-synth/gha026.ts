/**
 * GHA026: Secret Passed to Action Without `environment` Protection
 *
 * Flags workflows that reference `secrets.` in steps but have no
 * `environment:` key in any job, meaning secrets lack deployment
 * protection rules.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput } from "./yaml-helpers";

export const gha026: PostSynthCheck = {
  id: "GHA026",
  description: "Secret passed to action without environment protection",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);

      const usesSecrets = /secrets\./m.test(yaml);
      if (!usesSecrets) continue;

      const hasEnvironment = /^\s+environment:/m.test(yaml);
      if (hasEnvironment) continue;

      diagnostics.push({
        checkId: "GHA026",
        severity: "info",
        message:
          "Workflow references secrets but no job defines an `environment:`. Consider using environment protection rules to gate secret access with required reviewers or wait timers.",
        entity: "secrets",
        lexicon: "github",
      });
    }

    return diagnostics;
  },
};
