/**
 * WGC201: Missing managed-by label
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, isConfigConnectorResource, getResourceName } from "./gcp-helpers";

export const wgc201: PostSynthCheck = {
  id: "WGC201",
  description: "Config Connector resource without app.kubernetes.io/managed-by label",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      for (const manifest of parseGcpManifests(output)) {
        if (!isConfigConnectorResource(manifest)) continue;

        const labels = manifest.metadata?.labels;
        if (!labels?.["app.kubernetes.io/managed-by"]) {
          diagnostics.push({
            checkId: "WGC201",
            severity: "info",
            message: `Resource "${getResourceName(manifest)}" has no app.kubernetes.io/managed-by label — consider using defaultLabels() for consistent labeling`,
            entity: getResourceName(manifest),
            lexicon: "gcp",
          });
        }
      }
    }

    return diagnostics;
  },
};
