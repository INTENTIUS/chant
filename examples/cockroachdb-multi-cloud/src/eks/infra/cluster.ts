// AWS infrastructure: EKS cluster, managed node group, IAM roles, OIDC provider.
// Sized for CockroachDB: 3x m5.xlarge (4 vCPU / 16 GiB) worker nodes.

import {
  EKSCluster,
  Nodegroup,
  Role,
  OIDCProvider,
  KmsKey,
  Select,
  Split,
  stackOutput,
} from "@intentius/chant-lexicon-aws";
import { network } from "./networking";

// ── IAM: Cluster role ──────────────────────────────────────────────

export const clusterRole = new Role({
  RoleName: "eks-cockroachdb-cluster-role",
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
  RoleName: "eks-cockroachdb-node-role",
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
  Name: "eks-cockroachdb",
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

// ── IRSA trust policy helper ─────────────────────────────────────

const oidcIssuer = Select(1, Split("oidc-provider/", oidcProvider.Arn));

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

// ── IRSA roles ─────────────────────────────────────────────────────

// ExternalDNS role
export const externalDnsRole = new Role({
  RoleName: "eks-cockroachdb-external-dns-role",
  AssumeRolePolicyDocument: irsaTrustPolicy("kube-system", "external-dns-sa"),
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/AmazonRoute53FullAccess",
  ],
});

// EBS CSI driver role
export const ebsCsiRole = new Role({
  RoleName: "eks-cockroachdb-ebs-csi-role",
  AssumeRolePolicyDocument: irsaTrustPolicy("kube-system", "ebs-csi-controller-sa"),
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
  ],
});

// ── Managed Node Group ─────────────────────────────────────────────

export const nodegroup = new Nodegroup(
  {
    ClusterName: "eks-cockroachdb",
    NodeRole: nodeRole.Arn,
    Subnets: [
      network.privateSubnet1.SubnetId,
      network.privateSubnet2.SubnetId,
    ],
    AmiType: "AL2023_x86_64_STANDARD",
    InstanceTypes: ["m5.xlarge"],
    ScalingConfig: {
      MinSize: 3,
      MaxSize: 3,
      DesiredSize: 3,
    },
    Labels: {
      workload: "cockroachdb",
    },
  },
  { DependsOn: [cluster] },
);

// ── Stack Outputs ──────────────────────────────────────────────────

export const clusterEndpoint = stackOutput(cluster.Endpoint, {
  description: "EKS cluster API endpoint",
});

export const clusterArnOutput = stackOutput(cluster.Arn, {
  description: "EKS cluster ARN",
});

export const externalDnsRoleArn = stackOutput(externalDnsRole.Arn, {
  description: "IAM role ARN for ExternalDNS (IRSA)",
});
