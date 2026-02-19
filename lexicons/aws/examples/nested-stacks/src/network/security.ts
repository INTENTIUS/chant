/**
 * Security group for the Lambda function in the parent stack
 */

import * as _ from "./_";
import { vpc } from "./vpc";

export const lambdaSg = new _.SecurityGroup({
  groupDescription: _.Sub`${_.AWS.StackName} Lambda security group`,
  vpcId: vpc.vpcId,
  securityGroupEgress: [{
    ipProtocol: "-1",
    cidrIp: "0.0.0.0/0",
    description: "Allow all outbound",
  }],
  tags: [{ key: "Name", value: _.Sub`${_.AWS.StackName}-lambda-sg` }],
});
