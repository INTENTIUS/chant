// K8s workloads: AGIC Ingress for CockroachDB UI + ExternalDNS agent (AKS).

import {
  Ingress,
  Deployment,
  ServiceAccount,
  ClusterRole,
  ClusterRoleBinding,
  AgicIngress,
  AksExternalDnsAgent,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

const NAMESPACE = "crdb-aks";

// ── AGIC Ingress ───────────────────────────────────────────────────

const agic = AgicIngress({
  name: "cockroachdb-ui",
  hosts: [
    {
      hostname: config.domain,
      paths: [
        { path: "/", pathType: "Prefix", serviceName: "cockroachdb-public", servicePort: 8080 },
      ],
    },
  ],
  healthCheckPath: "/health",
  namespace: NAMESPACE,
});

export const agicIngress = new Ingress(agic.ingress);

// ── ExternalDNS ────────────────────────────────────────────────────

const dns = AksExternalDnsAgent({
  clientId: config.externalDnsClientId,
  resourceGroup: config.resourceGroup,
  subscriptionId: config.subscriptionId,
  tenantId: config.tenantId,
  domainFilters: ["crdb.intentius.io"],
  txtOwnerId: config.clusterName,
});

export const dnsDeployment = new Deployment(dns.deployment);
export const dnsServiceAccount = new ServiceAccount(dns.serviceAccount);
export const dnsClusterRole = new ClusterRole(dns.clusterRole);
export const dnsClusterRoleBinding = new ClusterRoleBinding(dns.clusterRoleBinding);
