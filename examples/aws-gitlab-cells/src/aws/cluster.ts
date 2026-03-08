// EKS cluster, OIDC provider, managed node group with launch template.
// Encrypted EBS volumes, multi-AZ placement, envelope encryption for secrets.

import {
  EKSCluster,
  Nodegroup,
  OIDCProvider,
  LaunchTemplate,
  Role,
  Select,
  Split,
} from "@intentius/chant-lexicon-aws";
import { network } from "./networking";
import { eksKey } from "./encryption";

// ── IAM: Cluster role ──────────────────────────────────────────────

export const clusterRole = new Role({
  RoleName: "cells-cluster-role",
  AssumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: {
      Effect: "Allow",
      Principal: { Service: "eks.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  },
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
    "arn:aws:iam::aws:policy/AmazonEKSVPCResourceController",
  ],
});

// ── IAM: Node role ─────────────────────────────────────────────────

export const nodeRole = new Role({
  RoleName: "cells-node-role",
  AssumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: {
      Effect: "Allow",
      Principal: { Service: "ec2.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  },
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ],
});

// ── EKS Cluster ────────────────────────────────────────────────────

export const cluster = new EKSCluster({
  Name: "cells-cluster",
  RoleArn: clusterRole.Arn,
  Version: "1.31",
  ResourcesVpcConfig: {
    SubnetIds: [
      network.publicSubnet1.SubnetId,
      network.publicSubnet2.SubnetId,
      network.publicSubnet3.SubnetId,
      network.privateSubnet1.SubnetId,
      network.privateSubnet2.SubnetId,
      network.privateSubnet3.SubnetId,
    ],
    SecurityGroupIds: [network.controlPlaneSg.GroupId],
    EndpointPublicAccess: true,
    EndpointPrivateAccess: true,
  },
  EncryptionConfig: [{
    Provider: { KeyArn: eksKey.Arn },
    Resources: ["secrets"],
  }],
  Logging: {
    ClusterLogging: {
      EnabledTypes: [
        { Type: "api" },
        { Type: "audit" },
        { Type: "authenticator" },
        { Type: "controllerManager" },
        { Type: "scheduler" },
      ],
    },
  },
});

// ── OIDC Provider (for IRSA) ───────────────────────────────────────

export const oidcProvider = new OIDCProvider({
  Url: cluster.OpenIdConnectIssuerUrl,
  ClientIdList: ["sts.amazonaws.com"],
  ThumbprintList: ["9e99a48a9960b14926bb7f3b02e22da2b0ab7280"],
});

/** OIDC issuer ID for condition keys in trust policies. */
export const oidcIssuer = Select(1, Split("oidc-provider/", oidcProvider.Arn));

// ── Launch Template (encrypted EBS) ────────────────────────────────

export const launchTemplate = new LaunchTemplate({
  LaunchTemplateData: {
    BlockDeviceMappings: [{
      DeviceName: "/dev/xvda",
      Ebs: {
        VolumeSize: 50,
        VolumeType: "gp3",
        Encrypted: true,
        KmsKeyId: eksKey.Arn,
      },
    }],
  },
});

// ── Managed Node Group (3-AZ) ──────────────────────────────────────

export const nodegroup = new Nodegroup(
  {
    ClusterName: "cells-cluster",
    NodeRole: nodeRole.Arn,
    Subnets: [
      network.privateSubnet1.SubnetId,
      network.privateSubnet2.SubnetId,
      network.privateSubnet3.SubnetId,
    ],
    AmiType: "AL2023_x86_64_STANDARD",
    InstanceTypes: ["t3.large"],
    ScalingConfig: {
      MinSize: 3,
      MaxSize: 12,
      DesiredSize: 6,
    },
    LaunchTemplate: {
      Id: launchTemplate.LaunchTemplateId,
      Version: launchTemplate.LatestVersionNumber,
    },
    Labels: {
      workload: "cells",
    },
  },
  { DependsOn: [cluster] },
);
