import type { ChantConfig } from "@intentius/chant";

/**
 * Every per-deployment value is a build-time parameter, not a `process.env`
 * read in source. The `env` mapping keeps `set -a && source .env` working;
 * the read itself is declared, validated, and resolved once before any
 * project file loads, so the in-process and sandboxed builds see the same
 * values (chant #1728).
 *
 * In production, populate these from CloudFormation stack outputs:
 *   aws cloudformation describe-stacks --stack-name eks-microservice \
 *     --query 'Stacks[0].Outputs'
 */
export default {
  lexicons: ["aws", "k8s"],
  buildParams: {
    clusterName: { type: "string", default: "eks-microservice", env: "EKS_CLUSTER_NAME" },
    region: { type: "string", default: "us-east-1", env: "AWS_REGION" },
    appRoleArn: {
      type: "string",
      default: "arn:aws:iam::123456789012:role/eks-microservice-app-role",
      env: "APP_ROLE_ARN",
    },
    albCertificateArn: {
      type: "string",
      default: "",
      env: "ALB_CERT_ARN",
      description: "Leave empty to serve the ALB without TLS",
    },
    externalDnsRoleArn: {
      type: "string",
      default: "arn:aws:iam::123456789012:role/eks-microservice-external-dns-role",
      env: "EXTERNAL_DNS_ROLE_ARN",
    },
    fluentBitRoleArn: {
      type: "string",
      default: "arn:aws:iam::123456789012:role/eks-microservice-fluent-bit-role",
      env: "FLUENT_BIT_ROLE_ARN",
    },
    adotRoleArn: {
      type: "string",
      default: "arn:aws:iam::123456789012:role/eks-microservice-adot-role",
      env: "ADOT_ROLE_ARN",
    },
    domain: { type: "string", default: "api.eks-microservice-demo.dev", env: "DOMAIN" },
    appImage: { type: "string", default: "nginxinc/nginx-unprivileged:stable", env: "APP_IMAGE" },
  },
} satisfies ChantConfig;
