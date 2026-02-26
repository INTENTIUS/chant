import { Parameter } from "@intentius/chant-lexicon-aws";

export const environment = new Parameter("String", {
  description: "Deployment environment (dev, staging, prod)",
  defaultValue: "dev",
});

export const domainName = new Parameter("String", {
  description: "Application domain name for ALB Ingress and ExternalDNS",
  defaultValue: "api.example.com",
});

export const certificateArn = new Parameter("String", {
  description: "ACM certificate ARN for ALB HTTPS listener",
  defaultValue: "arn:aws:acm:us-east-1:123456789012:certificate/abc-123-def",
});
