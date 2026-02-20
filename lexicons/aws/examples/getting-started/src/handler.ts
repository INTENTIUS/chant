import { Function, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { dataBucket } from "./data-bucket";
import { functionRole } from "./role";

export const lambdaCode = {
  zipFile: "exports.handler = async () => ({ statusCode: 200 });",
};

export const lambdaEnv = {
  variables: {
    BUCKET_ARN: dataBucket.arn,
  },
};

export const handler = new Function({
  functionName: Sub`${AWS.StackName}-handler`,
  handler: "index.handler",
  runtime: "nodejs20.x",
  role: functionRole.arn,
  code: lambdaCode,
  environment: lambdaEnv,
});
