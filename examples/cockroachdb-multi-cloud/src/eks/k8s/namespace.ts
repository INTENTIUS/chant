// K8s workloads: Namespace with resource quotas and network policy.

import {
  Namespace,
  ResourceQuota,
  LimitRange,
  NetworkPolicy,
  NamespaceEnv,
} from "@intentius/chant-lexicon-k8s";
import { CIDRS } from "../../shared/config";

const ns = NamespaceEnv({
  name: "crdb-eks",
  cpuQuota: "8",
  memoryQuota: "32Gi",
  maxPods: 20,
  defaultCpuRequest: "500m",
  defaultMemoryRequest: "1Gi",
  defaultCpuLimit: "2",
  defaultMemoryLimit: "8Gi",
  defaultDenyIngress: true,
  labels: {
    "pod-security.kubernetes.io/enforce": "baseline",
    "pod-security.kubernetes.io/enforce-version": "latest",
    "pod-security.kubernetes.io/warn": "restricted",
    "pod-security.kubernetes.io/audit": "restricted",
  },
});

export const namespace = new Namespace(ns.namespace);
export const resourceQuota = new ResourceQuota(ns.resourceQuota);
export const limitRange = new LimitRange(ns.limitRange);
export const networkPolicy = new NetworkPolicy(ns.networkPolicy);

// Allow CockroachDB inter-node (26257) and HTTP UI (8080) traffic from all 3 VPC CIDRs.
export const crdbIngressPolicy = new NetworkPolicy({
  metadata: {
    name: "allow-cockroachdb",
    namespace: "crdb-eks",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  spec: {
    podSelector: {
      matchLabels: { "app.kubernetes.io/name": "cockroachdb" },
    },
    policyTypes: ["Ingress"],
    ingress: [
      {
        from: [
          { ipBlock: { cidr: CIDRS.eks.vpc } },
          { ipBlock: { cidr: CIDRS.aks.vpc } },
          { ipBlock: { cidr: CIDRS.gke.vpc } },
        ],
        ports: [
          { protocol: "TCP", port: 26257 },
          { protocol: "TCP", port: 8080 },
        ],
      },
    ],
  },
});
