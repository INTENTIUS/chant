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
  "K8sJob", "CronJob",
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
  });
}
