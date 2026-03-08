// K8s workloads: ALB Ingress for CockroachDB UI + ExternalDNS agent.

import {
  AlbIngress,
  ExternalDnsAgent,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

const NAMESPACE = "crdb-eks";

// ── ALB Ingress ────────────────────────────────────────────────────

const alb = AlbIngress({
  name: "cockroachdb-ui",
  hosts: [
    {
      hostname: config.domain,
      paths: [
        { path: "/", pathType: "Prefix", serviceName: "cockroachdb-public", servicePort: 8080 },
      ],
    },
  ],
  scheme: "internet-facing",
  targetType: "ip",
  certificateArn: config.albCertificateArn || undefined,
  sslRedirect: config.albCertificateArn ? true : undefined,
  healthCheckPath: "/health",
  namespace: NAMESPACE,
});

export const albIngress = alb.ingress;

// ── ExternalDNS ────────────────────────────────────────────────────

const dns = ExternalDnsAgent({
  iamRoleArn: config.externalDnsRoleArn,
  domainFilters: ["crdb.intentius.io"],
  txtOwnerId: config.clusterName,
});

export const dnsDeployment = dns.deployment;
export const dnsServiceAccount = dns.serviceAccount;
export const dnsClusterRole = dns.clusterRole;
export const dnsClusterRoleBinding = dns.clusterRoleBinding;
