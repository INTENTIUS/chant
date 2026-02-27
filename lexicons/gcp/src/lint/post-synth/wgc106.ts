/**
 * WGC106: Missing deletion policy annotation
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, isConfigConnectorResource, getAnnotations, getResourceName } from "./gcp-helpers";

export const wgc106: PostSynthCheck = {
  id: "WGC106",
  description: "Config Connector resource without cnrm.cloud.google.com/deletion-policy annotation",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      for (const manifest of parseGcpManifests(output)) {
        if (!isConfigConnectorResource(manifest)) continue;

        const annotations = getAnnotations(manifest);
        if (!annotations?.["cnrm.cloud.google.com/deletion-policy"]) {
          diagnostics.push({
            checkId: "WGC106",
            severity: "info",
            message: `Resource "${getResourceName(manifest)}" has no deletion-policy annotation — defaults to "delete" which removes the GCP resource on kubectl delete`,
            entity: getResourceName(manifest),
            lexicon: "gcp",
          });
        }
      }
    }

    return diagnostics;
  },
};
