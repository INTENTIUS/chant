// AWS infrastructure: EKS add-ons for VPC CNI, EBS CSI, CoreDNS, kube-proxy.

import { Addon } from "@intentius/chant-lexicon-aws";
import { cluster, nodegroup, ebsCsiRole } from "./cluster";

export const vpcCni = new Addon(
  {
    AddonName: "vpc-cni",
    ClusterName: "eks-cockroachdb",
    ResolveConflicts: "OVERWRITE",
  },
  { DependsOn: [cluster, nodegroup] },
);

export const ebsCsi = new Addon(
  {
    AddonName: "aws-ebs-csi-driver",
    ClusterName: "eks-cockroachdb",
    ResolveConflicts: "OVERWRITE",
    ServiceAccountRoleArn: ebsCsiRole.Arn,
  },
  { DependsOn: [cluster, nodegroup] },
);

export const coreDns = new Addon(
  {
    AddonName: "coredns",
    ClusterName: "eks-cockroachdb",
    ResolveConflicts: "OVERWRITE",
  },
  { DependsOn: [cluster, nodegroup] },
);

export const kubeProxy = new Addon(
  {
    AddonName: "kube-proxy",
    ClusterName: "eks-cockroachdb",
    ResolveConflicts: "OVERWRITE",
  },
  { DependsOn: [cluster, nodegroup] },
);
