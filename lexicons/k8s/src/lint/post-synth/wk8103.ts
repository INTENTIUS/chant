/**
 * WK8103: Containers Must Have Name
 *
 * Every container in a pod spec must have a `name` field. This is required
 * by the Kubernetes API and will be rejected at apply time if missing.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, extractContainers, WORKLOAD_KINDS } from "./k8s-helpers";

export const wk8103: PostSynthCheck = {
  id: "WK8103",
  description: "Containers must have name — the name field is required by the Kubernetes API",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (!manifest.kind || !WORKLOAD_KINDS.has(manifest.kind)) continue;

        const containers = extractContainers(manifest);
        const resourceName = manifest.metadata?.name ?? manifest.kind;

        for (let i = 0; i < containers.length; i++) {
          const container = containers[i];
          if (!container.name || typeof container.name !== "string" || container.name.trim() === "") {
            diagnostics.push({
              checkId: "WK8103",
              severity: "error",
              message: `${manifest.kind} "${resourceName}" has a container at index ${i} without a name — the name field is required`,
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
