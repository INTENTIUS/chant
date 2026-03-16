// K8s workloads: AGIC Ingress + ExternalDNS agent (AKS).

import {
  AgicIngress,
  AksExternalDnsAgent,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

const NAMESPACE = "microservice";

// ── AGIC Ingress ───────────────────────────────────────────────────

const agic = AgicIngress({
  name: "microservice-agic",
  hosts: [
    {
      hostname: config.domain,
      paths: [
        { path: "/", pathType: "Prefix", serviceName: "microservice-api", servicePort: 80 },
      ],
    },
  ],
  healthCheckPath: "/",
  namespace: NAMESPACE,
});

export const agicIngress = agic.ingress;

// ── ExternalDNS ────────────────────────────────────────────────────

const dns = AksExternalDnsAgent({
  clientId: config.externalDnsClientId,
  resourceGroup: config.resourceGroup,
  subscriptionId: config.subscriptionId,
  tenantId: config.tenantId,
  domainFilters: [config.domain.split(".").slice(-2).join(".")],
  txtOwnerId: config.clusterName,
});

export const dnsDeployment = dns.deployment;
export const dnsServiceAccount = dns.serviceAccount;
export const dnsClusterRole = dns.clusterRole;
export const dnsClusterRoleBinding = dns.clusterRoleBinding;
