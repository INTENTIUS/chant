// K8s workloads: AGIC Ingress for CockroachDB UI + ExternalDNS agent (AKS).

import {
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

export const agicIngress = agic.ingress;

// ── ExternalDNS ────────────────────────────────────────────────────

const dns = AksExternalDnsAgent({
  clientId: config.externalDnsClientId,
  resourceGroup: config.resourceGroup,
  subscriptionId: config.subscriptionId,
  tenantId: config.tenantId,
  domainFilters: ["crdb.intentius.io"],
  txtOwnerId: config.clusterName,
});

export const dnsDeployment = dns.deployment;
export const dnsServiceAccount = dns.serviceAccount;
export const dnsClusterRole = dns.clusterRole;
export const dnsClusterRoleBinding = dns.clusterRoleBinding;
