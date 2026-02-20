/**
 * Security group for the Lambda function in the parent stack
 */

import { SecurityGroup, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { vpc } from "./vpc";

export const lambdaSg = new SecurityGroup({
  groupDescription: Sub`${AWS.StackName} Lambda security group`,
  vpcId: vpc.vpcId,
  securityGroupEgress: [{
    ipProtocol: "-1",
    cidrIp: "0.0.0.0/0",
    description: "Allow all outbound",
  }],
  tags: [{ key: "Name", value: Sub`${AWS.StackName}-lambda-sg` }],
});
