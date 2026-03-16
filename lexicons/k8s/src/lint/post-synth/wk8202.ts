/**
 * WK8202: No Privileged Containers
 *
 * Containers should not run in privileged mode. Privileged containers
 * have full access to the host's devices and kernel capabilities,
 * which is a significant security risk.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, extractContainers, WORKLOAD_KINDS } from "./k8s-helpers";

export const wk8202: PostSynthCheck = {
  id: "WK8202",
  description: "No privileged containers — privileged mode grants full host access",

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
          const secCtx = container.securityContext;
          if (secCtx && secCtx.privileged === true) {
            diagnostics.push({
              checkId: "WK8202",
              severity: "error",
              message: `Container "${container.name ?? "(unnamed)"}" in ${manifest.kind} "${resourceName}" runs in privileged mode — this grants full host access and should be avoided`,
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
