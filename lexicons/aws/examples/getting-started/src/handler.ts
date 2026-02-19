import * as _ from "./_";

export const lambdaCode = {
  zipFile: "exports.handler = async () => ({ statusCode: 200 });",
};

export const lambdaEnv = {
  variables: {
    BUCKET_ARN: _.$.dataBucket.arn,
  },
};

export const handler = new _.Function({
  functionName: _.Sub`${_.AWS.StackName}-handler`,
  handler: "index.handler",
  runtime: "nodejs20.x",
  role: _.$.functionRole.arn,
  code: lambdaCode,
  environment: lambdaEnv,
});
