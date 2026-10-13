/**
 * GHA021: Checkout Action Without Pinned SHA
 *
 * Flags `actions/checkout` usage that references a tag (e.g. v4) instead of
 * a pinned commit SHA.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractActionRefs, stripUsesComment } from "./yaml-helpers";
import { pinFixHint } from "../../action-pins";

export const gha021: PostSynthCheck = {
  id: "GHA021",
  description: "actions/checkout used without pinned SHA",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      // The structural parser sees every step. The line-based extractJobs
      // only reads a step's first line, so it missed `uses:` whenever a step
      // starts with `name:`, which is how every composite emits it.
      for (const { job: jobName, ref: uses, level } of extractActionRefs(yaml)) {
        if (level !== "step") continue;

        // A pinned ref carries its version as a trailing comment
        // (`actions/checkout@<sha> # v7.0.1`); only the ref is judged.
        const match = stripUsesComment(uses).match(/^actions\/checkout@(.+)$/);
        if (!match) continue;

        const ref = match[1];
        // A pinned SHA is 40 hex characters
        if (/^[0-9a-f]{40}$/.test(ref)) continue;

        diagnostics.push({
          checkId: "GHA021",
          severity: "warning",
          message: `Job "${jobName}" uses actions/checkout@${ref} — pin to a full commit SHA for supply-chain security.${pinFixHint("actions/checkout")}`,
          entity: jobName,
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
