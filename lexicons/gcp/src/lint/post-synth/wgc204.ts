/**
 * WGC204: ComputeInstance without shielded VM config
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, getSpec, getResourceName } from "./gcp-helpers";

export const wgc204: PostSynthCheck = {
  id: "WGC204",
  description: "ComputeInstance without shielded VM configuration",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      for (const manifest of parseGcpManifests(output)) {
        if (manifest.kind !== "ComputeInstance") continue;

        const spec = getSpec(manifest);
        if (!spec) continue;

        const shieldedConfig = spec.shieldedInstanceConfig as Record<string, unknown> | undefined;
        if (!shieldedConfig) {
          diagnostics.push({
            checkId: "WGC204",
            severity: "info",
            message: `ComputeInstance "${getResourceName(manifest)}" has no shielded VM configuration — consider enabling secureboot, vtpm, and integrity monitoring`,
            entity: getResourceName(manifest),
            lexicon: "gcp",
          });
        }
      }
    }

    return diagnostics;
  },
};
