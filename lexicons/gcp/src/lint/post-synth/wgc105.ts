/**
 * WGC105: Public Cloud SQL — authorizedNetworks with 0.0.0.0/0
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, getSpec, getResourceName } from "./gcp-helpers";

export const wgc105: PostSynthCheck = {
  id: "WGC105",
  description: "Cloud SQL instance with public 0.0.0.0/0 in authorizedNetworks",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      for (const manifest of parseGcpManifests(output)) {
        if (manifest.kind !== "SQLInstance") continue;

        const spec = getSpec(manifest);
        if (!spec) continue;

        const settings = spec.settings as Record<string, unknown> | undefined;
        const ipConfig = settings?.ipConfiguration as Record<string, unknown> | undefined;
        const networks = ipConfig?.authorizedNetworks as Array<Record<string, unknown>> | undefined;

        if (Array.isArray(networks)) {
          for (const net of networks) {
            if (net.value === "0.0.0.0/0") {
              diagnostics.push({
                checkId: "WGC105",
                severity: "warning",
                message: `SQLInstance "${getResourceName(manifest)}" allows connections from 0.0.0.0/0 — this exposes the database to the public internet`,
                entity: getResourceName(manifest),
                lexicon: "gcp",
              });
            }
          }
        }
      }
    }

    return diagnostics;
  },
};
