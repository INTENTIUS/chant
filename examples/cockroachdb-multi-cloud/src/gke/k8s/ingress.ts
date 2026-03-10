// K8s workloads: GCE Ingress for CockroachDB UI + ExternalDNS agent.

import {
  GceIngress,
  GkeExternalDnsAgent,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";
import { CRDB_DOMAIN } from "../../shared/config";

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

export const gceIngress = ing.ingress;

// ── ExternalDNS ────────────────────────────────────────────────────

const dns = GkeExternalDnsAgent({
  gcpServiceAccountEmail: config.externalDnsGsaEmail,
  gcpProjectId: config.projectId,
  domainFilters: [CRDB_DOMAIN],
  txtOwnerId: config.clusterName,
});

export const dnsDeployment = dns.deployment;
export const dnsServiceAccount = dns.serviceAccount;
export const dnsClusterRole = dns.clusterRole;
export const dnsClusterRoleBinding = dns.clusterRoleBinding;
