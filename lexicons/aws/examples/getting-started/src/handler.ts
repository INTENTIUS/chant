/**
 * Lambda handler — lists objects in the data bucket using the AWS SDK v3.
 *
 * Receives the bucket name via BUCKET_NAME env var and returns the object
 * list as JSON. Runs on Node.js 20.x with the execution role from role.ts.
 */
import { Function, Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { dataBucket } from "./data-bucket";
import { functionRole } from "./role";

export const lambdaCode = {
  ZipFile: `const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const s3 = new S3Client();

exports.handler = async () => {
  const result = await s3.send(
    new ListObjectsV2Command({ Bucket: process.env.BUCKET_NAME })
  );
  return {
    statusCode: 200,
    body: JSON.stringify(result.Contents ?? []),
  };
};`,
};

export const lambdaEnv = {
  Variables: {
    BUCKET_NAME: dataBucket.Ref,
  },
};

export const handler = new Function({
  // chant-disable-next-line COR003
  FunctionName: Sub`${AWS.AccountId}-${Ref("name")}-chant-handler`,
  Handler: "index.handler",
  Runtime: "nodejs20.x",
  Role: functionRole.Arn,
  Code: lambdaCode,
  Environment: lambdaEnv,
});
