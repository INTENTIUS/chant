/**
 * WK8201: Resource Limits Required
 *
 * Containers should have CPU and memory limits defined in resources.limits.
 * Without limits, a container can consume unbounded resources, potentially
 * affecting other workloads on the node.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, extractContainers, WORKLOAD_KINDS } from "./k8s-helpers";

export const wk8201: PostSynthCheck = {
  id: "WK8201",
  description: "Resource limits required — containers should have CPU and memory limits",

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
          const limits = container.resources?.limits;
          const missing: string[] = [];

          if (!limits || typeof limits !== "object") {
            missing.push("cpu", "memory");
          } else {
            if (!limits.cpu) missing.push("cpu");
            if (!limits.memory) missing.push("memory");
          }

          if (missing.length > 0) {
            diagnostics.push({
              checkId: "WK8201",
              severity: "warning",
              message: `Container "${container.name ?? "(unnamed)"}" in ${manifest.kind} "${resourceName}" is missing resource limits for ${missing.join(", ")}`,
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
