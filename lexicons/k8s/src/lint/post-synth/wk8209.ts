/**
 * WK8209: No hostIPC
 *
 * Pods should not use hostIPC: true. Sharing the host IPC namespace
 * allows the pod to access shared memory segments on the host, which
 * can be used to escalate privileges or exfiltrate data.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { docsToManifests, extractPodSpec, WORKLOAD_KINDS } from "./k8s-helpers";

export const wk8209: PostSynthCheck = {
  id: "WK8209",
  description: "No hostIPC — sharing host IPC namespace can expose shared memory segments",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const manifest of docsToManifests(ctx)) {
      if (!manifest.kind || !WORKLOAD_KINDS.has(manifest.kind)) continue;

      const podSpec = extractPodSpec(manifest);
      if (!podSpec) continue;

      const resourceName = manifest.metadata?.name ?? manifest.kind;

      if (podSpec.hostIPC === true) {
        diagnostics.push({
          checkId: "WK8209",
          severity: "warning",
          message: `${manifest.kind} "${resourceName}" uses hostIPC: true — this exposes host shared memory segments and should be avoided`,
          entity: resourceName,
          lexicon: "k8s",
        });
      }
    }

    return diagnostics;
  },
};
