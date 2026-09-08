// CloudFormation outputs for the EKS stack.
//
// They live in their own file because a stack output reads an attribute off a
// resource declared elsewhere: `scripts/load-outputs.sh` turns each of these
// into an entry in `.env`, which the K8s half of the build reads as a
// parameter.

import { stackOutput } from "@intentius/chant-lexicon-aws";
import { cluster } from "./cluster";
import { hostedZone } from "./dns";
import { network } from "./networking";
import {
  adotRole,
  albControllerRole,
  appRole,
  externalDnsRole,
  fluentBitRole,
} from "./irsa";

// ── Network ────────────────────────────────────────────────────────

export const vpcId = stackOutput(network.vpc.VpcId, {
  description: "VPC ID for EKS cluster",
});

export const publicSubnet1Id = stackOutput(network.publicSubnet1.SubnetId, {
  description: "Public subnet 1 for ALB",
});

export const publicSubnet2Id = stackOutput(network.publicSubnet2.SubnetId, {
  description: "Public subnet 2 for ALB",
});

export const privateSubnet1Id = stackOutput(network.privateSubnet1.SubnetId, {
  description: "Private subnet 1 for EKS nodes",
});

export const privateSubnet2Id = stackOutput(network.privateSubnet2.SubnetId, {
  description: "Private subnet 2 for EKS nodes",
});

// ── Cluster ────────────────────────────────────────────────────────

export const clusterEndpoint = stackOutput(cluster.Endpoint, {
  description: "EKS cluster API endpoint",
});

export const clusterArnOutput = stackOutput(cluster.Arn, {
  description: "EKS cluster ARN",
});

// ── IRSA role ARNs ─────────────────────────────────────────────────

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

// ── DNS ────────────────────────────────────────────────────────────

export const hostedZoneIdOutput = stackOutput(hostedZone.Id, {
  description: "Route53 hosted zone ID",
});
