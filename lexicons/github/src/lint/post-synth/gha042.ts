/**
 * GHA042: Whole Secrets Context Passed Where Specific Secrets Would Do
 *
 * Flags `toJSON(secrets)` (serializing the entire secrets context) passed into
 * a step's `with:`/`env:` or to a reusable workflow. It hands the consumer every
 * secret instead of the one or two it needs. Reference specific secrets.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, jobLines } from "./yaml-helpers";

const TO_JSON_SECRETS = /to_?json\s*\(\s*secrets\s*\)/i;

export const gha042: PostSynthCheck = {
  id: "GHA042",
  description: "Entire secrets context passed where specific secrets would do",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const seen = new Set<string>();
      for (const { job, line } of jobLines(yaml)) {
        if (TO_JSON_SECRETS.test(line) && !seen.has(job)) {
          seen.add(job);
          diagnostics.push({
            checkId: "GHA042",
            severity: "warning",
            message: `Job "${job}" passes the entire secrets context via toJSON(secrets). Reference only the specific secrets the consumer needs.`,
            entity: job,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
