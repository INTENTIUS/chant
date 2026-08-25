/**
 * WK8404: GPU request without a matching toleration
 *
 * A pod that requests `nvidia.com/gpu` but carries no toleration for the
 * `nvidia.com/gpu` taint won't schedule onto a tainted GPU node pool (see
 * `GpuNodePool`, #987, which taints its nodes `nvidia.com/gpu=present` by
 * default). The pod sits `Pending` with `0/N nodes are available` until a
 * toleration is added.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import {
  getPrimaryOutput,
  parseK8sManifests,
  extractContainers,
  extractPodSpec,
  requestsGpu,
  toleratesGpu,
  GPU_POD_KINDS,
} from "./k8s-helpers";

export const wk8404: PostSynthCheck = {
  id: "WK8404",
  description: "GPU request without a matching nvidia.com/gpu toleration",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (!manifest.kind || !GPU_POD_KINDS.has(manifest.kind)) continue;

        const containers = extractContainers(manifest);
        if (!requestsGpu(containers)) continue;

        const podSpec = extractPodSpec(manifest);
        if (toleratesGpu(podSpec?.tolerations)) continue;

        const resourceName = manifest.metadata?.name ?? manifest.kind;
        diagnostics.push({
          checkId: "WK8404",
          severity: "error",
          message: `${manifest.kind} "${resourceName}" requests nvidia.com/gpu but has no toleration for the nvidia.com/gpu taint — it will not schedule onto a tainted GPU node pool`,
          entity: resourceName,
          lexicon: "k8s",
        });
      }
    }

    return diagnostics;
  },
};
