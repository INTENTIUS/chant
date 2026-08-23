/**
 * Validate generated lexicon-k8s artifacts.
 *
 * Thin wrapper around the core validation framework
 * with Kubernetes-specific configuration.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

const REQUIRED_NAMES = [
  // Core resources
  "Pod", "Service", "ConfigMap", "Secret", "Namespace",
  "ServiceAccount", "PersistentVolume", "PersistentVolumeClaim",
  // Apps
  "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet",
  // Batch
  "Job", "CronJob",
  // Networking
  "Ingress", "NetworkPolicy",
  // RBAC
  "Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding",
  // Autoscaling
  "HorizontalPodAutoscaler",
  // Policy
  "PodDisruptionBudget",
  // Property types
  "Container", "Volume", "VolumeMount", "EnvVar", "ServicePort",
  "Probe", "ResourceRequirements", "SecurityContext",
];

/**
 * Validate the generated lexicon-k8s artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-k8s.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
    // chant #1475 — the baseline was re-baselined with the k3s CRD work
    // (#1605). k8s generates from a pinned kubernetes release tag plus CRDs
    // vendored in this repo, so a fresh generate is deterministic and the
    // surface can only move through a change here. Gate on every validate,
    // not just under CHANT_RELEASE_GATE, so a CRD batch can no longer leave
    // the snapshot behind the way #1319/#1320/#1321 did.
    checkSurfaceSnapshot: "always",
  });
}
