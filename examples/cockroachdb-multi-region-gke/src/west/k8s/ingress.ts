// K8s workloads: GCE Ingress for CockroachDB UI + ExternalDNS agent.
// ExternalDNS manages both public zone (UI ingress) and private zone (pod discovery).

import {
  GceIngress,
  GkeExternalDnsAgent,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";
import { CRDB_DOMAIN, INTERNAL_DOMAIN } from "../../shared/config";

const NAMESPACE = "crdb-west";

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
  defaults: {
    ingress: {
      metadata: {
        annotations: {
          "cloud.google.com/backend-config": '{"default":"crdb-ui-backend"}',
        },
      },
    },
  },
});

export const gceIngress = ing.ingress;

// ── ExternalDNS ────────────────────────────────────────────────────
// Watches headless Services to register pod IPs in crdb.internal private zone.

const dns = GkeExternalDnsAgent({
  gcpServiceAccountEmail: config.externalDnsGsaEmail,
  gcpProjectId: config.projectId,
  domainFilters: [CRDB_DOMAIN, INTERNAL_DOMAIN],
  txtOwnerId: config.clusterName,
  source: ["service", "ingress"],
});

export const dnsDeployment = dns.deployment;
export const dnsServiceAccount = dns.serviceAccount;
export const dnsClusterRole = dns.clusterRole;
export const dnsClusterRoleBinding = dns.clusterRoleBinding;
