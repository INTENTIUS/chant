// K8s workloads: GCE Ingress for CockroachDB UI + ExternalDNS agent.
// ExternalDNS manages both public zone (UI ingress) and private zone (pod discovery).

import {
  GceIngress,
  GkeExternalDnsAgent,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";
import { CRDB_DOMAIN, INTERNAL_DOMAIN } from "../../shared/config";

const NAMESPACE = "crdb-east";

// ── GCE Ingress ────────────────────────────────────────────────────

const ing = GceIngress({
  name: "cockroachdb-ui",
  hosts: [
    {
      hostname: config.domain,
      paths: [{ path: "/", serviceName: "cockroachdb-public", servicePort: 8080 }],
    },
  ],
  namespace: NAMESPACE,
});

export const gceIngress = ing.ingress;

// ── ExternalDNS ────────────────────────────────────────────────────
// Watches Ingress (public zone) and headless Services (private zone).

const dns = GkeExternalDnsAgent({
  gcpServiceAccountEmail: config.externalDnsGsaEmail,
  gcpProjectId: config.projectId,
  domainFilters: [CRDB_DOMAIN, INTERNAL_DOMAIN],
  txtOwnerId: config.clusterName,
  source: "ingress",
});

export const dnsDeployment = dns.deployment;
export const dnsServiceAccount = dns.serviceAccount;
export const dnsClusterRole = dns.clusterRole;
export const dnsClusterRoleBinding = dns.clusterRoleBinding;
