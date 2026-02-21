/**
 * App layer — Lambda function in the parent template that references
 * the network nested stack's outputs via cross-stack references
 */

import { Function, Sub, AWS, Ref, nestedStack } from "@intentius/chant-lexicon-aws";

// nestedStack() references a child project directory
const network = nestedStack("network", import.meta.dirname + "/network", {
  parameters: { Environment: "prod" },
});

export const handler = new Function({
  FunctionName: Sub`${AWS.StackName}-handler`,
  Runtime: "nodejs20.x",
  Handler: "index.handler",
  Role: Ref("LambdaExecutionRole"),
  Code: { ZipFile: "exports.handler = async () => ({ statusCode: 200 });" },
  VpcConfig: {
    SubnetIds: [network.outputs.subnetId],
    SecurityGroupIds: [network.outputs.lambdaSgId],
  },
});

// Re-export so discovery picks it up as an entity
export { network };
