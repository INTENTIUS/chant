// ray-system namespace with resource guardrails.
//
// NamespaceEnv creates Namespace + ResourceQuota + LimitRange.
// defaultDenyIngress: true — the RayCluster composite owns all ingress
// rules via its own NetworkPolicy. This default-deny baseline prevents
// accidental cross-namespace traffic.

import { NamespaceEnv } from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

export const { namespace, resourceQuota, limitRange } = NamespaceEnv({
  name: config.namespace,
  cpuQuota: "64",
  memoryQuota: "256Gi",
  maxPods: 100,
  defaultCpuRequest: "250m",
  defaultMemoryRequest: "512Mi",
  defaultCpuLimit: "4",
  defaultMemoryLimit: "8Gi",
  defaultDenyIngress: true,
  defaultDenyEgress: false,   // RayCluster NetworkPolicy owns egress rules
});
