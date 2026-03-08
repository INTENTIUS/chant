// K8s workloads: ALB Ingress + ExternalDNS agent.

import {
  AlbIngress,
  ExternalDnsAgent,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

const NAMESPACE = "microservice";

// ── ALB Ingress ────────────────────────────────────────────────────

const alb = AlbIngress({
  name: "microservice-alb",
  hosts: [
    {
      hostname: config.domain,
      paths: [
        { path: "/", pathType: "Prefix", serviceName: "microservice-api", servicePort: 80 },
      ],
    },
  ],
  scheme: "internet-facing",
  targetType: "ip",
  certificateArn: config.albCertificateArn || undefined,
  sslRedirect: config.albCertificateArn ? true : undefined,
  healthCheckPath: "/",
  namespace: NAMESPACE,
});

export const albIngress = alb.ingress;

// ── ExternalDNS ────────────────────────────────────────────────────

const dns = ExternalDnsAgent({
  iamRoleArn: config.externalDnsRoleArn,
  domainFilters: [config.domain.split(".").slice(-2).join(".")],
  txtOwnerId: config.clusterName,
});

export const dnsDeployment = dns.deployment;
export const dnsServiceAccount = dns.serviceAccount;
export const dnsClusterRole = dns.clusterRole;
export const dnsClusterRoleBinding = dns.clusterRoleBinding;
