/**
 * Cross-stack outputs — values the parent can reference
 */

import { stackOutput } from "@intentius/chant";
import { vpc, subnet } from "./vpc";
import { lambdaSg } from "./security";

export const vpcId = stackOutput(vpc.VpcId, {
  description: "VPC ID",
});
export const subnetId = stackOutput(subnet.SubnetId, {
  description: "Public subnet ID",
});
export const lambdaSgId = stackOutput(lambdaSg.GroupId, {
  description: "Lambda security group ID",
});
