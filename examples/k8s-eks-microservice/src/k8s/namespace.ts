// K8s workloads: Namespace with resource quotas and default-deny NetworkPolicy.

import {
  Namespace,
  ResourceQuota,
  LimitRange,
  NetworkPolicy,
  NamespaceEnv,
} from "@intentius/chant-lexicon-k8s";

const ns = NamespaceEnv({
  name: "microservice",
  cpuQuota: "4",
  memoryQuota: "8Gi",
  maxPods: 50,
  defaultCpuRequest: "100m",
  defaultMemoryRequest: "128Mi",
  defaultCpuLimit: "500m",
  defaultMemoryLimit: "512Mi",
  denyAllIngress: true,
});

export const namespace = new Namespace(ns.namespace);
export const resourceQuota = new ResourceQuota(ns.resourceQuota);
export const limitRange = new LimitRange(ns.limitRange);
export const networkPolicy = new NetworkPolicy(ns.networkPolicy);
