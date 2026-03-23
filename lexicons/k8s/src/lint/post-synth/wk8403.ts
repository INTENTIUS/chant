/**
 * WK8403: spec.rayVersion does not match head image tag
 *
 * When spec.rayVersion is set but doesn't match the version in the head
 * container image tag, the KubeRay autoscaler sidecar will run a different
 * Ray version than the cluster. This can cause gRPC compatibility failures.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, extractRayVersion } from "./k8s-helpers";

export const wk8403: PostSynthCheck = {
  id: "WK8403",
  description: "spec.rayVersion should match the Ray version in the head container image tag",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (manifest.kind !== "RayCluster") continue;

        const clusterName = manifest.metadata?.name ?? "RayCluster";
        const spec = manifest.spec as Record<string, unknown> | undefined;
        if (!spec) continue;

        const rayVersion = spec.rayVersion as string | undefined;
        if (!rayVersion) continue; // WK8402 covers the missing case

        // Extract version from head container image
        const headGroupSpec = spec.headGroupSpec as Record<string, unknown> | undefined;
        const tmpl = headGroupSpec?.template as Record<string, unknown> | undefined;
        const podSpec = tmpl?.spec as Record<string, unknown> | undefined;
        const containers = podSpec?.containers as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(containers) || containers.length === 0) continue;

        const image = containers[0].image as string | undefined;
        if (!image) continue;

        const imageVersion = extractRayVersion(image);
        if (!imageVersion) continue; // Can't determine version from tag

        if (imageVersion !== rayVersion) {
          diagnostics.push({
            checkId: "WK8403",
            severity: "warning",
            message: `RayCluster "${clusterName}": spec.rayVersion "${rayVersion}" does not match head image tag "${imageVersion}" — autoscaler may run a mismatched Ray version`,
            entity: clusterName,
            lexicon: "k8s",
          });
        }
      }
    }

    return diagnostics;
  },
};
