// K8s workloads: ALB Ingress + ExternalDNS agent.

import {
  Ingress,
  Deployment,
  ServiceAccount,
  ClusterRole,
  ClusterRoleBinding,
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
  certificateArn: config.albCertificateArn,
  sslRedirect: true,
  healthCheckPath: "/healthz",
  namespace: NAMESPACE,
});

export const albIngress = new Ingress(alb.ingress);

// ── ExternalDNS ────────────────────────────────────────────────────

const dns = ExternalDnsAgent({
  iamRoleArn: config.externalDnsRoleArn,
  domainFilters: [config.domain.split(".").slice(-2).join(".")],
  txtOwnerId: config.clusterName,
});

export const dnsDeployment = new Deployment(dns.deployment);
export const dnsServiceAccount = new ServiceAccount(dns.serviceAccount);
export const dnsClusterRole = new ClusterRole(dns.clusterRole);
export const dnsClusterRoleBinding = new ClusterRoleBinding(dns.clusterRoleBinding);
