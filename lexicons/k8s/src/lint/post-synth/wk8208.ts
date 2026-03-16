/**
 * WK8208: No hostPID
 *
 * Pods should not use hostPID: true. Sharing the host PID namespace
 * allows the pod to see and interact with all processes on the host,
 * which is a significant security risk.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, extractPodSpec, WORKLOAD_KINDS } from "./k8s-helpers";

export const wk8208: PostSynthCheck = {
  id: "WK8208",
  description: "No hostPID — sharing host PID namespace allows visibility into all host processes",

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

        if (podSpec.hostPID === true) {
          diagnostics.push({
            checkId: "WK8208",
            severity: "warning",
            message: `${manifest.kind} "${resourceName}" uses hostPID: true — this allows visibility into all host processes and should be avoided`,
            entity: resourceName,
            lexicon: "k8s",
          });
        }
      }
    }

    return diagnostics;
  },
};
