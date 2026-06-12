/**
 * GHA054: Use of a Feature with a Known Security Footgun
 *
 * Catch-all, data-driven check: flags emitted workflow content matching a
 * vendored snapshot of known-risky GitHub Actions features (deprecated workflow
 * commands, unsafe runtime opt-ins, masking footguns). Advisory; the dataset is
 * necessarily incomplete.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, linesByJob } from "./yaml-helpers";
import { RISKY_FEATURES } from "../rules/data/risky-features";

export const gha054: PostSynthCheck = {
  id: "GHA054",
  description: "Use of a feature with a known security footgun",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const [job, lines] of linesByJob(yaml)) {
        const text = lines.join("\n");
        for (const feature of RISKY_FEATURES) {
          if (feature.pattern.test(text)) {
            diagnostics.push({
              checkId: "GHA054",
              severity: "warning",
              message: `Job "${job}" uses ${feature.label} — ${feature.advice}.`,
              entity: job,
              lexicon: "github",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
