/**
 * SLR032: Duplicate Licenses= declarations
 *
 * The Slurm serializer emits Licenses= from two sources:
 *   1. The Cluster entity's Licenses property (inline with cluster globals)
 *   2. Aggregated License entities (appended after node/partition stanzas)
 *
 * If both are present, the second Licenses= line silently overrides the first
 * in Slurm's parser — whichever line appears last wins. This is almost always
 * unintentional and can cause license tokens to be miscounted.
 *
 * Fix: remove the Licenses property from your Cluster object and declare
 * licenses using License entities exclusively.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export function checkDuplicateLicenses(content: string): PostSynthDiagnostic[] {
  const matches = content.match(/^Licenses=/gm);
  if (!matches || matches.length < 2) return [];

  return [
    {
      checkId: "SLR032",
      severity: "warning",
      message:
        `slurm.conf contains ${matches.length} Licenses= lines. ` +
        "Only the last one takes effect — remove the Licenses= field from the Cluster object " +
        "and declare licenses exclusively via License entities.",
      lexicon: "slurm",
    },
  ];
}

export const slr032: PostSynthCheck = {
  id: "SLR032",
  description: "Multiple Licenses= lines in slurm.conf — last one wins, earlier declarations silently ignored",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : (output as { primary: string }).primary;
      diagnostics.push(...checkDuplicateLicenses(content));
    }

    return diagnostics;
  },
};
