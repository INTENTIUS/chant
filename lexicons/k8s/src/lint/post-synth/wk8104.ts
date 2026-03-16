/**
 * WK8104: Ports Should Be Named
 *
 * Container ports and Service ports should have names. Named ports enable
 * referencing by name in Service targetPort and NetworkPolicy rules,
 * improving maintainability.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, extractContainers, WORKLOAD_KINDS } from "./k8s-helpers";

export const wk8104: PostSynthCheck = {
  id: "WK8104",
  description: "Ports should be named — named ports improve Service and NetworkPolicy configuration",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        const resourceName = manifest.metadata?.name ?? manifest.kind ?? "(unknown)";

        // Check container ports in workloads
        if (manifest.kind && WORKLOAD_KINDS.has(manifest.kind)) {
          const containers = extractContainers(manifest);
          for (const container of containers) {
            if (!Array.isArray(container.ports)) continue;
            for (const port of container.ports) {
              if (typeof port === "object" && port !== null && !port.name) {
                diagnostics.push({
                  checkId: "WK8104",
                  severity: "warning",
                  message: `Container "${container.name ?? "(unnamed)"}" in ${manifest.kind} "${resourceName}" has an unnamed port (containerPort: ${port.containerPort ?? "?"}) — add a name for clarity`,
                  entity: resourceName,
                  lexicon: "k8s",
                });
              }
            }
          }
        }

        // Check Service ports
        if (manifest.kind === "Service") {
          const spec = manifest.spec;
          if (!spec) continue;
          const ports = spec.ports as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(ports)) continue;

          for (const port of ports) {
            if (typeof port === "object" && port !== null && !port.name) {
              diagnostics.push({
                checkId: "WK8104",
                severity: "warning",
                message: `Service "${resourceName}" has an unnamed port (port: ${port.port ?? "?"}) — add a name for clarity`,
                entity: resourceName,
                lexicon: "k8s",
              });
            }
          }
        }
      }
    }

    return diagnostics;
  },
};
