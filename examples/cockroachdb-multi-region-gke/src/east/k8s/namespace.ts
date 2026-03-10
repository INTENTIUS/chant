// K8s workloads: Namespace with resource quotas and network policy.

import {
  NetworkPolicy,
  NamespaceEnv,
} from "@intentius/chant-lexicon-k8s";
import { ALL_CIDRS } from "../../shared/config";

const ns = NamespaceEnv({
  name: "crdb-east",
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

export const namespace = ns.namespace;
export const resourceQuota = ns.resourceQuota;
export const limitRange = ns.limitRange;
export const networkPolicy = ns.networkPolicy;

// Allow CockroachDB inter-node (26257) and HTTP UI (8080) traffic from all region CIDRs.
export const crdbIngressPolicy = new NetworkPolicy({
  metadata: {
    name: "allow-cockroachdb",
    namespace: "crdb-east",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  spec: {
    podSelector: {
      matchLabels: { "app.kubernetes.io/name": "cockroachdb" },
    },
    policyTypes: ["Ingress"],
    ingress: [
      {
        from: ALL_CIDRS.map((cidr) => ({ ipBlock: { cidr } })),
        ports: [
          { protocol: "TCP", port: 26257 },
          { protocol: "TCP", port: 8080 },
        ],
      },
    ],
  },
});
