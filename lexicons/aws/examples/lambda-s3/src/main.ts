import { LambdaS3, Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { environment } from "./params";

export const app = LambdaS3({
  name: Sub`${AWS.StackName}-${Ref(environment)}-fn`,
  bucketName: Sub`${AWS.StackName}-${Ref(environment)}-bucket`,
  Runtime: "nodejs20.x",
  Handler: "index.handler",
  Code: {
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
  },
  access: "ReadOnly",
});
