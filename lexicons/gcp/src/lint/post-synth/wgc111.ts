/**
 * WGC111: Dangling resource reference
 *
 * Checks that every `resourceRef.name` in a Config Connector resource's spec
 * references a `metadata.name` that exists in the output.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, isConfigConnectorResource, getResourceName, findResourceRefs } from "./gcp-helpers";

export const wgc111: PostSynthCheck = {
  id: "WGC111",
  description: "Resource reference points to a name not defined in the output",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      const manifests = parseGcpManifests(output);

      // Collect all defined resource names
      const definedNames = new Set<string>();
      for (const manifest of manifests) {
        if (isConfigConnectorResource(manifest)) {
          const name = manifest.metadata?.name;
          if (name) definedNames.add(name);
        }
      }

      // Check each resource's refs
      for (const manifest of manifests) {
        if (!isConfigConnectorResource(manifest)) continue;
        const resourceName = getResourceName(manifest);
        const refs = findResourceRefs(manifest.spec);

        for (const refName of refs) {
          if (!definedNames.has(refName)) {
            diagnostics.push({
              checkId: "WGC111",
              severity: "warning",
              message: `Resource "${resourceName}" references "${refName}" via resourceRef, but no resource with that metadata.name exists in the output`,
              entity: resourceName,
              lexicon: "gcp",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
