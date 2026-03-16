/**
 * WK8207: No hostNetwork
 *
 * Pods should not use hostNetwork: true. Using the host network namespace
 * bypasses network isolation and allows the pod to access all network
 * interfaces on the host.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, extractPodSpec, WORKLOAD_KINDS } from "./k8s-helpers";

export const wk8207: PostSynthCheck = {
  id: "WK8207",
  description: "No hostNetwork — using host network bypasses network isolation",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (!manifest.kind || !WORKLOAD_KINDS.has(manifest.kind)) continue;

        const podSpec = extractPodSpec(manifest);
        if (!podSpec) continue;

        const resourceName = manifest.metadata?.name ?? manifest.kind;

        if (podSpec.hostNetwork === true) {
          diagnostics.push({
            checkId: "WK8207",
            severity: "warning",
            message: `${manifest.kind} "${resourceName}" uses hostNetwork: true — this bypasses network isolation and should be avoided`,
            entity: resourceName,
            lexicon: "k8s",
          });
        }
      }
    }

    return diagnostics;
  },
};
