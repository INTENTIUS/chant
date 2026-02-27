/**
 * WGC302: Service API not explicitly enabled
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests } from "./gcp-helpers";

export const wgc302: PostSynthCheck = {
  id: "WGC302",
  description: "No Service resource found — GCP APIs may not be explicitly enabled",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      const manifests = parseGcpManifests(output);
      if (manifests.length === 0) continue;

      const hasService = manifests.some(m => m.kind === "Service" && m.apiVersion?.includes("serviceusage.cnrm"));
      if (!hasService) {
        diagnostics.push({
          checkId: "WGC302",
          severity: "info",
          message: "No Service (serviceusage) resource found — consider explicitly enabling required GCP APIs",
          lexicon: "gcp",
        });
      }
    }

    return diagnostics;
  },
};
