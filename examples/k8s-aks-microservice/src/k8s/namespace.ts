// K8s workloads: Namespace with resource quotas and default-deny NetworkPolicy.

import { NamespaceEnv } from "@intentius/chant-lexicon-k8s";

const ns = NamespaceEnv({
  name: "microservice",
  cpuQuota: "4",
  memoryQuota: "8Gi",
  maxPods: 50,
  defaultCpuRequest: "100m",
  defaultMemoryRequest: "128Mi",
  defaultCpuLimit: "500m",
  defaultMemoryLimit: "512Mi",
  defaultDenyIngress: true,
  labels: {
    "pod-security.kubernetes.io/enforce": "restricted",
    "pod-security.kubernetes.io/enforce-version": "latest",
    "pod-security.kubernetes.io/warn": "restricted",
    "pod-security.kubernetes.io/audit": "restricted",
  },
});

export const namespace = ns.namespace;
export const resourceQuota = ns.resourceQuota;
export const limitRange = ns.limitRange;
export const networkPolicy = ns.networkPolicy;
