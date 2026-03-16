/**
 * WGC202: GKE cluster without workload identity
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, getSpec, getResourceName } from "./gcp-helpers";

export const wgc202: PostSynthCheck = {
  id: "WGC202",
  description: "ContainerCluster without workload identity configuration",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      for (const manifest of parseGcpManifests(output)) {
        if (manifest.kind !== "ContainerCluster") continue;

        const spec = getSpec(manifest);
        if (!spec) continue;

        const workloadIdentity = spec.workloadIdentityConfig as Record<string, unknown> | undefined;
        if (!workloadIdentity?.workloadPool) {
          diagnostics.push({
            checkId: "WGC202",
            severity: "warning",
            message: `ContainerCluster "${getResourceName(manifest)}" does not have workload identity configured — recommended for secure pod-to-GCP authentication`,
            entity: getResourceName(manifest),
            lexicon: "gcp",
          });
        }
      }
    }

    return diagnostics;
  },
};
