/**
 * WK8401: shmSize exceeds container memory limit
 *
 * A RayCluster pod uses an emptyDir volume with medium: Memory for /dev/shm.
 * Kubernetes counts that memory against the container's memory limit — if the
 * sizeLimit exceeds the container's memory limit the pod will never schedule
 * (Kubelet rejects it with "Invalid value … must be less than or equal to memory limit").
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, parseMemoryBytes } from "./k8s-helpers";

export const wk8401: PostSynthCheck = {
  id: "WK8401",
  description: "shmSize must not exceed the container memory limit — pod will not schedule if it does",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (manifest.kind !== "RayCluster") continue;

        const clusterName = manifest.metadata?.name ?? "RayCluster";
        const spec = manifest.spec as Record<string, unknown> | undefined;
        if (!spec) continue;

        const groups: Array<{ label: string; templateSpec: Record<string, unknown> }> = [];

        // Head group
        const headGroupSpec = spec.headGroupSpec as Record<string, unknown> | undefined;
        if (headGroupSpec) {
          const tmpl = headGroupSpec.template as Record<string, unknown> | undefined;
          const podSpec = tmpl?.spec as Record<string, unknown> | undefined;
          if (podSpec) groups.push({ label: "head", templateSpec: podSpec });
        }

        // Worker groups
        const workerGroupSpecs = spec.workerGroupSpecs as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(workerGroupSpecs)) {
          for (const wg of workerGroupSpecs) {
            const name = (wg.groupName as string | undefined) ?? "worker";
            const tmpl = wg.template as Record<string, unknown> | undefined;
            const podSpec = tmpl?.spec as Record<string, unknown> | undefined;
            if (podSpec) groups.push({ label: `worker "${name}"`, templateSpec: podSpec });
          }
        }

        for (const { label, templateSpec } of groups) {
          // Find the emptyDir Memory volume (dshm)
          const volumes = templateSpec.volumes as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(volumes)) continue;

          for (const vol of volumes) {
            const emptyDir = vol.emptyDir as Record<string, unknown> | undefined;
            if (!emptyDir || emptyDir.medium !== "Memory") continue;

            const sizeLimit = emptyDir.sizeLimit as string | undefined;
            if (!sizeLimit) continue;

            const shmBytes = parseMemoryBytes(sizeLimit);
            if (isNaN(shmBytes)) continue;

            // Find memory limit from the first container that mounts this volume
            const containers = templateSpec.containers as Array<Record<string, unknown>> | undefined;
            if (!Array.isArray(containers)) continue;

            for (const container of containers) {
              const resources = container.resources as Record<string, unknown> | undefined;
              const limits = resources?.limits as Record<string, unknown> | undefined;
              const memLimit = limits?.memory as string | undefined;
              if (!memLimit) continue;

              const memBytes = parseMemoryBytes(memLimit);
              if (isNaN(memBytes)) continue;

              if (shmBytes > memBytes) {
                diagnostics.push({
                  checkId: "WK8401",
                  severity: "error",
                  message: `RayCluster "${clusterName}" ${label}: shmSize "${sizeLimit}" exceeds memory limit "${memLimit}" — pod will not schedule`,
                  entity: clusterName,
                  lexicon: "k8s",
                });
              }
              break; // Only check the first container per group
            }
          }
        }
      }
    }

    return diagnostics;
  },
};
