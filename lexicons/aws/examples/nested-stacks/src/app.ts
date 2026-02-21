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
  functionName: Sub`${AWS.StackName}-handler`,
  runtime: "nodejs20.x",
  handler: "index.handler",
  role: Ref("LambdaExecutionRole"),
  code: { zipFile: "exports.handler = async () => ({ statusCode: 200 });" },
  vpcConfig: {
    subnetIds: [network.outputs.subnetId],
    securityGroupIds: [network.outputs.lambdaSgId],
  },
});

// Re-export so discovery picks it up as an entity
export { network };
