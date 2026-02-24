/**
 * WK8205: Drop ALL Capabilities
 *
 * Containers should drop all Linux capabilities and only add back those
 * explicitly needed. This follows the principle of least privilege and
 * reduces the attack surface.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, extractContainers, WORKLOAD_KINDS } from "./k8s-helpers";

export const wk8205: PostSynthCheck = {
  id: "WK8205",
  description: "Drop ALL capabilities — containers should drop all capabilities and add only what is needed",

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
          const capabilities = secCtx?.capabilities as Record<string, unknown> | undefined;
          const drop = capabilities?.drop;

          const dropsAll =
            Array.isArray(drop) &&
            drop.some(
              (cap) =>
                (typeof cap === "string" && cap.toUpperCase() === "ALL"),
            );

          if (!dropsAll) {
            diagnostics.push({
              checkId: "WK8205",
              severity: "warning",
              message: `Container "${container.name ?? "(unnamed)"}" in ${manifest.kind} "${resourceName}" does not drop ALL capabilities — add securityContext.capabilities.drop: ["ALL"]`,
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
