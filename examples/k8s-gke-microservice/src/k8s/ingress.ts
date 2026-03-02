// K8s workloads: GCE Ingress + ExternalDNS agent.

import {
  Ingress,
  Deployment,
  ServiceAccount,
  ClusterRole,
  ClusterRoleBinding,
  GkeExternalDnsAgent,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

const NAMESPACE = "microservice";

// ── GCE Ingress ────────────────────────────────────────────────────

export const gceIngress = new Ingress({
  metadata: {
    name: "microservice-ingress",
    namespace: NAMESPACE,
    labels: {
      "app.kubernetes.io/name": "microservice-ingress",
      "app.kubernetes.io/managed-by": "chant",
      "app.kubernetes.io/component": "ingress",
    },
    annotations: {
      "kubernetes.io/ingress.class": "gce",
      "kubernetes.io/ingress.global-static-ip-name": "microservice-ip",
    },
  },
  spec: {
    rules: [
      {
        host: config.domain,
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: {
                service: { name: "microservice-api", port: { number: 80 } },
              },
            },
          ],
        },
      },
    ],
  },
});

// ── ExternalDNS ────────────────────────────────────────────────────

const dns = GkeExternalDnsAgent({
  gcpServiceAccountEmail: config.externalDnsGsaEmail,
  gcpProjectId: config.projectId,
  domainFilters: [config.domain.split(".").slice(-2).join(".")],
  txtOwnerId: config.clusterName,
});

export const dnsDeployment = new Deployment(dns.deployment);
export const dnsServiceAccount = new ServiceAccount(dns.serviceAccount);
export const dnsClusterRole = new ClusterRole(dns.clusterRole);
export const dnsClusterRoleBinding = new ClusterRoleBinding(dns.clusterRoleBinding);
