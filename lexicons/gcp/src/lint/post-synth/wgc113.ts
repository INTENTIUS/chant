/**
 * WGC113: Alpha API version warning
 *
 * Warns when a Config Connector resource uses an alpha API version
 * (e.g. v1alpha1). Alpha APIs are unstable — prefer v1beta1 or v1.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, isConfigConnectorResource, getResourceName } from "./gcp-helpers";

export const wgc113: PostSynthCheck = {
  id: "WGC113",
  description: "Config Connector resource uses an alpha API version",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      const manifests = parseGcpManifests(output);

      for (const manifest of manifests) {
        if (!isConfigConnectorResource(manifest)) continue;

        const apiVersion = manifest.apiVersion!;
        if (/alpha\d+/.test(apiVersion)) {
          const resourceName = getResourceName(manifest);
          diagnostics.push({
            checkId: "WGC113",
            severity: "warning",
            message: `Resource "${resourceName}" uses alpha API version "${apiVersion}" — alpha APIs are unstable, prefer v1beta1 or v1`,
            entity: resourceName,
            lexicon: "gcp",
          });
        }
      }
    }

    return diagnostics;
  },
};
