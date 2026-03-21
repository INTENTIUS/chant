/**
 * SLR029: RAPL energy accounting with AcctGatherNodeFreq >= 300
 *
 * Intel RAPL (Running Average Power Limit) hardware counters are 32-bit
 * registers that overflow approximately every 60–300 seconds depending on
 * CPU TDP. When AcctGatherNodeFreq >= 300, the counter may overflow between
 * samples, producing incorrect (negative or wrapped) energy readings.
 *
 * Fix: set AcctGatherNodeFreq < 300 (recommended: 30 seconds).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const slr029: PostSynthCheck = {
  id: "SLR029",
  description: "AcctGatherEnergyType=rapl with AcctGatherNodeFreq >= 300 — RAPL counter overflow risk",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;

      const content = typeof output === "string" ? output : (output as { primary: string }).primary;

      const isRapl = /^AcctGatherEnergyType=acct_gather_energy\/rapl/m.test(content);
      if (!isRapl) continue;

      const freqMatch = content.match(/^AcctGatherNodeFreq=(\d+)/m);
      if (!freqMatch) continue;

      const freq = parseInt(freqMatch[1], 10);
      if (freq >= 300) {
        diagnostics.push({
          checkId: "SLR029",
          severity: "error",
          message:
            `AcctGatherEnergyType=rapl with AcctGatherNodeFreq=${freq} risks RAPL hardware counter overflow. ` +
            "Set AcctGatherNodeFreq < 300 (recommend: 30).",
          lexicon: "slurm",
        });
      }
    }

    return diagnostics;
  },
};
