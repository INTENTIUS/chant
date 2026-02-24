/**
 * WK8302: Replicas >= 2 for High Availability
 *
 * Deployments should have at least 2 replicas for high availability.
 * A single replica means any pod disruption causes downtime.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests } from "./k8s-helpers";

export const wk8302: PostSynthCheck = {
  id: "WK8302",
  description: "Replicas >= 2 recommended — single-replica Deployments have no high availability",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (manifest.kind !== "Deployment") continue;

        const resourceName = manifest.metadata?.name ?? "Deployment";
        const spec = manifest.spec;
        if (!spec) continue;

        const replicas = spec.replicas;

        // If replicas is omitted, Kubernetes defaults to 1
        if (replicas === undefined || replicas === null || replicas === 1) {
          diagnostics.push({
            checkId: "WK8302",
            severity: "info",
            message: `Deployment "${resourceName}" has ${replicas ?? 1} replica(s) — consider at least 2 for high availability`,
            entity: resourceName,
            lexicon: "k8s",
          });
        }
      }
    }

    return diagnostics;
  },
};
