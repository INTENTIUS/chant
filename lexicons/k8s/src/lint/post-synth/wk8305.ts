/**
 * WK8305: Ingress Port Not Matching Service
 *
 * Flags Ingress backends whose `service.port.number` does not match
 * any declared port on the referenced Service in the manifest set.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests } from "./k8s-helpers";
import type { K8sManifest } from "./k8s-helpers";

export const wk8305: PostSynthCheck = {
  id: "WK8305",
  description: "Ingress port not matching Service — backend port must match a declared Service port",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      // Build a map of Service name+namespace → set of port numbers
      const servicePorts = collectServicePorts(manifests);

      for (const manifest of manifests) {
        if (manifest.kind !== "Ingress") continue;

        const ingressName = manifest.metadata?.name ?? "Ingress";
        const ingressNamespace = manifest.metadata?.namespace ?? "default";
        const spec = manifest.spec;
        if (!spec) continue;

        const rules = spec.rules as Array<Record<string, unknown>> | undefined;
        if (!rules) continue;

        for (const rule of rules) {
          const http = rule.http as Record<string, unknown> | undefined;
          if (!http) continue;

          const paths = http.paths as Array<Record<string, unknown>> | undefined;
          if (!paths) continue;

          for (const pathEntry of paths) {
            const backend = pathEntry.backend as Record<string, unknown> | undefined;
            if (!backend) continue;

            const service = backend.service as Record<string, unknown> | undefined;
            if (!service) continue;

            const svcName = service.name as string | undefined;
            const port = service.port as Record<string, unknown> | undefined;
            const portNumber = port?.number as number | undefined;

            if (!svcName || portNumber === undefined) continue;

            // Look up the Service in the manifest set
            const key = `${ingressNamespace}/${svcName}`;
            const knownPorts = servicePorts.get(key);

            // Skip if the Service is not in the manifest set (external service)
            if (!knownPorts) continue;

            if (!knownPorts.has(portNumber)) {
              diagnostics.push({
                checkId: "WK8305",
                severity: "warning",
                message: `Ingress "${ingressName}" references Service "${svcName}" port ${portNumber}, but the Service only declares ports [${[...knownPorts].join(", ")}]`,
                entity: ingressName,
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

/**
 * Collect port numbers from all Service manifests, keyed by namespace/name.
 */
function collectServicePorts(manifests: K8sManifest[]): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();

  for (const manifest of manifests) {
    if (manifest.kind !== "Service") continue;

    const name = manifest.metadata?.name;
    const namespace = manifest.metadata?.namespace ?? "default";
    if (!name) continue;

    const key = `${namespace}/${name}`;
    const ports = new Set<number>();

    const spec = manifest.spec;
    if (spec) {
      const specPorts = spec.ports as Array<Record<string, unknown>> | undefined;
      if (specPorts) {
        for (const p of specPorts) {
          const port = p.port as number | undefined;
          if (port !== undefined) {
            ports.add(port);
          }
        }
      }
    }

    result.set(key, ports);
  }

  return result;
}
