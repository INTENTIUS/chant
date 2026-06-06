// L1 — the synthesis core.
//
// Typed resources in, spec-native CloudFormation out. `chant build` imports
// this file, reads the objects it exports, and serializes them. It never calls
// AWS, reads state, or deploys. Same source always produces the same output.
import { LambdaS3, Sub, AWS, Ref } from "@intentius/chant-lexicon-aws";
import { environment } from "./params";

// A Lambda that lists objects in an S3 bucket.
//
// `LambdaS3` is a composite — one call that returns several wired resources
// (the function, its execution role, the bucket, the read policy). The returned
// `app` exposes them as `app.func`, `app.bucket`, etc. so other files can
// reference their attributes. `Sub` / `AWS.StackName` / `Ref` are intrinsics:
// placeholders the platform resolves at apply, not values read at build time.
export const app = LambdaS3({
  name: Sub`${AWS.StackName}-${Ref(environment)}-docs-fn`,
  bucketName: Sub`${AWS.StackName}-${Ref(environment)}-docs`,
  Runtime: "nodejs20.x",
  Handler: "index.handler",
  Code: {
    ZipFile: `const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const s3 = new S3Client();

exports.handler = async () => {
  const out = await s3.send(
    new ListObjectsV2Command({ Bucket: process.env.BUCKET_NAME })
  );
  return { statusCode: 200, body: JSON.stringify(out.Contents ?? []) };
};`,
  },
  access: "ReadOnly",
});
