// AWS infrastructure: EKS add-ons for VPC CNI and EBS CSI driver.

import { Addon } from "@intentius/chant-lexicon-aws";
import { cluster, nodegroup, ebsCsiRole } from "./cluster";

// VPC CNI — pod networking
export const vpcCni = new Addon(
  {
    AddonName: "vpc-cni",
    ClusterName: "eks-microservice",
    ResolveConflicts: "OVERWRITE",
  },
  { DependsOn: [cluster, nodegroup] },
);

// EBS CSI driver — persistent volume support (requires IRSA role)
export const ebsCsi = new Addon(
  {
    AddonName: "aws-ebs-csi-driver",
    ClusterName: "eks-microservice",
    ResolveConflicts: "OVERWRITE",
    ServiceAccountRoleArn: ebsCsiRole.Arn,
  },
  { DependsOn: [cluster, nodegroup] },
);

// CoreDNS — cluster DNS
export const coreDns = new Addon(
  {
    AddonName: "coredns",
    ClusterName: "eks-microservice",
    ResolveConflicts: "OVERWRITE",
  },
  { DependsOn: [cluster, nodegroup] },
);

// kube-proxy
export const kubeProxy = new Addon(
  {
    AddonName: "kube-proxy",
    ClusterName: "eks-microservice",
    ResolveConflicts: "OVERWRITE",
  },
  { DependsOn: [cluster, nodegroup] },
);

// Note: ALB controller is not available as an EKS managed addon.
// Install it via Helm or include it in K8s manifests:
//   helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
//     --set clusterName=eks-microservice \
//     --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=$ALB_CONTROLLER_ROLE_ARN \
//     -n kube-system
