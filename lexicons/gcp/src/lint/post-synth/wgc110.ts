/**
 * WGC110: KMS CryptoKey missing rotation period
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, getSpec, getResourceName } from "./gcp-helpers";

export const wgc110: PostSynthCheck = {
  id: "WGC110",
  description: "KMS CryptoKey without rotation period configured",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      for (const manifest of parseGcpManifests(output)) {
        if (manifest.kind !== "KMSCryptoKey") continue;

        const spec = getSpec(manifest);
        if (!spec) continue;

        if (!spec.rotationPeriod) {
          diagnostics.push({
            checkId: "WGC110",
            severity: "warning",
            message: `KMSCryptoKey "${getResourceName(manifest)}" has no rotation period configured — consider setting rotationPeriod for key hygiene`,
            entity: getResourceName(manifest),
            lexicon: "gcp",
          });
        }
      }
    }

    return diagnostics;
  },
};
