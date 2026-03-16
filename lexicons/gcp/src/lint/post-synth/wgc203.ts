/**
 * WGC203: GKE node pool with cloud-platform OAuth scope
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseGcpManifests, getSpec, getResourceName } from "./gcp-helpers";

export const wgc203: PostSynthCheck = {
  id: "WGC203",
  description: "ContainerNodePool using overly broad cloud-platform OAuth scope",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      for (const manifest of parseGcpManifests(output)) {
        if (manifest.kind !== "ContainerNodePool") continue;

        const spec = getSpec(manifest);
        if (!spec) continue;

        const nodeConfig = spec.nodeConfig as Record<string, unknown> | undefined;
        const oauthScopes = nodeConfig?.oauthScopes as string[] | undefined;

        if (Array.isArray(oauthScopes) && oauthScopes.some(s =>
          (typeof s === "string" && s.includes("cloud-platform")) ||
          (typeof s === "object" && s !== null && JSON.stringify(s).includes("cloud-platform")),
        )) {
          diagnostics.push({
            checkId: "WGC203",
            severity: "warning",
            message: `ContainerNodePool "${getResourceName(manifest)}" uses cloud-platform OAuth scope — this grants overly broad access; prefer workload identity with fine-grained IAM`,
            entity: getResourceName(manifest),
            lexicon: "gcp",
          });
        }
      }
    }

    return diagnostics;
  },
};
