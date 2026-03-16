/**
 * WGC303: Missing VPC Service Controls perimeter
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests } from "./gcp-helpers";

export const wgc303: PostSynthCheck = {
  id: "WGC303",
  description: "No AccessContextManager ServicePerimeter found — VPC Service Controls not configured",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      const manifests = parseGcpManifests(output);
      if (manifests.length === 0) continue;

      const hasPerimeter = manifests.some(m =>
        m.kind === "AccessContextManagerServicePerimeter" ||
        (m.apiVersion?.includes("accesscontextmanager") && m.kind?.includes("ServicePerimeter")),
      );
      if (!hasPerimeter) {
        diagnostics.push({
          checkId: "WGC303",
          severity: "info",
          message: "No VPC Service Controls perimeter found — consider adding for data exfiltration protection",
          lexicon: "gcp",
        });
      }
    }

    return diagnostics;
  },
};
