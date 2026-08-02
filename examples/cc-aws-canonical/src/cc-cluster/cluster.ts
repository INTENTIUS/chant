/**
 * The CC lane's canonical example, cluster half (chant#1198 / #1208).
 *
 * The managed cluster the k8s workload runs on. Floci k3s-backs EKS, so this is
 * a real cluster with a real apiserver — on a port the emulator allocates at
 * creation, which is why nothing may hardcode it (behold#106).
 *
 * Declared with no subnets on purpose: the emulator does not place a k3s
 * container in a VPC, and pinning the network half's subnets here would assert
 * a relationship the round-trip cannot demonstrate.
 */
import { EKSCluster } from "@intentius/chant-lexicon-aws";

export const cluster = new EKSCluster({
  Name: "cc-eks",
  RoleArn: "arn:aws:iam::000000000000:role/eks",
  ResourcesVpcConfig: { SubnetIds: [] },
});
