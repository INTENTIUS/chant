// KMS key for EKS envelope encryption (secrets) and EBS volume encryption.
// A dedicated key avoids reliance on AWS-managed defaults.

import { KmsKey, KMSAlias } from "@intentius/chant-lexicon-aws";

export const eksKey = new KmsKey({
  Description: "Cells cluster — envelope encryption for K8s secrets and EBS volumes",
  EnableKeyRotation: true,
  KeyPolicy: {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "Enable IAM User Permissions",
        Effect: "Allow",
        Principal: { AWS: { "Fn::Sub": "arn:aws:iam::${AWS::AccountId}:root" } },
        Action: "kms:*",
        Resource: "*",
      },
    ],
  },
});

export const eksKeyAlias = new KMSAlias({
  AliasName: "alias/cells-cluster-eks",
  TargetKeyId: eksKey.KeyId,
});
