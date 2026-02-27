/**
 * WGC108: SQLInstance missing backup configuration
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, getSpec, getResourceName } from "./gcp-helpers";

export const wgc108: PostSynthCheck = {
  id: "WGC108",
  description: "SQLInstance without backup configuration enabled",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      for (const manifest of parseGcpManifests(output)) {
        if (manifest.kind !== "SQLInstance") continue;

        const spec = getSpec(manifest);
        if (!spec) continue;

        const settings = spec.settings as Record<string, unknown> | undefined;
        const backupConfig = settings?.backupConfiguration as Record<string, unknown> | undefined;

        if (!backupConfig || backupConfig.enabled !== true) {
          diagnostics.push({
            checkId: "WGC108",
            severity: "warning",
            message: `SQLInstance "${getResourceName(manifest)}" does not have backup configuration enabled — data loss risk`,
            entity: getResourceName(manifest),
            lexicon: "gcp",
          });
        }
      }
    }

    return diagnostics;
  },
};
