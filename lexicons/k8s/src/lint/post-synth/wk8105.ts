/**
 * WK8105: ImagePullPolicy Should Be Explicit
 *
 * Containers should have an explicit imagePullPolicy. When omitted,
 * Kubernetes defaults to "Always" for :latest and "IfNotPresent" for
 * other tags, which can lead to unexpected behavior.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, extractContainers, WORKLOAD_KINDS } from "./k8s-helpers";

export const wk8105: PostSynthCheck = {
  id: "WK8105",
  description: "ImagePullPolicy should be explicit — avoids surprising default behavior",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (!manifest.kind || !WORKLOAD_KINDS.has(manifest.kind)) continue;

        const containers = extractContainers(manifest);
        const resourceName = manifest.metadata?.name ?? manifest.kind;

        for (const container of containers) {
          if (!container.imagePullPolicy) {
            diagnostics.push({
              checkId: "WK8105",
              severity: "warning",
              message: `Container "${container.name ?? "(unnamed)"}" in ${manifest.kind} "${resourceName}" has no explicit imagePullPolicy — set it to "Always", "IfNotPresent", or "Never"`,
              entity: resourceName,
              lexicon: "k8s",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
