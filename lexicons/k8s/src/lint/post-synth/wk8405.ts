/**
 * WK8405: Serving workload without a PodDisruptionBudget
 *
 * An InferenceService (or a Deployment carrying a serving
 * `app.kubernetes.io/component` label — e.g. `inference-service` or
 * `vllm-serving-runtime`) with no PodDisruptionBudget selecting it can lose
 * every replica at once during a voluntary disruption (node drain, cluster
 * upgrade), taking the model endpoint down. Serving workloads should ship
 * with a PDB.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests } from "./k8s-helpers";
import type { K8sManifest } from "./k8s-helpers";

/** `app.kubernetes.io/component` values this lexicon's composites use for serving workloads. */
const SERVING_COMPONENTS = new Set(["inference-service", "vllm-serving-runtime", "model-serving"]);

function isServingWorkload(manifest: K8sManifest): boolean {
  if (manifest.kind === "InferenceService") return true;
  if (manifest.kind !== "Deployment" && manifest.kind !== "StatefulSet") return false;
  const component = manifest.metadata?.labels?.["app.kubernetes.io/component"];
  return component !== undefined && SERVING_COMPONENTS.has(component);
}

export const wk8405: PostSynthCheck = {
  id: "WK8405",
  description: "Serving workload (InferenceService / serving Deployment) has no PodDisruptionBudget",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      const pdbSelectors = collectPdbSelectors(manifests);

      for (const manifest of manifests) {
        if (!isServingWorkload(manifest)) continue;

        const labels = manifest.metadata?.labels;
        const resourceName = manifest.metadata?.name ?? manifest.kind ?? "workload";

        if (!labels || !hasCoveringPdb(labels, pdbSelectors)) {
          diagnostics.push({
            checkId: "WK8405",
            severity: "info",
            message: `${manifest.kind} "${resourceName}" is a serving workload with no PodDisruptionBudget — add a PDB so a node drain or cluster upgrade cannot take down every replica at once`,
            entity: resourceName,
            lexicon: "k8s",
          });
        }
      }
    }

    return diagnostics;
  },
};

function collectPdbSelectors(manifests: K8sManifest[]): Array<Record<string, string>> {
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

function hasCoveringPdb(
  workloadLabels: Record<string, string>,
  pdbSelectors: Array<Record<string, string>>,
): boolean {
  return pdbSelectors.some((pdbLabels) =>
    Object.entries(pdbLabels).every(([key, value]) => workloadLabels[key] === value),
  );
}
