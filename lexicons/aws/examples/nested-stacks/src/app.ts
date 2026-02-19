/**
 * App layer — Lambda function in the parent template that references
 * the network nested stack's outputs via cross-stack references
 */

import * as _ from "./_";

// nestedStack() references a child project directory
const network = _.nestedStack("network", import.meta.dir + "/network", {
  parameters: { Environment: "prod" },
});

export const handler = new _.Function({
  functionName: _.Sub`${_.AWS.StackName}-handler`,
  runtime: "nodejs20.x",
  handler: "index.handler",
  role: _.Ref("LambdaExecutionRole"),
  code: { zipFile: "exports.handler = async () => ({ statusCode: 200 });" },
  vpcConfig: {
    subnetIds: [network.outputs.subnetId],
    securityGroupIds: [network.outputs.lambdaSgId],
  },
});

// Re-export so discovery picks it up as an entity
export { network };
