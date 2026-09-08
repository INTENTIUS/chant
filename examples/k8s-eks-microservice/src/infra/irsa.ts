// chant-disable WAW009 -- ALB controller policy uses wildcards per official AWS recommendation
// AWS infrastructure: the IAM roles a pod assumes through IRSA.
//
// Each role trusts one Kubernetes service account through the cluster's OIDC
// provider. CloudFormation can only substitute into a string, and the two
// condition keys carry the issuer host, so the trust policy is one `Fn::Sub`
// over the whole document rather than over a single value. The document is
// written out as string literals so the file stays statically evaluable.

import {
  ManagedPolicy,
  Role,
  Select,
  Split,
} from "@intentius/chant-lexicon-aws";
import { oidcProvider } from "./cluster";

// ── IRSA trust policy ──────────────────────────────────────────────

/** OIDC issuer ID extracted from provider ARN (for condition keys) */
const oidcIssuer = Select(1, Split("oidc-provider/", oidcProvider.Arn));

const trustPolicyHead =
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow",' +
  '"Principal":{"Federated":"${OidcArn}"},' +
  '"Action":"sts:AssumeRoleWithWebIdentity","Condition":{"StringEquals":{' +
  '"${OidcIssuer}:sub":"system:serviceaccount:';

const trustPolicyTail = '","${OidcIssuer}:aud":"sts.amazonaws.com"}}}]}';

/** The two names `${OidcArn}` and `${OidcIssuer}` resolve to at deploy time. */
const oidcSubstitutions = {
  OidcArn: oidcProvider.Arn,
  OidcIssuer: oidcIssuer,
};

// One trust policy per service account: "<namespace>:<service account>".
const appTrustPolicy = {
  "Fn::Sub": [
    trustPolicyHead + "microservice:microservice-app-sa" + trustPolicyTail,
    oidcSubstitutions,
  ],
};

const albControllerTrustPolicy = {
  "Fn::Sub": [
    trustPolicyHead + "kube-system:aws-load-balancer-controller" + trustPolicyTail,
    oidcSubstitutions,
  ],
};

const externalDnsTrustPolicy = {
  "Fn::Sub": [
    trustPolicyHead + "kube-system:external-dns-sa" + trustPolicyTail,
    oidcSubstitutions,
  ],
};

const fluentBitTrustPolicy = {
  "Fn::Sub": [
    trustPolicyHead + "amazon-cloudwatch:fluent-bit-sa" + trustPolicyTail,
    oidcSubstitutions,
  ],
};

const adotTrustPolicy = {
  "Fn::Sub": [
    trustPolicyHead + "amazon-metrics:adot-collector-sa" + trustPolicyTail,
    oidcSubstitutions,
  ],
};

const ebsCsiTrustPolicy = {
  "Fn::Sub": [
    trustPolicyHead + "kube-system:ebs-csi-controller-sa" + trustPolicyTail,
    oidcSubstitutions,
  ],
};

// ── IRSA roles ─────────────────────────────────────────────────────

// App role — grants S3 read access to the microservice
export const appRole = new Role({
  RoleName: "eks-microservice-app-role",
  AssumeRolePolicyDocument: appTrustPolicy,
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
  AssumeRolePolicyDocument: albControllerTrustPolicy,
  ManagedPolicyArns: [albControllerPolicy.PolicyArn],
});

// ExternalDNS role
export const externalDnsRole = new Role({
  RoleName: "eks-microservice-external-dns-role",
  AssumeRolePolicyDocument: externalDnsTrustPolicy,
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/AmazonRoute53FullAccess",
  ],
});

// FluentBit role
export const fluentBitRole = new Role({
  RoleName: "eks-microservice-fluent-bit-role",
  AssumeRolePolicyDocument: fluentBitTrustPolicy,
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
  ],
});

// ADOT Collector role
export const adotRole = new Role({
  RoleName: "eks-microservice-adot-role",
  AssumeRolePolicyDocument: adotTrustPolicy,
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
    "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess",
  ],
});

// EBS CSI driver role — required for the EBS CSI addon to manage volumes
export const ebsCsiRole = new Role({
  RoleName: "eks-microservice-ebs-csi-role",
  AssumeRolePolicyDocument: ebsCsiTrustPolicy,
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
  ],
});
