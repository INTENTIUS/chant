// K8s workloads: GCE Ingress for CockroachDB UI + ExternalDNS agent.

import {
  Ingress,
  Deployment,
  ServiceAccount,
  ClusterRole,
  ClusterRoleBinding,
  GceIngress,
  GkeExternalDnsAgent,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

const NAMESPACE = "crdb-gke";

// ── GCE Ingress ────────────────────────────────────────────────────

const ing = GceIngress({
  name: "cockroachdb-ui",
  hosts: [
    {
      hostname: config.domain,
      paths: [{ path: "/", serviceName: "cockroachdb-public", servicePort: 8080 }],
    },
  ],
  staticIpName: "cockroachdb-ui-ip",
  namespace: NAMESPACE,
});

export const gceIngress = new Ingress(ing.ingress);

// ── ExternalDNS ────────────────────────────────────────────────────

const dns = GkeExternalDnsAgent({
  gcpServiceAccountEmail: config.externalDnsGsaEmail,
  gcpProjectId: config.projectId,
  domainFilters: ["crdb.intentius.io"],
  txtOwnerId: config.clusterName,
});

export const dnsDeployment = new Deployment(dns.deployment);
export const dnsServiceAccount = new ServiceAccount(dns.serviceAccount);
export const dnsClusterRole = new ClusterRole(dns.clusterRole);
export const dnsClusterRoleBinding = new ClusterRoleBinding(dns.clusterRoleBinding);
