// Stack outputs: cluster endpoint, OIDC ARN, KMS ARN, subnet IDs, SG IDs.

import { stackOutput } from "@intentius/chant-lexicon-aws";
import { cluster, oidcProvider } from "./cluster";
import { eksKey } from "./encryption";
import { network } from "./networking";

export const clusterEndpoint = stackOutput(cluster.Endpoint, {
  description: "EKS cluster API endpoint",
});

export const clusterArn = stackOutput(cluster.Arn, {
  description: "EKS cluster ARN",
});

export const oidcProviderArn = stackOutput(oidcProvider.Arn, {
  description: "OIDC provider ARN for IRSA",
});

export const kmsKeyArn = stackOutput(eksKey.Arn, {
  description: "KMS key ARN for encryption",
});
