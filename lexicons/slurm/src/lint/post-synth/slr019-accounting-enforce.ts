/**
 * SLR019: AccountingStorageEnforce required when slurmdbd is configured
 *
 * Setting AccountingStorageType=accounting_storage/slurmdbd without
 * AccountingStorageEnforce=associations,limits,qos means jobs can bypass
 * fairshare limits and QoS constraints. Users can run unlimited jobs
 * even when their account has reached its limit.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr019: PostSynthCheck = {
  id: "SLR019",
  description: "AccountingStorageEnforce should be set when AccountingStorageType is slurmdbd",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : output.primary;

      const hasSlurmdbd = /^AccountingStorageType=accounting_storage\/slurmdbd/m.test(content);
      const hasEnforce = /^AccountingStorageEnforce=/m.test(content);

      if (hasSlurmdbd && !hasEnforce) {
        diagnostics.push({
          checkId: "SLR019",
          severity: "warning",
          message: "AccountingStorageType=slurmdbd is set without AccountingStorageEnforce — add AccountingStorageEnforce=associations,limits,qos",
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
