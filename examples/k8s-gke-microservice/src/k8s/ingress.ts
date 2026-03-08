// K8s workloads: GCE Ingress + ExternalDNS agent.

import {
  GceIngress,
  GkeExternalDnsAgent,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

const NAMESPACE = "microservice";

// ── GCE Ingress ────────────────────────────────────────────────────

const ing = GceIngress({
  name: "microservice-ingress",
  hosts: [
    {
      hostname: config.domain,
      paths: [{ path: "/", serviceName: "microservice-api", servicePort: 80 }],
    },
  ],
  staticIpName: "microservice-ip",
  namespace: NAMESPACE,
});

export const gceIngress = ing.ingress;

// ── ExternalDNS ────────────────────────────────────────────────────

const dns = GkeExternalDnsAgent({
  gcpServiceAccountEmail: config.externalDnsGsaEmail,
  gcpProjectId: config.projectId,
  domainFilters: [config.domain.split(".").slice(-2).join(".")],
  txtOwnerId: config.clusterName,
});

export const dnsDeployment = dns.deployment;
export const dnsServiceAccount = dns.serviceAccount;
export const dnsClusterRole = dns.clusterRole;
export const dnsClusterRoleBinding = dns.clusterRoleBinding;
