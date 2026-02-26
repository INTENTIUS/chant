// K8s workloads: ALB Ingress + ExternalDNS agent.
//
// ALB Ingress uses AWS Load Balancer Controller annotations.
// ExternalDNS manages Route53 records from Ingress hostnames.

import {
  Ingress,
  Deployment,
  ServiceAccount,
  ClusterRole,
  ClusterRoleBinding,
  AlbIngress,
  ExternalDnsAgent,
} from "@intentius/chant-lexicon-k8s";

const NAMESPACE = "microservice";

// ── ALB Ingress ────────────────────────────────────────────────────

const alb = AlbIngress({
  name: "microservice-alb",
  hosts: [
    {
      hostname: "api.example.com",
      paths: [
        { path: "/", pathType: "Prefix", serviceName: "microservice-api", servicePort: 8080 },
      ],
    },
  ],
  scheme: "internet-facing",
  targetType: "ip",
  certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc-123-def",
  sslRedirect: true,
  healthCheckPath: "/healthz",
  namespace: NAMESPACE,
});

export const albIngress = new Ingress(alb.ingress);

// ── ExternalDNS ────────────────────────────────────────────────────

const dns = ExternalDnsAgent({
  iamRoleArn: "arn:aws:iam::123456789012:role/eks-microservice-external-dns-role",
  domainFilters: ["example.com"],
  txtOwnerId: "eks-microservice",
});

export const dnsDeployment = new Deployment(dns.deployment);
export const dnsServiceAccount = new ServiceAccount(dns.serviceAccount);
export const dnsClusterRole = new ClusterRole(dns.clusterRole);
export const dnsClusterRoleBinding = new ClusterRoleBinding(dns.clusterRoleBinding);
