/**
 * WK8303: PodDisruptionBudget Recommended for HA Deployments
 *
 * Deployments with 2 or more replicas should have a corresponding
 * PodDisruptionBudget (PDB) to ensure minimum availability during
 * voluntary disruptions like node drains and cluster upgrades.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests } from "./k8s-helpers";
import type { K8sManifest } from "./k8s-helpers";

export const wk8303: PostSynthCheck = {
  id: "WK8303",
  description: "PDB recommended for HA Deployments — ensures availability during voluntary disruptions",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      // Collect all PDB selectors to match against Deployments
      const pdbSelectors = collectPdbSelectors(manifests);

      for (const manifest of manifests) {
        if (manifest.kind !== "Deployment") continue;

        const spec = manifest.spec;
        if (!spec) continue;

        const replicas = spec.replicas;
        // Only check HA deployments (replicas >= 2)
        if (typeof replicas !== "number" || replicas < 2) continue;

        const resourceName = manifest.metadata?.name ?? "Deployment";

        // Check if any PDB targets this Deployment's labels
        const selector = spec.selector as Record<string, unknown> | undefined;
        const matchLabels = selector?.matchLabels as Record<string, string> | undefined;

        if (!matchLabels || !hasCoveringPdb(matchLabels, pdbSelectors)) {
          diagnostics.push({
            checkId: "WK8303",
            severity: "info",
            message: `Deployment "${resourceName}" has ${replicas} replicas but no PodDisruptionBudget — add a PDB to ensure availability during voluntary disruptions`,
            entity: resourceName,
            lexicon: "k8s",
          });
        }
      }
    }

    return diagnostics;
  },
};

/**
 * Collect matchLabels from all PodDisruptionBudget resources.
 */
function collectPdbSelectors(
  manifests: K8sManifest[],
): Array<Record<string, string>> {
  const selectors: Array<Record<string, string>> = [];

  for (const manifest of manifests) {
    if (manifest.kind !== "PodDisruptionBudget") continue;

    const spec = manifest.spec;
    if (!spec) continue;

    const selector = spec.selector as Record<string, unknown> | undefined;
    const matchLabels = selector?.matchLabels as Record<string, string> | undefined;

    if (matchLabels && typeof matchLabels === "object") {
      selectors.push(matchLabels);
    }
  }

  return selectors;
}

/**
 * Check if any PDB selector covers (is a subset of) the given labels.
 */
function hasCoveringPdb(
  deploymentLabels: Record<string, string>,
  pdbSelectors: Array<Record<string, string>>,
): boolean {
  return pdbSelectors.some((pdbLabels) =>
    Object.entries(pdbLabels).every(
      ([key, value]) => deploymentLabels[key] === value,
    ),
  );
}
