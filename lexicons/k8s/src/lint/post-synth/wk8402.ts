/**
 * WK8402: RayCluster missing spec.rayVersion
 *
 * KubeRay uses spec.rayVersion to select the Ray autoscaler sidecar image.
 * Without it, KubeRay defaults to the "latest" tag — autoscaler and Ray head
 * may run mismatched versions, leading to silent protocol failures.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests } from "./k8s-helpers";

export const wk8402: PostSynthCheck = {
  id: "WK8402",
  description: "RayCluster should set spec.rayVersion so KubeRay selects the correct autoscaler image",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (manifest.kind !== "RayCluster") continue;

        const name = manifest.metadata?.name ?? "RayCluster";
        const rayVersion = (manifest.spec as Record<string, unknown> | undefined)?.rayVersion;

        if (!rayVersion) {
          diagnostics.push({
            checkId: "WK8402",
            severity: "warning",
            message: `RayCluster "${name}" is missing spec.rayVersion — KubeRay autoscaler will pull the "latest" image tag`,
            entity: name,
            lexicon: "k8s",
          });
        }
      }
    }

    return diagnostics;
  },
};
