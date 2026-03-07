/**
 * GHA028: Workflow With No `on` Triggers
 *
 * Flags workflow files that lack a top-level `on:` key, which means
 * the workflow will never be triggered.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput } from "./yaml-helpers";

export const gha028: PostSynthCheck = {
  id: "GHA028",
  description: "Workflow with no `on` triggers",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);

      const hasOn = /^on:/m.test(yaml);

      if (!hasOn) {
        diagnostics.push({
          checkId: "GHA028",
          severity: "error",
          message:
            "Workflow has no `on:` trigger block. Without triggers the workflow will never run. Add an `on:` section with at least one event.",
          entity: "on",
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
