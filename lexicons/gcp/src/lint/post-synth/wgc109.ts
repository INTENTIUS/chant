/**
 * WGC109: ComputeFirewall allowing all sources (0.0.0.0/0)
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, getSpec, getResourceName } from "./gcp-helpers";

export const wgc109: PostSynthCheck = {
  id: "WGC109",
  description: "ComputeFirewall with sourceRanges containing 0.0.0.0/0",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      for (const manifest of parseGcpManifests(output)) {
        if (manifest.kind !== "ComputeFirewall") continue;

        const spec = getSpec(manifest);
        if (!spec) continue;

        const sourceRanges = spec.sourceRanges as string[] | undefined;
        if (Array.isArray(sourceRanges) && sourceRanges.includes("0.0.0.0/0")) {
          diagnostics.push({
            checkId: "WGC109",
            severity: "warning",
            message: `ComputeFirewall "${getResourceName(manifest)}" allows traffic from 0.0.0.0/0 — this opens the firewall to the entire internet`,
            entity: getResourceName(manifest),
            lexicon: "gcp",
          });
        }
      }
    }

    return diagnostics;
  },
};
