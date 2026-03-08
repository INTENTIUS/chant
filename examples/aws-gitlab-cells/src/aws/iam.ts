// IRSA roles: cluster autoscaler and per-cell IAM roles.
// chant-disable WAW009 -- IRSA roles require managed policy ARNs

import { Role, stackOutput } from "@intentius/chant-lexicon-aws";
import { oidcProvider, oidcIssuer } from "./cluster";

// ── IRSA trust policy factory ──────────────────────────────────────

function irsaTrustPolicy(namespace: string, saName: string) {
  return {
    "Fn::Sub": [
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Federated: "${OidcArn}" },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: {
              "${OidcIssuer}:sub": `system:serviceaccount:${namespace}:${saName}`,
              "${OidcIssuer}:aud": "sts.amazonaws.com",
            },
          },
        }],
      }),
      {
        OidcArn: oidcProvider.Arn,
        OidcIssuer: oidcIssuer,
      },
    ],
  };
}

// ── Cluster autoscaler role ────────────────────────────────────────

export const clusterAutoscalerRole = new Role({
  RoleName: "cells-cluster-autoscaler-role",
  AssumeRolePolicyDocument: irsaTrustPolicy("system", "cluster-autoscaler-sa"),
  Policies: [{
    PolicyName: "cluster-autoscaler",
    PolicyDocument: {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: [
          "autoscaling:DescribeAutoScalingGroups",
          "autoscaling:DescribeAutoScalingInstances",
          "autoscaling:DescribeLaunchConfigurations",
          "autoscaling:DescribeScalingActivities",
          "autoscaling:DescribeTags",
          "autoscaling:SetDesiredCapacity",
          "autoscaling:TerminateInstanceInAutoScalingGroup",
          "ec2:DescribeLaunchTemplateVersions",
          "ec2:DescribeInstanceTypes",
          "eks:DescribeNodegroup",
        ],
        Resource: "*",
      }],
    },
  }],
});

// ── Per-cell IRSA roles ────────────────────────────────────────────
// Each cell gets a scoped IAM role — pod-level access, no shared credentials.

export const cellAlphaRole = new Role({
  RoleName: "cells-alpha-role",
  AssumeRolePolicyDocument: irsaTrustPolicy("cell-alpha", "alpha-sa"),
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
  ],
});

export const cellBetaRole = new Role({
  RoleName: "cells-beta-role",
  AssumeRolePolicyDocument: irsaTrustPolicy("cell-beta", "beta-sa"),
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
  ],
});

// ── Stack outputs ──────────────────────────────────────────────────

export const clusterAutoscalerRoleArnOutput = stackOutput(clusterAutoscalerRole.Arn, {
  description: "IAM role ARN for cluster autoscaler (IRSA)",
});

export const cellAlphaRoleArnOutput = stackOutput(cellAlphaRole.Arn, {
  description: "IAM role ARN for cell alpha (IRSA)",
});

export const cellBetaRoleArnOutput = stackOutput(cellBetaRole.Arn, {
  description: "IAM role ARN for cell beta (IRSA)",
});
