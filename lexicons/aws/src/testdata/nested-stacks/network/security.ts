/**
 * Security group for the Lambda function in the parent stack
 */

import { SecurityGroup, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { vpc } from "./vpc";

export const lambdaSg = new SecurityGroup({
  GroupDescription: Sub`${AWS.StackName} Lambda security group`,
  VpcId: vpc.VpcId,
  SecurityGroupEgress: [{
    IpProtocol: "-1",
    CidrIp: "0.0.0.0/0",
    Description: "Allow all outbound",
  }],
  Tags: [{ Key: "Name", Value: Sub`${AWS.StackName}-lambda-sg` }],
});
