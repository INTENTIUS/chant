/**
 * WGC107: StorageBucket missing versioning
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, getSpec, getResourceName } from "./gcp-helpers";

export const wgc107: PostSynthCheck = {
  id: "WGC107",
  description: "StorageBucket without versioning enabled",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      for (const manifest of parseGcpManifests(output)) {
        if (manifest.kind !== "StorageBucket") continue;

        const spec = getSpec(manifest);
        if (!spec) continue;

        const versioning = spec.versioning as Record<string, unknown> | undefined;
        if (!versioning || versioning.enabled !== true) {
          diagnostics.push({
            checkId: "WGC107",
            severity: "info",
            message: `StorageBucket "${getResourceName(manifest)}" does not have versioning enabled — consider enabling for data protection`,
            entity: getResourceName(manifest),
            lexicon: "gcp",
          });
        }
      }
    }

    return diagnostics;
  },
};
