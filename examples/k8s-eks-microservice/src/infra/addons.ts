// AWS infrastructure: EKS add-ons for VPC CNI and EBS CSI driver.

import { Addon } from "@intentius/chant-lexicon-aws";
import { albControllerRole } from "./cluster";

// VPC CNI — pod networking
export const vpcCni = new Addon({
  AddonName: "vpc-cni",
  ClusterName: "eks-microservice",
  ResolveConflicts: "OVERWRITE",
});

// EBS CSI driver — persistent volume support
export const ebsCsi = new Addon({
  AddonName: "aws-ebs-csi-driver",
  ClusterName: "eks-microservice",
  ResolveConflicts: "OVERWRITE",
});

// CoreDNS — cluster DNS
export const coreDns = new Addon({
  AddonName: "coredns",
  ClusterName: "eks-microservice",
  ResolveConflicts: "OVERWRITE",
});

// kube-proxy
export const kubeProxy = new Addon({
  AddonName: "kube-proxy",
  ClusterName: "eks-microservice",
  ResolveConflicts: "OVERWRITE",
});

// ALB controller — manages ALB Ingress resources
export const albController = new Addon({
  AddonName: "aws-load-balancer-controller",
  ClusterName: "eks-microservice",
  ServiceAccountRoleArn: albControllerRole.Arn,
  ResolveConflicts: "OVERWRITE",
});
