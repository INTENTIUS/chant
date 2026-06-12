/**
 * GHA032: Reference to an Archived or Compromised Action
 *
 * Flags a `uses:` slug that a vendored snapshot marks as archived/abandoned or
 * carrying a disclosed security issue. Advisory only — the dataset is
 * necessarily incomplete and may lag upstream changes.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractActionRefs, parseActionUses } from "./yaml-helpers";
import { FLAGGED_ACTIONS } from "../rules/data/flagged-actions";

export const gha032: PostSynthCheck = {
  id: "GHA032",
  description: "Action is archived/abandoned or has a disclosed security issue",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, ref } of extractActionRefs(yaml)) {
        const parsed = parseActionUses(ref);
        if (!parsed) continue;
        const flagged = FLAGGED_ACTIONS[parsed.slug];
        if (!flagged) continue;
        diagnostics.push({
          checkId: "GHA032",
          severity: "warning",
          message: `Job "${job}" uses "${parsed.slug}" — ${flagged.reason}. ${flagged.remediation}.`,
          entity: job,
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
