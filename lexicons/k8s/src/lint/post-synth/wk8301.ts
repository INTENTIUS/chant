/**
 * WK8301: Probes Required
 *
 * Containers that expose a port should have both livenessProbe and
 * readinessProbe configured. Without probes, Kubernetes cannot detect
 * unhealthy containers or know when a container is ready to receive traffic.
 *
 * Containers that declare no port (queue/Temporal workers, batch consumers)
 * are exempt: they take no inbound traffic, so there is no endpoint to
 * HTTP-probe and no readiness signal for a Service to gate on. Flagging them
 * would force a placeholder exec probe on a correct, port-less pattern.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, extractContainers, WORKLOAD_KINDS } from "./k8s-helpers";

export const wk8301: PostSynthCheck = {
  id: "WK8301",
  description: "Probes required — containers should have livenessProbe and readinessProbe",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (!manifest.kind || !WORKLOAD_KINDS.has(manifest.kind)) continue;
        // CronJobs and Jobs are short-lived — probes are less relevant
        if (manifest.kind === "Job" || manifest.kind === "CronJob") continue;

        const containers = extractContainers(manifest);
        const resourceName = manifest.metadata?.name ?? manifest.kind;

        for (const container of containers) {
          // No declared port → no inbound traffic → nothing to HTTP-probe.
          if (!container.ports || container.ports.length === 0) continue;

          const missing: string[] = [];
          if (!container.livenessProbe) missing.push("livenessProbe");
          if (!container.readinessProbe) missing.push("readinessProbe");

          if (missing.length > 0) {
            diagnostics.push({
              checkId: "WK8301",
              severity: "warning",
              message: `Container "${container.name ?? "(unnamed)"}" in ${manifest.kind} "${resourceName}" is missing ${missing.join(" and ")}`,
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
