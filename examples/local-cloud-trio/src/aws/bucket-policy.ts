import { S3BucketPolicy, Ref, Sub } from "@intentius/chant-lexicon-aws";
import { bucket } from "./infra";

// Deny every request that arrives over plaintext (WAW042).
export const denyInsecureTransport = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "DenyInsecureTransport",
      Effect: "Deny",
      Principal: "*",
      Action: "s3:*",
      Resource: [bucket.Arn, Sub`${bucket.Arn}/*`],
      Condition: { Bool: { "aws:SecureTransport": "false" } },
    },
  ],
};

// CloudFormation models a bucket policy as its own resource, so it is one here too.
export const bucketPolicy = new S3BucketPolicy({
  Bucket: Ref(bucket),
  PolicyDocument: denyInsecureTransport,
});
