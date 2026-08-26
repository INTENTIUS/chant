/**
 * WK8406: No resource limits on a GPU pod
 *
 * A container that requests `nvidia.com/gpu` but sets no cpu/memory limits
 * can starve other pods on the same (expensive, scarce) GPU node of CPU and
 * memory headroom. Unlike WK8201's general resource-limits guidance, this
 * check is scoped to GPU-requesting containers specifically, since GPU node
 * capacity is costlier and more contended than a general-purpose pool.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { docsToManifests, extractContainers, GPU_POD_KINDS, NVIDIA_GPU_RESOURCE } from "./k8s-helpers";

export const wk8406: PostSynthCheck = {
  id: "WK8406",
  description: "GPU-requesting container has no cpu/memory resource limits",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const manifest of docsToManifests(ctx)) {
      if (!manifest.kind || !GPU_POD_KINDS.has(manifest.kind)) continue;

      const containers = extractContainers(manifest);
      const resourceName = manifest.metadata?.name ?? manifest.kind;

      for (const container of containers) {
        const requests = container.resources?.requests as Record<string, unknown> | undefined;
        const limits = container.resources?.limits as Record<string, unknown> | undefined;
        const requestsGpu = Boolean(requests?.[NVIDIA_GPU_RESOURCE]) || Boolean(limits?.[NVIDIA_GPU_RESOURCE]);
        if (!requestsGpu) continue;

        const missing: string[] = [];
        if (!limits || typeof limits !== "object") {
          missing.push("cpu", "memory");
        } else {
          if (!limits.cpu) missing.push("cpu");
          if (!limits.memory) missing.push("memory");
        }

        if (missing.length > 0) {
          diagnostics.push({
            checkId: "WK8406",
            severity: "warning",
            message: `GPU container "${container.name ?? "(unnamed)"}" in ${manifest.kind} "${resourceName}" is missing resource limits for ${missing.join(", ")} — a GPU pod without cpu/memory limits can starve its (scarce, expensive) node`,
            entity: resourceName,
            lexicon: "k8s",
          });
        }
      }
    }

    return diagnostics;
  },
};
