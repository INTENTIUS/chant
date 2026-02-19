/**
 * Cross-stack outputs — values the parent can reference
 */

import * as _ from "./_";
import { stackOutput } from "@intentius/chant";

export const vpcId = stackOutput(_.$.vpc.vpcId, {
  description: "VPC ID",
});
export const subnetId = stackOutput(_.$.subnet.subnetId, {
  description: "Public subnet ID",
});
export const lambdaSgId = stackOutput(_.$.lambdaSg.groupId, {
  description: "Lambda security group ID",
});
