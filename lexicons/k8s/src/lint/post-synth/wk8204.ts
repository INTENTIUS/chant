/**
 * WK8204: RunAsNonRoot Recommended
 *
 * Containers should set securityContext.runAsNonRoot to true at either
 * the container level or pod level. Running as root inside a container
 * increases the blast radius of a container breakout.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, extractContainers, extractPodSpec, WORKLOAD_KINDS } from "./k8s-helpers";

export const wk8204: PostSynthCheck = {
  id: "WK8204",
  description: "RunAsNonRoot recommended — running as root increases container breakout risk",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (!manifest.kind || !WORKLOAD_KINDS.has(manifest.kind)) continue;

        const resourceName = manifest.metadata?.name ?? manifest.kind;
        const podSpec = extractPodSpec(manifest);
        if (!podSpec) continue;

        // Check pod-level securityContext
        const podSecCtx = podSpec.securityContext as Record<string, unknown> | undefined;
        const podRunAsNonRoot = podSecCtx?.runAsNonRoot === true;

        const containers = extractContainers(manifest);
        for (const container of containers) {
          const secCtx = container.securityContext;
          const containerRunAsNonRoot = secCtx?.runAsNonRoot === true;

          if (!podRunAsNonRoot && !containerRunAsNonRoot) {
            diagnostics.push({
              checkId: "WK8204",
              severity: "warning",
              message: `Container "${container.name ?? "(unnamed)"}" in ${manifest.kind} "${resourceName}" does not set runAsNonRoot: true — set it at container or pod level`,
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
