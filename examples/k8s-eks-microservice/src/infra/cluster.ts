// AWS infrastructure: EKS cluster, managed node group, IAM roles, OIDC provider.
//
// This file creates the EKS control plane and worker nodes. IAM role ARNs
// flow into K8s composite props (e.g. IrsaServiceAccount, FluentBitAgent).

import {
  EKSCluster,
  Nodegroup,
  Role,
  OIDCProvider,
  stackOutput,
} from "@intentius/chant-lexicon-aws";
import { network } from "./networking";

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
  },
});

// ── OIDC Provider (for IRSA) ───────────────────────────────────────

export const oidcProvider = new OIDCProvider({
  Url: cluster.OpenIdConnectIssuerUrl,
  ClientIdList: ["sts.amazonaws.com"],
  ThumbprintList: ["9e99a48a9960b14926bb7f3b02e22da2b0ab7280"],
});

// ── IRSA roles (depend on OIDC provider) ───────────────────────────

// App role — grants S3 read access to the microservice
export const appRole = new Role({
  RoleName: "eks-microservice-app-role",
  AssumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: {
      Effect: "Allow",
      Principal: { Federated: oidcProvider.Arn },
      Action: "sts:AssumeRoleWithWebIdentity",
    },
  },
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
  ],
});

// ALB controller role
export const albControllerRole = new Role({
  RoleName: "eks-microservice-alb-controller-role",
  AssumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: {
      Effect: "Allow",
      Principal: { Federated: oidcProvider.Arn },
      Action: "sts:AssumeRoleWithWebIdentity",
    },
  },
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/ElasticLoadBalancingFullAccess",
  ],
});

// ExternalDNS role
export const externalDnsRole = new Role({
  RoleName: "eks-microservice-external-dns-role",
  AssumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: {
      Effect: "Allow",
      Principal: { Federated: oidcProvider.Arn },
      Action: "sts:AssumeRoleWithWebIdentity",
    },
  },
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/AmazonRoute53FullAccess",
  ],
});

// FluentBit role
export const fluentBitRole = new Role({
  RoleName: "eks-microservice-fluent-bit-role",
  AssumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: {
      Effect: "Allow",
      Principal: { Federated: oidcProvider.Arn },
      Action: "sts:AssumeRoleWithWebIdentity",
    },
  },
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
  ],
});

// ── Managed Node Group ─────────────────────────────────────────────

export const nodegroup = new Nodegroup({
  ClusterName: "eks-microservice",
  NodeRole: nodeRole.Arn,
  Subnets: [
    network.privateSubnet1.SubnetId,
    network.privateSubnet2.SubnetId,
  ],
  AmiType: "AL2_x86_64",
  InstanceTypes: ["t3.medium"],
  ScalingConfig: {
    MinSize: 2,
    MaxSize: 6,
    DesiredSize: 3,
  },
  Labels: {
    workload: "microservice",
  },
});

// ── Stack Outputs ──────────────────────────────────────────────────

export const clusterEndpoint = stackOutput(cluster.Endpoint, {
  description: "EKS cluster API endpoint",
});

export const clusterArnOutput = stackOutput(cluster.Arn, {
  description: "EKS cluster ARN",
});

export const appRoleArn = stackOutput(appRole.Arn, {
  description: "IAM role ARN for app (IRSA)",
});

export const albControllerRoleArn = stackOutput(albControllerRole.Arn, {
  description: "IAM role ARN for ALB controller (IRSA)",
});

export const externalDnsRoleArn = stackOutput(externalDnsRole.Arn, {
  description: "IAM role ARN for ExternalDNS (IRSA)",
});

export const fluentBitRoleArn = stackOutput(fluentBitRole.Arn, {
  description: "IAM role ARN for Fluent Bit (IRSA)",
});
