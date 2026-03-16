// chant-disable WAW009 -- ALB controller policy uses wildcards per official AWS recommendation
// AWS infrastructure: EKS cluster, managed node group, IAM roles, OIDC provider.
//
// This file creates the EKS control plane and worker nodes. IAM role ARNs
// flow into K8s composite props (e.g. IrsaServiceAccount, FluentBitAgent).

import {
  EKSCluster,
  Nodegroup,
  Role,
  ManagedPolicy,
  OIDCProvider,
  KmsKey,
  Ref,
  Select,
  Split,
  stackOutput,
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

// ── IRSA trust policy helper ─────────────────────────────────────

/** OIDC issuer ID extracted from provider ARN (for condition keys) */
const oidcIssuer = Select(1, Split("oidc-provider/", oidcProvider.Arn));

/** Build a trust policy that restricts AssumeRoleWithWebIdentity to a specific SA. */
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

// ── IRSA roles (depend on OIDC provider) ───────────────────────────

// App role — grants S3 read access to the microservice
export const appRole = new Role({
  RoleName: "eks-microservice-app-role",
  AssumeRolePolicyDocument: irsaTrustPolicy("microservice", "microservice-app-sa"),
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
  ],
});

// ALB controller custom IAM policy (official kubernetes-sigs/aws-load-balancer-controller policy)
export const albControllerPolicy = new ManagedPolicy({
  ManagedPolicyName: "eks-microservice-alb-controller-policy",
  PolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["iam:CreateServiceLinkedRole"],
        Resource: "*",
        Condition: { StringEquals: { "iam:AWSServiceName": "elasticloadbalancing.amazonaws.com" } },
      },
      {
        Effect: "Allow",
        Action: [
          "ec2:DescribeAccountAttributes", "ec2:DescribeAddresses", "ec2:DescribeAvailabilityZones",
          "ec2:DescribeInternetGateways", "ec2:DescribeVpcs", "ec2:DescribeVpcPeeringConnections",
          "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeInstances",
          "ec2:DescribeNetworkInterfaces", "ec2:DescribeTags", "ec2:GetCoipPoolUsage",
          "ec2:DescribeCoipPools", "ec2:GetSecurityGroupsForVpc", "ec2:DescribeIpamPools",
          "ec2:DescribeRouteTables",
          "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeLoadBalancerAttributes",
          "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeListenerCertificates",
          "elasticloadbalancing:DescribeSSLPolicies", "elasticloadbalancing:DescribeRules",
          "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetGroupAttributes",
          "elasticloadbalancing:DescribeTargetHealth", "elasticloadbalancing:DescribeTags",
          "elasticloadbalancing:DescribeTrustStores", "elasticloadbalancing:DescribeListenerAttributes",
          "elasticloadbalancing:DescribeCapacityReservation",
        ],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: [
          "cognito-idp:DescribeUserPoolClient",
          "acm:ListCertificates", "acm:DescribeCertificate",
          "iam:ListServerCertificates", "iam:GetServerCertificate",
          "waf-regional:GetWebACL", "waf-regional:GetWebACLForResource",
          "waf-regional:AssociateWebACL", "waf-regional:DisassociateWebACL",
          "wafv2:GetWebACL", "wafv2:GetWebACLForResource",
          "wafv2:AssociateWebACL", "wafv2:DisassociateWebACL",
          "shield:GetSubscriptionState", "shield:DescribeProtection",
          "shield:CreateProtection", "shield:DeleteProtection",
        ],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: ["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress"],
        Resource: "*",
      },
      { Effect: "Allow", Action: ["ec2:CreateSecurityGroup"], Resource: "*" },
      {
        Effect: "Allow",
        Action: ["ec2:CreateTags"],
        Resource: "arn:aws:ec2:*:*:security-group/*",
        Condition: {
          StringEquals: { "ec2:CreateAction": "CreateSecurityGroup" },
          Null: { "aws:RequestTag/elbv2.k8s.aws/cluster": "false" },
        },
      },
      {
        Effect: "Allow",
        Action: ["ec2:CreateTags", "ec2:DeleteTags"],
        Resource: "arn:aws:ec2:*:*:security-group/*",
        Condition: {
          Null: { "aws:RequestTag/elbv2.k8s.aws/cluster": "true", "aws:ResourceTag/elbv2.k8s.aws/cluster": "false" },
        },
      },
      {
        Effect: "Allow",
        Action: ["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress", "ec2:DeleteSecurityGroup"],
        Resource: "*",
        Condition: { Null: { "aws:ResourceTag/elbv2.k8s.aws/cluster": "false" } },
      },
      {
        Effect: "Allow",
        Action: ["elasticloadbalancing:CreateLoadBalancer", "elasticloadbalancing:CreateTargetGroup"],
        Resource: "*",
        Condition: { Null: { "aws:RequestTag/elbv2.k8s.aws/cluster": "false" } },
      },
      {
        Effect: "Allow",
        Action: ["elasticloadbalancing:CreateListener", "elasticloadbalancing:DeleteListener",
          "elasticloadbalancing:CreateRule", "elasticloadbalancing:DeleteRule"],
        Resource: "*",
      },
      {
        Effect: "Allow",
        Action: ["elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags"],
        Resource: [
          "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
          "arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*",
          "arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*",
        ],
        Condition: {
          Null: { "aws:RequestTag/elbv2.k8s.aws/cluster": "true", "aws:ResourceTag/elbv2.k8s.aws/cluster": "false" },
        },
      },
      {
        Effect: "Allow",
        Action: ["elasticloadbalancing:AddTags", "elasticloadbalancing:RemoveTags"],
        Resource: [
          "arn:aws:elasticloadbalancing:*:*:listener/net/*/*/*",
          "arn:aws:elasticloadbalancing:*:*:listener/app/*/*/*",
          "arn:aws:elasticloadbalancing:*:*:listener-rule/net/*/*/*",
          "arn:aws:elasticloadbalancing:*:*:listener-rule/app/*/*/*",
        ],
      },
      {
        Effect: "Allow",
        Action: [
          "elasticloadbalancing:ModifyLoadBalancerAttributes", "elasticloadbalancing:SetIpAddressType",
          "elasticloadbalancing:SetSecurityGroups", "elasticloadbalancing:SetSubnets",
          "elasticloadbalancing:DeleteLoadBalancer", "elasticloadbalancing:ModifyTargetGroup",
          "elasticloadbalancing:ModifyTargetGroupAttributes", "elasticloadbalancing:DeleteTargetGroup",
          "elasticloadbalancing:ModifyListenerAttributes", "elasticloadbalancing:ModifyCapacityReservation",
          "elasticloadbalancing:ModifyIpPools",
        ],
        Resource: "*",
        Condition: { Null: { "aws:ResourceTag/elbv2.k8s.aws/cluster": "false" } },
      },
      {
        Effect: "Allow",
        Action: ["elasticloadbalancing:AddTags"],
        Resource: [
          "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
          "arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*",
          "arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*",
        ],
        Condition: {
          StringEquals: { "elasticloadbalancing:CreateAction": ["CreateTargetGroup", "CreateLoadBalancer"] },
          Null: { "aws:RequestTag/elbv2.k8s.aws/cluster": "false" },
        },
      },
      {
        Effect: "Allow",
        Action: ["elasticloadbalancing:RegisterTargets", "elasticloadbalancing:DeregisterTargets"],
        Resource: "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
      },
      {
        Effect: "Allow",
        Action: [
          "elasticloadbalancing:SetWebAcl", "elasticloadbalancing:ModifyListener",
          "elasticloadbalancing:AddListenerCertificates", "elasticloadbalancing:RemoveListenerCertificates",
          "elasticloadbalancing:ModifyRule", "elasticloadbalancing:SetRulePriorities",
        ],
        Resource: "*",
      },
    ],
  },
});

