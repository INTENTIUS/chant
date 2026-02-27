/**
 * WGC301: No audit logging config (IAMAuditConfig) in output
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests } from "./gcp-helpers";

export const wgc301: PostSynthCheck = {
  id: "WGC301",
  description: "No IAMAuditConfig resource found in output — audit logging may not be configured",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      const manifests = parseGcpManifests(output);
      if (manifests.length === 0) continue;

      const hasAuditConfig = manifests.some(m => m.kind === "IAMAuditConfig");
      if (!hasAuditConfig) {
        diagnostics.push({
          checkId: "WGC301",
          severity: "info",
          message: "No IAMAuditConfig resource found — consider adding audit logging for compliance",
          lexicon: "gcp",
        });
      }
    }

    return diagnostics;
  },
};
