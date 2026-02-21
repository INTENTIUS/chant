import { Function, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { dataBucket } from "./data-bucket";
import { functionRole } from "./role";

export const lambdaCode = {
  ZipFile: "exports.handler = async () => ({ statusCode: 200 });",
};

export const lambdaEnv = {
  Variables: {
    BUCKET_ARN: dataBucket.Arn,
  },
};

export const handler = new Function({
  FunctionName: Sub`${AWS.StackName}-handler`,
  Handler: "index.handler",
  Runtime: "nodejs20.x",
  Role: functionRole.Arn,
  Code: lambdaCode,
  Environment: lambdaEnv,
});
