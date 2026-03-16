import { VPC, Tag } from "@intentius/chant-lexicon-aws";
export const vpc = new VPC({
  CidrBlock: "10.0.0.0/16",
  EnableDnsSupport: true,
  EnableDnsHostnames: true,
  Tags: [new Tag({ Key: "Name", Value: "multi-stack-vpc" })],
});
