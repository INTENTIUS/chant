import { Parameter } from "@intentius/chant-lexicon-aws";

export const environment = new Parameter("String", {
  description: "Deployment environment (dev, staging, prod)",
  defaultValue: "dev",
});

export const domainName = new Parameter("String", {
  description: "Application domain name for ALB Ingress and ExternalDNS",
  defaultValue: "api.eks-microservice-demo.dev",
});

export const publicAccessCidr = new Parameter("String", {
  description: "CIDR block for EKS API public access (use your IP/32 in production)",
  defaultValue: "0.0.0.0/0",
});
