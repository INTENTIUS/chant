// NetworkIsolatedApp: API with ingress/egress network policies.

import { NetworkIsolatedApp } from "@intentius/chant-lexicon-k8s";

const NAMESPACE = "web-platform";

const isolated = NetworkIsolatedApp({
  name: "api-isolated",
  image: "hashicorp/http-echo:0.2.3",
  port: 8080,
  replicas: 3,
  namespace: NAMESPACE,
  allowIngressFrom: [
    { podSelector: { "app.kubernetes.io/name": "frontend" } },
  ],
  allowEgressTo: [
    { podSelector: { "app.kubernetes.io/name": "postgres" }, ports: [{ port: 5432 }] },
    { namespaceSelector: { "kubernetes.io/metadata.name": "kube-system" }, ports: [{ port: 53, protocol: "UDP" }] },
  ],
});

export const isolatedDeployment = isolated.deployment;
export const isolatedService = isolated.service;
export const isolatedNetworkPolicy = isolated.networkPolicy;