// ALB controller role
export const albControllerRole = new Role({
  RoleName: "eks-microservice-alb-controller-role",
  AssumeRolePolicyDocument: irsaTrustPolicy("kube-system", "aws-load-balancer-controller"),
  ManagedPolicyArns: [albControllerPolicy.PolicyArn],
});

// ExternalDNS role
export const externalDnsRole = new Role({
  RoleName: "eks-microservice-external-dns-role",
  AssumeRolePolicyDocument: irsaTrustPolicy("kube-system", "external-dns-sa"),
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/AmazonRoute53FullAccess",
  ],
});

// FluentBit role
export const fluentBitRole = new Role({
  RoleName: "eks-microservice-fluent-bit-role",
  AssumeRolePolicyDocument: irsaTrustPolicy("amazon-cloudwatch", "fluent-bit-sa"),
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
  ],
});

// ADOT Collector role
export const adotRole = new Role({
  RoleName: "eks-microservice-adot-role",
  AssumeRolePolicyDocument: irsaTrustPolicy("amazon-metrics", "adot-collector-sa"),
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
    "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
  ],
});

// EBS CSI driver role — required for the EBS CSI addon to manage volumes
export const ebsCsiRole = new Role({
  RoleName: "eks-microservice-ebs-csi-role",
  AssumeRolePolicyDocument: irsaTrustPolicy("kube-system", "ebs-csi-controller-sa"),
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
  ],
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

export const adotRoleArn = stackOutput(adotRole.Arn, {
  description: "IAM role ARN for ADOT Collector (IRSA)",
});
