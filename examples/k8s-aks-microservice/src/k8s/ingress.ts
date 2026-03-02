// K8s workloads: AGIC Ingress + ExternalDNS agent (AKS).

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

export const agicIngress = new Ingress(agic.ingress);

// ── ExternalDNS ────────────────────────────────────────────────────

const dns = AksExternalDnsAgent({
  clientId: config.externalDnsClientId,
  resourceGroup: config.resourceGroup,
  subscriptionId: config.subscriptionId,
  tenantId: config.tenantId,
  domainFilters: [config.domain.split(".").slice(-2).join(".")],
  txtOwnerId: config.clusterName,
});

export const dnsDeployment = new Deployment(dns.deployment);
export const dnsServiceAccount = new ServiceAccount(dns.serviceAccount);
export const dnsClusterRole = new ClusterRole(dns.clusterRole);
export const dnsClusterRoleBinding = new ClusterRoleBinding(dns.clusterRoleBinding);
