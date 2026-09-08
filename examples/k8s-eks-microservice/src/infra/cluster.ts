// AWS infrastructure: EKS cluster, managed node group, IAM roles, OIDC provider.
//
// The IRSA roles that hang off the OIDC provider live in ./irsa, and every
// CloudFormation output lives in ./outputs.

import {
  EKSCluster,
  Nodegroup,
  Role,
  OIDCProvider,
  KmsKey,
  Ref,
} from "@intentius/chant-lexicon-aws";
import { network } from "./networking";
import { publicAccessCidr } from "./params";

// ── IAM: Cluster role ──────────────────────────────────────────────

export const clusterRole = new Role({
  RoleName: "eks-microservice-cluster-role",
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
  RoleName: "eks-microservice-node-role",
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

// ── KMS: Envelope encryption for K8s secrets ─────────────────────

export const eksSecretsKey = new KmsKey({
  Description: "EKS envelope encryption for Kubernetes secrets",
  EnableKeyRotation: true,
});

// ── EKS Cluster ────────────────────────────────────────────────────

export const cluster = new EKSCluster({
  Name: "eks-microservice",
  RoleArn: clusterRole.Arn,
  Version: "1.31",
  ResourcesVpcConfig: {
    SubnetIds: [
      network.publicSubnet1.SubnetId,
      network.publicSubnet2.SubnetId,
      network.privateSubnet1.SubnetId,
      network.privateSubnet2.SubnetId,
    ],
    EndpointPublicAccess: true,
    EndpointPrivateAccess: true,
    // Best practice: disable public access entirely and use VPN/bastion.
    // This example keeps public enabled for laptop-based development.
    // Restrict to your IP in production: just deploy-infra cidr=203.0.113.1/32
    PublicAccessCidrs: [Ref(publicAccessCidr)],
  },
  EncryptionConfig: [{
    Provider: { KeyArn: eksSecretsKey.Arn },
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

// ── Managed Node Group ─────────────────────────────────────────────

export const nodegroup = new Nodegroup(
  {
    ClusterName: "eks-microservice",
    NodeRole: nodeRole.Arn,
    Subnets: [
      network.privateSubnet1.SubnetId,
      network.privateSubnet2.SubnetId,
    ],
    AmiType: "AL2023_x86_64_STANDARD",
    InstanceTypes: ["t3.medium"],
    ScalingConfig: {
      MinSize: 2,
      MaxSize: 6,
      DesiredSize: 3,
    },
    Labels: {
      workload: "microservice",
    },
  },
  { DependsOn: [cluster] },
);
