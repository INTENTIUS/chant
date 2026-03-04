// EKS-specific configuration. Extends shared cluster config.

import { CRDB_CLUSTER } from "../shared/config";

export const config = {
  ...CRDB_CLUSTER,
  clusterName: process.env.EKS_CLUSTER_NAME ?? "eks-cockroachdb",
  region: process.env.AWS_REGION ?? "us-east-1",
  namespace: "crdb-eks",
  locality: "cloud=aws,region=us-east-1",
  domain: "eks.crdb.intentius.io",
  albCertificateArn: process.env.ALB_CERT_ARN || "",
  externalDnsRoleArn: process.env.EXTERNAL_DNS_ROLE_ARN ?? "arn:aws:iam::123456789012:role/eks-cockroachdb-external-dns-role",
};
